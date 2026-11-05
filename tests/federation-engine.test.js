// Mocks must be declared before requiring federation-engine, since it
// (via query-engine.js) wires up pg/mongodb/@elastic/elasticsearch
// clients at call time, and reads dataset locations through
// database-service's getMetadata.
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
const mockMongoConnect = jest.fn();
const mockMongoClose = jest.fn();

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockMongoConnect,
    close: mockMongoClose,
    db: jest.fn(() => ({
      collection: jest.fn(() => ({
        find: mockMongoFind,
      })),
    })),
  })),
}));

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    search: jest.fn(),
    count: jest.fn(),
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

const {
  validateFederationRequest,
  performJoin,
  applyProjection,
  getJoinValue,
  executeFederatedQuery,
  FederationValidationError,
} = require('../federation-engine');
const { QueryValidationError } = require('../query-engine');

beforeEach(() => {
  jest.clearAllMocks();
  mockPgConnect.mockResolvedValue();
  mockPgEnd.mockResolvedValue();
  mockMongoConnect.mockResolvedValue();
  mockMongoClose.mockResolvedValue();
});

// ------------------------------------------------------------
// Sample datasets: a PostgreSQL "orders" table and a MongoDB
// "customers" collection, related by customer_id / id.
// ------------------------------------------------------------
const SAMPLE_ORDERS = [
  { id: 1, customer_id: 100, total: 49.99 },
  { id: 2, customer_id: 101, total: 12.5 },
  { id: 3, customer_id: 999, total: 5.0 }, // no matching customer
];

const SAMPLE_CUSTOMERS = [
  { id: 100, name: 'Ada Lovelace', region: 'UK' },
  { id: 101, name: 'Grace Hopper', region: 'US' },
];

const ORDERS_SCHEMA = [
  { original: 'id', safe: 'id', pgType: 'BIGINT' },
  { original: 'customer_id', safe: 'customer_id', pgType: 'BIGINT' },
  { original: 'total', safe: 'total', pgType: 'NUMERIC' },
];

function mockOrdersAndCustomersMetadata() {
  mockGetMetadata.mockResolvedValue({
    imports: [
      {
        dataset: 'orders.csv',
        dbType: 'postgres',
        dbName: 'shop',
        collectionName: 'orders',
        schema: ORDERS_SCHEMA,
        status: 'imported',
        importedAt: '2026-01-01',
      },
      {
        dataset: 'customers.json',
        dbType: 'mongodb',
        dbName: 'shop',
        collectionName: 'customers',
        schema: [
          { column: 'id', type: 'Numeric' },
          { column: 'name', type: 'Text' },
          { column: 'region', type: 'Text' },
        ],
        status: 'imported',
        importedAt: '2026-01-01',
      },
    ],
    partitions: [],
  });
}

function buildFederationRequest(overrides = {}) {
  return {
    sources: [
      { dataset: 'orders.csv', alias: 'orders', targetDatabase: 'postgres' },
      { dataset: 'customers.json', alias: 'customers', targetDatabase: 'mongodb' },
    ],
    join: {
      type: 'inner',
      left: { alias: 'orders', field: 'customer_id' },
      right: { alias: 'customers', field: 'id' },
    },
    ...overrides,
  };
}

// ------------------------------------------------------------
// validateFederationRequest
// ------------------------------------------------------------
describe('validateFederationRequest', () => {
  test('accepts a well-formed two-source inner join', () => {
    const result = validateFederationRequest(buildFederationRequest());
    expect(result.join.type).toBe('inner');
    expect(result.sources).toHaveLength(2);
    expect(result.limit).toBeGreaterThan(0);
    expect(result.timeoutMs).toBeGreaterThan(0);
  });

  test('rejects fewer than two sources', () => {
    expect(() =>
      validateFederationRequest(buildFederationRequest({ sources: [{ dataset: 'orders.csv', alias: 'orders' }] })),
    ).toThrow(/exactly 2 sources/);
  });

  test('rejects more than two sources (no N-way joins yet)', () => {
    const req = buildFederationRequest();
    req.sources.push({ dataset: 'extra.csv', alias: 'extra' });
    expect(() => validateFederationRequest(req)).toThrow(/exactly 2 sources/);
  });

  test('rejects duplicate aliases', () => {
    const req = buildFederationRequest();
    req.sources[1].alias = 'orders';
    expect(() => validateFederationRequest(req)).toThrow(/Duplicate source alias/);
  });

  test('rejects an unsupported join type clearly', () => {
    const req = buildFederationRequest();
    req.join.type = 'right';
    expect(() => validateFederationRequest(req)).toThrow(/Unsupported join type "right"/);
  });

  test('rejects a missing join field (explicit fields required)', () => {
    const req = buildFederationRequest();
    delete req.join.left.field;
    expect(() => validateFederationRequest(req)).toThrow(/join.left.field.*required/);
  });

  test('rejects a join.left.alias that does not match any source', () => {
    const req = buildFederationRequest();
    req.join.left.alias = 'not-a-source';
    expect(() => validateFederationRequest(req)).toThrow(/does not match any entry/);
  });

  test('rejects left and right aliases being the same source', () => {
    const req = buildFederationRequest();
    req.join.right.alias = 'orders';
    expect(() => validateFederationRequest(req)).toThrow(/must refer to different sources/);
  });

  test('rejects an unsupported source queryType clearly', () => {
    const req = buildFederationRequest();
    req.sources[0].queryType = 'search';
    expect(() => validateFederationRequest(req)).toThrow(/Unsupported queryType "search"/);
  });

  test('rejects an invalid operator in a source condition', () => {
    const req = buildFederationRequest();
    req.sources[0].conditions = { total: { between: 10 } };
    expect(() => validateFederationRequest(req)).toThrow(/Invalid operator/);
  });

  test('caps a source limit at MAX_SOURCE_ROWS regardless of what was requested', () => {
    const req = buildFederationRequest();
    req.sources[0].limit = 999999999;
    const result = validateFederationRequest(req);
    const { MAX_SOURCE_ROWS } = require('../federation-engine');
    expect(result.sources[0].limit).toBeLessThanOrEqual(MAX_SOURCE_ROWS);
  });

  test('every source always has a bounded limit even with no limit requested (prevents full scans)', () => {
    const result = validateFederationRequest(buildFederationRequest());
    result.sources.forEach((source) => {
      expect(source.limit).toBeGreaterThan(0);
      expect(Number.isFinite(source.limit)).toBe(true);
    });
  });

  test('rejects an invalid projection entry', () => {
    const req = buildFederationRequest({ projection: ['not-dotted'] });
    expect(() => validateFederationRequest(req)).toThrow(/alias\.field/);
  });

  test('rejects a projection referencing an unknown alias', () => {
    const req = buildFederationRequest({ projection: ['ghost.field'] });
    expect(() => validateFederationRequest(req)).toThrow(/unknown alias/);
  });

  test('clamps an excessive timeoutMs to the absolute ceiling', () => {
    const result = validateFederationRequest(buildFederationRequest({ timeoutMs: 10_000_000 }));
    const { ABSOLUTE_MAX_TIMEOUT_MS } = require('../federation-engine');
    expect(result.timeoutMs).toBe(ABSOLUTE_MAX_TIMEOUT_MS);
  });
});

// ------------------------------------------------------------
// getJoinValue / performJoin / applyProjection
// ------------------------------------------------------------
describe('getJoinValue', () => {
  test('reads the named field directly when present', () => {
    expect(getJoinValue({ id: 5 }, 'id')).toBe(5);
  });

  test('falls back to _id when the named field is absent (Mongo identifier remap)', () => {
    expect(getJoinValue({ _id: 100, name: 'Ada' }, 'id')).toBe(100);
  });

  test('returns undefined for a null row', () => {
    expect(getJoinValue(null, 'id')).toBeUndefined();
  });
});

describe('performJoin', () => {
  test('inner join drops unmatched left rows', () => {
    const joined = performJoin({
      type: 'inner',
      leftRows: SAMPLE_ORDERS,
      rightRows: SAMPLE_CUSTOMERS,
      leftAlias: 'orders',
      leftField: 'customer_id',
      rightAlias: 'customers',
      rightField: 'id',
    });
    expect(joined).toHaveLength(2); // order 3 (customer_id 999) has no match
    expect(joined.every((row) => row.customers !== null)).toBe(true);
  });

  test('left join keeps unmatched left rows with a null right side', () => {
    const joined = performJoin({
      type: 'left',
      leftRows: SAMPLE_ORDERS,
      rightRows: SAMPLE_CUSTOMERS,
      leftAlias: 'orders',
      leftField: 'customer_id',
      rightAlias: 'customers',
      rightField: 'id',
    });
    expect(joined).toHaveLength(3);
    const unmatched = joined.find((row) => row.orders.id === 3);
    expect(unmatched.customers).toBeNull();
  });

  test('joins multiple matching right rows (one-to-many) into separate result rows', () => {
    const rightRows = [
      { id: 100, name: 'Ada Lovelace' },
      { id: 100, name: 'Ada (duplicate record)' },
    ];
    const joined = performJoin({
      type: 'inner',
      leftRows: [{ id: 1, customer_id: 100 }],
      rightRows,
      leftAlias: 'orders',
      leftField: 'customer_id',
      rightAlias: 'customers',
      rightField: 'id',
    });
    expect(joined).toHaveLength(2);
  });
});

describe('applyProjection', () => {
  test('returns rows unchanged when no projection is given', () => {
    const rows = [{ orders: { id: 1 }, customers: { name: 'Ada' } }];
    expect(applyProjection(rows, null)).toBe(rows);
  });

  test('projects dotted alias.field paths into a flat object', () => {
    const rows = [{ orders: { id: 1, total: 49.99 }, customers: { name: 'Ada Lovelace' } }];
    const projected = applyProjection(rows, ['orders.id', 'customers.name']);
    expect(projected).toEqual([{ 'orders.id': 1, 'customers.name': 'Ada Lovelace' }]);
  });

  test('projects null for a missing right side (left join miss)', () => {
    const rows = [{ orders: { id: 3 }, customers: null }];
    const projected = applyProjection(rows, ['customers.name']);
    expect(projected).toEqual([{ 'customers.name': null }]);
  });
});

// ------------------------------------------------------------
// executeFederatedQuery (integration, mocked clients, sample data)
// ------------------------------------------------------------
describe('executeFederatedQuery', () => {
  function mockSources() {
    mockPgQuery.mockResolvedValue({ rows: SAMPLE_ORDERS });
    const toArray = jest.fn().mockResolvedValue(SAMPLE_CUSTOMERS);
    mockMongoFind.mockReturnValue({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnValue({ toArray }) });
  }

  test('joins a sample Postgres "orders" table with a sample Mongo "customers" collection (inner join)', async () => {
    mockOrdersAndCustomersMetadata();
    mockSources();

    const result = await executeFederatedQuery(buildFederationRequest());

    expect(result.status).toBe('success');
    expect(result.databasesUsed.sort()).toEqual(['mongodb', 'postgres']);
    expect(result.rowsRead).toEqual({ orders: 3, customers: 2 });
    expect(result.joinField).toEqual({ left: 'orders.customer_id', right: 'customers.id' });
    expect(result.resultCount).toBe(2);
    expect(result.results.map((row) => row.customers.name).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(result.errors).toEqual([]);
  });

  test('left join includes the unmatched order with a null customer side', async () => {
    mockOrdersAndCustomersMetadata();
    mockSources();

    const result = await executeFederatedQuery(
      buildFederationRequest({ join: { type: 'left', left: { alias: 'orders', field: 'customer_id' }, right: { alias: 'customers', field: 'id' } } }),
    );

    expect(result.resultCount).toBe(3);
    const unmatched = result.results.find((row) => row.orders.id === 3);
    expect(unmatched.customers).toBeNull();
  });

  test('applies projection and the final result limit', async () => {
    mockOrdersAndCustomersMetadata();
    mockSources();

    const result = await executeFederatedQuery(
      buildFederationRequest({ projection: ['orders.id', 'customers.name'], limit: 1 }),
    );

    expect(result.resultCount).toBe(1);
    expect(Object.keys(result.results[0])).toEqual(['orders.id', 'customers.name']);
  });

  test('rejects an unknown join field checked against the Postgres schema, before touching any database', async () => {
    mockOrdersAndCustomersMetadata();

    await expect(
      executeFederatedQuery(
        buildFederationRequest({
          join: { type: 'inner', left: { alias: 'orders', field: 'not_a_real_column' }, right: { alias: 'customers', field: 'id' } },
        }),
      ),
    ).rejects.toBeInstanceOf(FederationValidationError);
    expect(mockPgConnect).not.toHaveBeenCalled();
  });

  test('propagates dataset-not-found as a validation error', async () => {
    mockGetMetadata.mockResolvedValue({ imports: [], partitions: [] });
    await expect(executeFederatedQuery(buildFederationRequest())).rejects.toBeInstanceOf(QueryValidationError);
  });

  test('reports a failed source as status "error" with a per-source message instead of throwing', async () => {
    mockOrdersAndCustomersMetadata();
    mockPgQuery.mockRejectedValue(new Error('connection refused'));
    const toArray = jest.fn().mockResolvedValue(SAMPLE_CUSTOMERS);
    mockMongoFind.mockReturnValue({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnValue({ toArray }) });

    const result = await executeFederatedQuery(buildFederationRequest());

    expect(result.status).toBe('error');
    expect(result.results).toEqual([]);
    expect(result.errors[0]).toMatch(/orders \(postgres\): connection refused/);
  });

  test('times out a slow source instead of hanging indefinitely', async () => {
    mockOrdersAndCustomersMetadata();
    // timeoutMs is clamped up to MIN_TIMEOUT_MS (1000ms) by validation,
    // so the slow response must exceed that to actually trigger it.
    mockPgQuery.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ rows: SAMPLE_ORDERS }), 1500)));
    const toArray = jest.fn().mockResolvedValue(SAMPLE_CUSTOMERS);
    mockMongoFind.mockReturnValue({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnValue({ toArray }) });

    const result = await executeFederatedQuery(buildFederationRequest({ timeoutMs: 10 }));

    expect(result.status).toBe('error');
    expect(result.errors[0]).toMatch(/timed out/);
  }, 3000);
});
