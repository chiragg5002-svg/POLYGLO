// Mocks must be declared before requiring query-engine, since it
// wires up pg/mongodb/@elastic/elasticsearch clients at call time,
// and reads dataset locations through database-service's getMetadata.
const mockPgQuery = jest.fn();
const mockPgConnect = jest.fn();
const mockPgEnd = jest.fn();

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockPgConnect,
    query: mockPgQuery,
    end: mockPgEnd,
  })),
}));

const mockMongoFind = jest.fn();
const mockMongoCountDocuments = jest.fn();
const mockMongoConnect = jest.fn();
const mockMongoClose = jest.fn();

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockMongoConnect,
    close: mockMongoClose,
    db: jest.fn(() => ({
      collection: jest.fn(() => ({
        find: mockMongoFind,
        countDocuments: mockMongoCountDocuments,
      })),
    })),
  })),
}));

const mockEsSearch = jest.fn();
const mockEsCount = jest.fn();

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    search: mockEsSearch,
    count: mockEsCount,
  })),
}));

const mockGetMetadata = jest.fn();

jest.mock('../database-service', () => {
  const actual = jest.requireActual('../database-service');
  return {
    getMetadata: mockGetMetadata,
    sanitizeIdentifier: actual.sanitizeIdentifier,
  };
});

// Caching is exercised in its own dedicated suite
// (tests/query-cache.test.js) — here it's neutralized to a permanent
// miss so every test exercises the real database path deterministically,
// without needing a real (or mocked) Redis connection.
jest.mock('../query-cache', () => ({
  buildCacheKey: jest.fn(() => 'test-cache-key'),
  getCachedQueryResult: jest.fn().mockResolvedValue(null),
  setCachedQueryResult: jest.fn().mockResolvedValue(false),
}));

const {
  validateQueryRequest,
  normalizeFilterConditions,
  resolveDatasetLocation,
  buildPostgresQuery,
  buildMongoFilter,
  buildMongoSearchFilter,
  buildElasticsearchQuery,
  executeQuery,
  QueryValidationError,
} = require('../query-engine');

beforeEach(() => {
  jest.clearAllMocks();
  mockPgConnect.mockResolvedValue();
  mockPgEnd.mockResolvedValue();
  mockMongoConnect.mockResolvedValue();
  mockMongoClose.mockResolvedValue();
});

// ------------------------------------------------------------
// validateQueryRequest
// ------------------------------------------------------------
describe('validateQueryRequest', () => {
  test('requires a dataset name', () => {
    expect(() => validateQueryRequest({ queryType: 'select' })).toThrow(QueryValidationError);
  });

  test('rejects an invalid queryType', () => {
    expect(() => validateQueryRequest({ dataset: 'orders', queryType: 'delete' })).toThrow(/Invalid "queryType"/);
  });

  test('rejects an invalid targetDatabase', () => {
    expect(() =>
      validateQueryRequest({ dataset: 'orders', queryType: 'select', targetDatabase: 'redis' }),
    ).toThrow(/Invalid "targetDatabase"/);
  });

  test('rejects non-object conditions', () => {
    expect(() =>
      validateQueryRequest({ dataset: 'orders', queryType: 'select', conditions: 'age > 30' }),
    ).toThrow(/"conditions" must be an object/);
  });

  test('search requires conditions.text', () => {
    expect(() => validateQueryRequest({ dataset: 'orders', queryType: 'search', conditions: {} })).toThrow(
      /conditions.text/,
    );
  });

  test('rejects an invalid operator', () => {
    expect(() =>
      validateQueryRequest({ dataset: 'orders', queryType: 'select', conditions: { age: { between: 30 } } }),
    ).toThrow(/Invalid operator/);
  });

  test('"in" operator requires an array', () => {
    expect(() =>
      validateQueryRequest({ dataset: 'orders', queryType: 'select', conditions: { status: { in: 'active' } } }),
    ).toThrow(/requires an array/);
  });

  test('rejects an invalid sort direction', () => {
    expect(() =>
      validateQueryRequest({ dataset: 'orders', queryType: 'select', sort: { field: 'age', direction: 'up' } }),
    ).toThrow(/Invalid sort direction/);
  });

  test('rejects a non-positive limit', () => {
    expect(() => validateQueryRequest({ dataset: 'orders', queryType: 'select', limit: 0 })).toThrow(
      /positive integer/,
    );
  });

  test('rejects a limit above the max', () => {
    expect(() => validateQueryRequest({ dataset: 'orders', queryType: 'select', limit: 100000 })).toThrow(
      /cannot exceed/,
    );
  });

  test('applies defaults for a minimal valid select request', () => {
    const result = validateQueryRequest({ dataset: 'orders', queryType: 'select' });
    expect(result).toEqual({
      dataset: 'orders',
      queryType: 'select',
      conditions: [],
      sort: null,
      limit: 50,
      targetDatabase: null,
    });
  });
});

// ------------------------------------------------------------
// normalizeFilterConditions
// ------------------------------------------------------------
describe('normalizeFilterConditions', () => {
  test('treats a bare value as an eq clause', () => {
    expect(normalizeFilterConditions({ status: 'active' })).toEqual([
      { field: 'status', operator: 'eq', value: 'active' },
    ]);
  });

  test('expands a range into multiple clauses on the same field', () => {
    const clauses = normalizeFilterConditions({ age: { gte: 20, lte: 40 } });
    expect(clauses).toHaveLength(2);
    expect(clauses).toEqual(
      expect.arrayContaining([
        { field: 'age', operator: 'gte', value: 20 },
        { field: 'age', operator: 'lte', value: 40 },
      ]),
    );
  });
});

// ------------------------------------------------------------
// resolveDatasetLocation
// ------------------------------------------------------------
describe('resolveDatasetLocation', () => {
  test('throws when the dataset is not found anywhere', async () => {
    mockGetMetadata.mockResolvedValue({ imports: [], partitions: [] });
    await expect(resolveDatasetLocation('unknown', null)).rejects.toThrow(/was not found/);
  });

  test('resolves a dataset that lives in exactly one database', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        {
          dataset: 'orders.csv',
          dbType: 'postgres',
          dbName: 'shop',
          collectionName: 'orders',
          schema: [{ original: 'id', safe: 'id', pgType: 'BIGINT' }],
          status: 'imported',
          importedAt: '2026-01-01T00:00:00Z',
        },
      ],
      partitions: [],
    });

    const location = await resolveDatasetLocation('orders.csv', null);
    expect(location.dbType).toBe('postgres');
    expect(location.collectionName).toBe('orders');
  });

  test('is case-insensitive on dataset name', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        { dataset: 'Orders.csv', dbType: 'postgres', dbName: 'shop', collectionName: 'orders', status: 'imported', importedAt: '2026-01-01' },
      ],
      partitions: [],
    });
    const location = await resolveDatasetLocation('orders.csv', null);
    expect(location.dbType).toBe('postgres');
  });

  test('throws an ambiguous-target error when a dataset spans multiple databases and none was requested', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        { dataset: 'events', dbType: 'postgres', dbName: 'a', collectionName: 't', status: 'imported', importedAt: '2026-01-01' },
        { dataset: 'events', dbType: 'mongodb', dbName: 'a', collectionName: 't', status: 'imported', importedAt: '2026-01-02' },
      ],
      partitions: [],
    });

    await expect(resolveDatasetLocation('events', null)).rejects.toThrow(/Cross-database joins are not supported/);
  });

  test('honors an explicit targetDatabase even when the dataset spans multiple databases', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        { dataset: 'events', dbType: 'postgres', dbName: 'a', collectionName: 't1', status: 'imported', importedAt: '2026-01-01' },
        { dataset: 'events', dbType: 'mongodb', dbName: 'a', collectionName: 't2', status: 'imported', importedAt: '2026-01-02' },
      ],
      partitions: [],
    });

    const location = await resolveDatasetLocation('events', 'mongodb');
    expect(location.dbType).toBe('mongodb');
    expect(location.collectionName).toBe('t2');
  });

  test('rejects a targetDatabase the dataset was never imported into', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [{ dataset: 'events', dbType: 'postgres', dbName: 'a', collectionName: 't', status: 'imported', importedAt: '2026-01-01' }],
      partitions: [],
    });
    await expect(resolveDatasetLocation('events', 'elasticsearch')).rejects.toThrow(/has no data in "elasticsearch"/);
  });

  test('rejects a dataset that only exists as a local placeholder', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [{ dataset: 'notes', dbType: 'local', dbName: 'local', collectionName: 't', status: 'local', importedAt: '2026-01-01' }],
      partitions: [],
    });
    await expect(resolveDatasetLocation('notes', null)).rejects.toThrow(/only stored locally/);
  });

  test('picks up a location from a partitioned import record', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [],
      partitions: [
        {
          dataset: 'mixed.json',
          createdAt: '2026-02-01T00:00:00Z',
          partitions: [
            { target: 'postgres', dbName: 'a', collectionName: 'mixed_relational', status: 'imported', schema: [{ original: 'id', safe: 'id', pgType: 'BIGINT' }] },
            { target: 'mongodb', dbName: 'a', collectionName: 'mixed_docs', status: 'error' },
          ],
        },
      ],
    });

    const location = await resolveDatasetLocation('mixed.json', 'postgres');
    expect(location.collectionName).toBe('mixed_relational');
  });

  test('ignores a failed import when resolving location', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [{ dataset: 'orders', dbType: 'postgres', dbName: 'a', collectionName: 't', status: 'error', importedAt: '2026-01-01' }],
      partitions: [],
    });
    await expect(resolveDatasetLocation('orders', null)).rejects.toThrow(/was not found/);
  });
});

// ------------------------------------------------------------
// buildPostgresQuery
// ------------------------------------------------------------
describe('buildPostgresQuery', () => {
  const schema = [
    { original: 'id', safe: 'id', pgType: 'BIGINT' },
    { original: 'name', safe: 'name', pgType: 'TEXT' },
    { original: 'age', safe: 'age', pgType: 'BIGINT' },
  ];

  test('builds a parameterized select with no conditions', () => {
    const { sql, values } = buildPostgresQuery({
      queryType: 'select',
      resolvedName: 'people',
      schema,
      conditions: [],
      sort: null,
      limit: 25,
    });
    expect(sql).toBe('SELECT * FROM "people" LIMIT $1');
    expect(values).toEqual([25]);
  });

  test('builds a parameterized WHERE clause with mixed operators', () => {
    const { sql, values } = buildPostgresQuery({
      queryType: 'select',
      resolvedName: 'people',
      schema,
      conditions: [
        { field: 'age', operator: 'gte', value: 30 },
        { field: 'name', operator: 'eq', value: 'Ada' },
      ],
      sort: { field: 'age', direction: 'desc' },
      limit: 10,
    });
    expect(sql).toBe('SELECT * FROM "people" WHERE "age" >= $1 AND "name" = $2 ORDER BY "age" DESC LIMIT $3');
    expect(values).toEqual([30, 'Ada', 10]);
  });

  test('builds a COUNT query', () => {
    const { sql, values } = buildPostgresQuery({
      queryType: 'count',
      resolvedName: 'people',
      schema,
      conditions: [{ field: 'age', operator: 'gt', value: 18 }],
      sort: null,
      limit: 50,
    });
    expect(sql).toBe('SELECT COUNT(*) AS count FROM "people" WHERE "age" > $1');
    expect(values).toEqual([18]);
  });

  test('rejects an unknown column', () => {
    expect(() =>
      buildPostgresQuery({
        queryType: 'select',
        resolvedName: 'people',
        schema,
        conditions: [{ field: 'ssn', operator: 'eq', value: '123' }],
        sort: null,
        limit: 10,
      }),
    ).toThrow(/Unknown column "ssn"/);
  });

  test('search without known text columns or explicit fields throws', () => {
    const numericOnlySchema = [{ original: 'age', safe: 'age', pgType: 'BIGINT' }];
    expect(() =>
      buildPostgresQuery({
        queryType: 'search',
        resolvedName: 'people',
        schema: numericOnlySchema,
        conditions: { text: 'ada', fields: null },
        sort: null,
        limit: 10,
      }),
    ).toThrow(/No searchable text columns/);
  });

  test('search builds an ILIKE clause over default text columns', () => {
    const { sql, values } = buildPostgresQuery({
      queryType: 'search',
      resolvedName: 'people',
      schema,
      conditions: { text: 'ada', fields: null },
      sort: null,
      limit: 10,
    });
    expect(sql).toContain('"name" ILIKE $1');
    expect(values).toEqual(['%ada%', 10]);
  });
});

// ------------------------------------------------------------
// buildMongoFilter / buildMongoSearchFilter
// ------------------------------------------------------------
describe('buildMongoFilter', () => {
  test('maps eq directly and merges range operators on the same field', () => {
    const filter = buildMongoFilter([
      { field: 'status', operator: 'eq', value: 'active' },
      { field: 'age', operator: 'gte', value: 20 },
      { field: 'age', operator: 'lte', value: 40 },
    ]);
    expect(filter).toEqual({ status: 'active', age: { $gte: 20, $lte: 40 } });
  });

  test('maps "in" to $in', () => {
    expect(buildMongoFilter([{ field: 'status', operator: 'in', value: ['a', 'b'] }])).toEqual({
      status: { $in: ['a', 'b'] },
    });
  });
});

describe('buildMongoSearchFilter', () => {
  test('escapes regex special characters in the search text', () => {
    const filter = buildMongoSearchFilter({ text: 'a.b*c', fields: ['title'] });
    expect(filter.$or[0].title.$regex).toBe('a\\.b\\*c');
  });
});

// ------------------------------------------------------------
// buildElasticsearchQuery
// ------------------------------------------------------------
describe('buildElasticsearchQuery', () => {
  test('builds a bool query from filter conditions', () => {
    const query = buildElasticsearchQuery({
      queryType: 'select',
      conditions: [
        { field: 'status', operator: 'eq', value: 'active' },
        { field: 'status', operator: 'ne', value: 'banned' },
        { field: 'tags', operator: 'in', value: ['a', 'b'] },
        { field: 'age', operator: 'gte', value: 18 },
      ],
    });
    expect(query).toEqual({
      bool: {
        must: [{ term: { status: 'active' } }, { terms: { tags: ['a', 'b'] } }, { range: { age: { gte: 18 } } }],
        must_not: [{ term: { status: 'banned' } }],
      },
    });
  });

  test('returns match_all for an empty filter', () => {
    expect(buildElasticsearchQuery({ queryType: 'select', conditions: [] })).toEqual({ match_all: {} });
  });

  test('uses multi_match when fields are known', () => {
    const query = buildElasticsearchQuery({
      queryType: 'search',
      conditions: { text: 'hello', fields: ['title', 'body'] },
      schema: null,
    });
    expect(query).toEqual({ multi_match: { query: 'hello', fields: ['title', 'body'] } });
  });

  test('falls back to query_string when no fields are known', () => {
    const query = buildElasticsearchQuery({ queryType: 'search', conditions: { text: 'hello', fields: null }, schema: null });
    expect(query).toEqual({ query_string: { query: 'hello' } });
  });
});

// ------------------------------------------------------------
// executeQuery (integration, mocked clients)
// ------------------------------------------------------------
describe('executeQuery', () => {
  test('runs a postgres select and returns the unified response shape', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        {
          dataset: 'orders',
          dbType: 'postgres',
          dbName: 'shop',
          collectionName: 'orders',
          schema: [
            { original: 'id', safe: 'id', pgType: 'BIGINT' },
            { original: 'status', safe: 'status', pgType: 'TEXT' },
          ],
          status: 'imported',
          importedAt: '2026-01-01',
        },
      ],
      partitions: [],
    });
    mockPgQuery.mockResolvedValue({ rows: [{ id: 1, status: 'active' }] });

    const result = await executeQuery({
      dataset: 'orders',
      queryType: 'select',
      conditions: { status: 'active' },
    });

    expect(result.selectedDatabase).toBe('postgres');
    expect(result.status).toBe('success');
    expect(result.results).toEqual([{ id: 1, status: 'active' }]);
    expect(result.resultCount).toBe(1);
    expect(result.error).toBeNull();
    expect(mockPgEnd).toHaveBeenCalled();
  });

  test('runs a mongodb search', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        {
          dataset: 'articles',
          dbType: 'mongodb',
          dbName: 'content',
          collectionName: 'articles',
          schema: [{ column: 'title', type: 'Text' }],
          status: 'imported',
          importedAt: '2026-01-01',
        },
      ],
      partitions: [],
    });
    const toArray = jest.fn().mockResolvedValue([{ title: 'Hello world' }]);
    mockMongoFind.mockReturnValue({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnValue({ toArray }) });

    const result = await executeQuery({
      dataset: 'articles',
      queryType: 'search',
      conditions: { text: 'hello' },
    });

    expect(result.selectedDatabase).toBe('mongodb');
    expect(result.status).toBe('success');
    expect(result.results).toEqual([{ title: 'Hello world' }]);
  });

  test('runs an elasticsearch count', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        { dataset: 'logs', dbType: 'elasticsearch', dbName: 'logs_idx', collectionName: 'logs_idx', schema: null, status: 'imported', importedAt: '2026-01-01' },
      ],
      partitions: [],
    });
    mockEsCount.mockResolvedValue({ count: 42 });

    const result = await executeQuery({ dataset: 'logs', queryType: 'count', conditions: { level: 'error' } });

    expect(result.selectedDatabase).toBe('elasticsearch');
    expect(result.resultCount).toBe(42);
    expect(result.results).toEqual([]);
  });

  test('rejects an ambiguous multi-database dataset without executing any query', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        { dataset: 'events', dbType: 'postgres', dbName: 'a', collectionName: 't', status: 'imported', importedAt: '2026-01-01' },
        { dataset: 'events', dbType: 'mongodb', dbName: 'a', collectionName: 't', status: 'imported', importedAt: '2026-01-02' },
      ],
      partitions: [],
    });

    await expect(executeQuery({ dataset: 'events', queryType: 'select' })).rejects.toBeInstanceOf(QueryValidationError);
    expect(mockPgConnect).not.toHaveBeenCalled();
    expect(mockMongoConnect).not.toHaveBeenCalled();
  });

  test('rejects a query for an unknown dataset', async () => {
    mockGetMetadata.mockResolvedValue({ imports: [], partitions: [] });
    await expect(executeQuery({ dataset: 'nope', queryType: 'select' })).rejects.toBeInstanceOf(QueryValidationError);
  });

  test('returns a status: error response (not a throw) when the database call fails at runtime', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [{ dataset: 'orders', dbType: 'postgres', dbName: 'shop', collectionName: 'orders', schema: null, status: 'imported', importedAt: '2026-01-01' }],
      partitions: [],
    });
    mockPgQuery.mockRejectedValue(new Error('connection refused'));

    const result = await executeQuery({ dataset: 'orders', queryType: 'select' });

    expect(result.status).toBe('error');
    expect(result.error.message).toMatch(/connection refused/);
    expect(result.results).toEqual([]);
    expect(mockPgEnd).toHaveBeenCalled();
  });

  test('propagates an unknown-column error as a validation error, not a status: error response', async () => {
    mockGetMetadata.mockResolvedValue({
      imports: [
        {
          dataset: 'orders',
          dbType: 'postgres',
          dbName: 'shop',
          collectionName: 'orders',
          schema: [{ original: 'id', safe: 'id', pgType: 'BIGINT' }],
          status: 'imported',
          importedAt: '2026-01-01',
        },
      ],
      partitions: [],
    });

    await expect(
      executeQuery({ dataset: 'orders', queryType: 'select', conditions: { ssn: '123' } }),
    ).rejects.toBeInstanceOf(QueryValidationError);
  });
});
