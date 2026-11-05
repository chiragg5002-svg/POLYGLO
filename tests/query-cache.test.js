const mockCreateClient = jest.fn();

jest.mock('redis', () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

function asyncIterableFromArray(items) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          return i < items.length
            ? Promise.resolve({ value: items[i++], done: false })
            : Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function makeFakeRedisClient(overrides = {}) {
  return {
    isReady: true,
    connect: jest.fn().mockResolvedValue(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    scanIterator: jest.fn(() => asyncIterableFromArray([])),
    ...overrides,
  };
}

let queryCache;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.REDIS_URL = 'redis://localhost:6379';
  delete process.env.QUERY_CACHE_ENABLED;
  delete process.env.QUERY_CACHE_TTL_SECONDS;
  mockCreateClient.mockReset();
  // Fresh require each test so the module-level singleton client
  // (and its "already warned about an outage" flag) never leaks
  // between tests.
  queryCache = require('../query-cache');
});

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------
describe('cache configuration', () => {
  test('is disabled when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    expect(queryCache.isCachingEnabled()).toBe(false);
  });

  test('is enabled by default when REDIS_URL is set', () => {
    expect(queryCache.isCachingEnabled()).toBe(true);
  });

  test('QUERY_CACHE_ENABLED=false disables caching even with REDIS_URL set', () => {
    process.env.QUERY_CACHE_ENABLED = 'false';
    expect(queryCache.isCachingEnabled()).toBe(false);
  });

  test('defaults the TTL to 60 seconds', () => {
    expect(queryCache.getTtlSeconds()).toBe(60);
  });

  test('honors a configured QUERY_CACHE_TTL_SECONDS', () => {
    process.env.QUERY_CACHE_TTL_SECONDS = '300';
    expect(queryCache.getTtlSeconds()).toBe(300);
  });

  test('falls back to the default TTL for an invalid value', () => {
    process.env.QUERY_CACHE_TTL_SECONDS = 'not-a-number';
    expect(queryCache.getTtlSeconds()).toBe(60);
  });
});

// ------------------------------------------------------------
// Stable cache key (requirement 2)
// ------------------------------------------------------------
describe('buildCacheKey', () => {
  test('is stable regardless of filter/field ordering', () => {
    const keyA = queryCache.buildCacheKey({
      dataset: 'Orders.csv',
      queryType: 'select',
      conditions: [
        { field: 'age', operator: 'gte', value: 20 },
        { field: 'status', operator: 'eq', value: 'active' },
      ],
      sort: { field: 'age', direction: 'desc' },
      limit: 25,
    });
    const keyB = queryCache.buildCacheKey({
      dataset: 'orders.csv',
      queryType: 'select',
      conditions: [
        { field: 'status', operator: 'eq', value: 'active' },
        { field: 'age', operator: 'gte', value: 20 },
      ],
      sort: { field: 'age', direction: 'desc' },
      limit: 25,
    });
    expect(keyA).toBe(keyB);
  });

  test('changes when the dataset, query type, filters, sort, or limit differ', () => {
    const base = { dataset: 'orders', queryType: 'select', conditions: [], sort: null, limit: 10 };
    const baseKey = queryCache.buildCacheKey(base);

    expect(queryCache.buildCacheKey({ ...base, dataset: 'customers' })).not.toBe(baseKey);
    expect(queryCache.buildCacheKey({ ...base, queryType: 'count' })).not.toBe(baseKey);
    expect(queryCache.buildCacheKey({ ...base, limit: 20 })).not.toBe(baseKey);
    expect(queryCache.buildCacheKey({ ...base, sort: { field: 'id', direction: 'asc' } })).not.toBe(baseKey);
    expect(
      queryCache.buildCacheKey({ ...base, conditions: [{ field: 'status', operator: 'eq', value: 'active' }] }),
    ).not.toBe(baseKey);
  });

  test('namespaces the key under the dataset name for invalidation', () => {
    const key = queryCache.buildCacheKey({ dataset: 'Orders.csv', queryType: 'select', conditions: [], sort: null, limit: 10 });
    expect(key.startsWith('maestro:query:orders.csv:')).toBe(true);
  });
});

// ------------------------------------------------------------
// Redaction (requirement 7)
// ------------------------------------------------------------
describe('sanitizeForCache', () => {
  test('redacts keys that look like secrets at any nesting depth', () => {
    const input = {
      results: [{ id: 1, password: 'hunter2', nested: { apiKey: 'abc', token: 'xyz', safe: 'ok' } }],
      connectionString: 'postgres://user:pass@host/db',
      note: 'fine',
    };
    const sanitized = queryCache.sanitizeForCache(input);
    expect(sanitized.results[0].password).toBe('[REDACTED]');
    expect(sanitized.results[0].nested.apiKey).toBe('[REDACTED]');
    expect(sanitized.results[0].nested.token).toBe('[REDACTED]');
    expect(sanitized.connectionString).toBe('[REDACTED]');
    expect(sanitized.results[0].id).toBe(1);
    expect(sanitized.results[0].nested.safe).toBe('ok');
    expect(sanitized.note).toBe('fine');
  });
});

// ------------------------------------------------------------
// Cache miss / hit / expiry
// ------------------------------------------------------------
describe('getCachedQueryResult', () => {
  test('cache miss: returns null and reflects nothing was cached yet', async () => {
    const fakeClient = makeFakeRedisClient({ get: jest.fn().mockResolvedValue(null) });
    mockCreateClient.mockReturnValue(fakeClient);

    const result = await queryCache.getCachedQueryResult('maestro:query:orders:abc');

    expect(result).toBeNull();
    expect(fakeClient.get).toHaveBeenCalledWith('maestro:query:orders:abc');
  });

  test('cache hit: returns the previously stored value', async () => {
    const stored = { status: 'success', results: [{ id: 1 }], resultCount: 1 };
    const fakeClient = makeFakeRedisClient({ get: jest.fn().mockResolvedValue(JSON.stringify(stored)) });
    mockCreateClient.mockReturnValue(fakeClient);

    const result = await queryCache.getCachedQueryResult('maestro:query:orders:abc');

    expect(result).toEqual(stored);
  });

  test('expired cache: behaves exactly like a miss once Redis has evicted the key', async () => {
    let call = 0;
    const fakeClient = makeFakeRedisClient({
      get: jest.fn().mockImplementation(() => {
        call += 1;
        // First call: still within TTL. Second call: Redis expired
        // and evicted the key on its own (this is exactly what a
        // real EX-based expiry looks like from the client's side).
        return Promise.resolve(call === 1 ? JSON.stringify({ resultCount: 1 }) : null);
      }),
    });
    mockCreateClient.mockReturnValue(fakeClient);

    const first = await queryCache.getCachedQueryResult('maestro:query:orders:abc');
    const second = await queryCache.getCachedQueryResult('maestro:query:orders:abc');

    expect(first).toEqual({ resultCount: 1 });
    expect(second).toBeNull();
  });

  test('redis unavailable (connect fails): returns null instead of throwing', async () => {
    const fakeClient = makeFakeRedisClient({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    mockCreateClient.mockReturnValue(fakeClient);

    await expect(queryCache.getCachedQueryResult('maestro:query:orders:abc')).resolves.toBeNull();
  });

  test('redis unavailable (get throws after connecting): returns null instead of throwing', async () => {
    const fakeClient = makeFakeRedisClient({ get: jest.fn().mockRejectedValue(new Error('connection lost')) });
    mockCreateClient.mockReturnValue(fakeClient);

    await expect(queryCache.getCachedQueryResult('maestro:query:orders:abc')).resolves.toBeNull();
  });

  test('caching disabled entirely: never calls createClient at all', async () => {
    process.env.QUERY_CACHE_ENABLED = 'false';
    const result = await queryCache.getCachedQueryResult('maestro:query:orders:abc');
    expect(result).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// Configurable TTL on write (requirement 3)
// ------------------------------------------------------------
describe('setCachedQueryResult', () => {
  test('stores the sanitized value with the configured TTL', async () => {
    process.env.QUERY_CACHE_TTL_SECONDS = '120';
    const fakeClient = makeFakeRedisClient();
    mockCreateClient.mockReturnValue(fakeClient);

    const value = { status: 'success', results: [{ id: 1, password: 'secret' }] };
    const stored = await queryCache.setCachedQueryResult('maestro:query:orders:abc', value);

    expect(stored).toBe(true);
    expect(fakeClient.set).toHaveBeenCalledTimes(1);
    const [key, payload, options] = fakeClient.set.mock.calls[0];
    expect(key).toBe('maestro:query:orders:abc');
    expect(options).toEqual({ EX: 120 });
    expect(JSON.parse(payload).results[0].password).toBe('[REDACTED]');
  });

  test('accepts an explicit TTL override', async () => {
    const fakeClient = makeFakeRedisClient();
    mockCreateClient.mockReturnValue(fakeClient);

    await queryCache.setCachedQueryResult('k', { a: 1 }, 5);

    expect(fakeClient.set.mock.calls[0][2]).toEqual({ EX: 5 });
  });

  test('redis unavailable: returns false instead of throwing, and never breaks the caller', async () => {
    const fakeClient = makeFakeRedisClient({ set: jest.fn().mockRejectedValue(new Error('write failed')) });
    mockCreateClient.mockReturnValue(fakeClient);

    await expect(queryCache.setCachedQueryResult('k', { a: 1 })).resolves.toBe(false);
  });
});

// ------------------------------------------------------------
// Invalidation (requirement 5)
// ------------------------------------------------------------
describe('invalidateDataset', () => {
  test('deletes every key scanned under the dataset prefix and reports the count', async () => {
    const keys = ['maestro:query:orders:aaa', 'maestro:query:orders:bbb'];
    const fakeClient = makeFakeRedisClient({ scanIterator: jest.fn(() => asyncIterableFromArray(keys)) });
    mockCreateClient.mockReturnValue(fakeClient);

    const removed = await queryCache.invalidateDataset('Orders.csv');

    expect(removed).toBe(2);
    expect(fakeClient.scanIterator).toHaveBeenCalledWith(
      expect.objectContaining({ MATCH: 'maestro:query:orders.csv:*' }),
    );
    expect(fakeClient.del).toHaveBeenCalledTimes(2);
    expect(fakeClient.del).toHaveBeenCalledWith('maestro:query:orders:aaa');
    expect(fakeClient.del).toHaveBeenCalledWith('maestro:query:orders:bbb');
  });

  test('returns 0 and never throws when nothing is cached for the dataset', async () => {
    const fakeClient = makeFakeRedisClient({ scanIterator: jest.fn(() => asyncIterableFromArray([])) });
    mockCreateClient.mockReturnValue(fakeClient);

    await expect(queryCache.invalidateDataset('orders.csv')).resolves.toBe(0);
  });

  test('redis unavailable: returns 0 instead of throwing (an import must still succeed)', async () => {
    const fakeClient = makeFakeRedisClient({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    mockCreateClient.mockReturnValue(fakeClient);

    await expect(queryCache.invalidateDataset('orders.csv')).resolves.toBe(0);
  });

  test('a scanIterator/del failure mid-invalidation is swallowed, not thrown', async () => {
    const fakeClient = makeFakeRedisClient({
      scanIterator: jest.fn(() => asyncIterableFromArray(['maestro:query:orders:aaa'])),
      del: jest.fn().mockRejectedValue(new Error('del failed')),
    });
    mockCreateClient.mockReturnValue(fakeClient);

    await expect(queryCache.invalidateDataset('orders.csv')).resolves.toBe(0);
  });

  test('does nothing for an empty dataset name', async () => {
    const removed = await queryCache.invalidateDataset('');
    expect(removed).toBe(0);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
