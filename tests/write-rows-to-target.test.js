// Mocks must come before requiring database-service, since it wires
// up pg/mongodb/@elastic/elasticsearch clients at call time.
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

const mockMongoInsertMany = jest.fn();
const mockMongoCreateCollection = jest.fn();
const mockMongoConnect = jest.fn();
const mockMongoClose = jest.fn();

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockMongoConnect,
    close: mockMongoClose,
    db: jest.fn(() => ({
      createCollection: mockMongoCreateCollection,
      collection: jest.fn(() => ({
        insertMany: mockMongoInsertMany,
      })),
    })),
  })),
}));

const mockEsExists = jest.fn();
const mockEsCreate = jest.fn();
const mockEsBulk = jest.fn();

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    indices: { exists: mockEsExists, create: mockEsCreate },
    bulk: mockEsBulk,
  })),
}));

// Cache invalidation is exercised in its own dedicated suite
// (tests/query-cache.test.js) — here it's stubbed out so importFile()/
// importPartitions() never attempt a real (or mocked) Redis connection.
jest.mock('../query-cache', () => ({
  invalidateDataset: jest.fn().mockResolvedValue(0),
}));

const {
  writeRowsToTarget,
  sanitizeIdentifier,
  mapProfileTypeToPostgres,
  buildPostgresSchema,
  detectIdentifierColumn,
  summarizeErrors,
} = require('../database-service');

beforeEach(() => {
  jest.clearAllMocks();
  mockPgConnect.mockResolvedValue();
  mockPgEnd.mockResolvedValue();
  mockMongoConnect.mockResolvedValue();
  mockMongoClose.mockResolvedValue();
  mockMongoCreateCollection.mockResolvedValue();
  mockEsExists.mockResolvedValue(false);
  mockEsCreate.mockResolvedValue();
});

describe('sanitizeIdentifier', () => {
  test('lowercases and replaces unsafe characters', () => {
    expect(sanitizeIdentifier('User Name!!')).toBe('user_name');
  });

  test('prefixes names that do not start with a letter or underscore', () => {
    expect(sanitizeIdentifier('123abc', { fallbackPrefix: 'col' })).toBe('col_123abc');
  });

  test('falls back to the prefix for empty/unusable input', () => {
    expect(sanitizeIdentifier('', { fallbackPrefix: 'table' })).toBe('table');
    expect(sanitizeIdentifier('!!!', { fallbackPrefix: 'table' })).toBe('table');
  });

  test('truncates to maxLength', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeIdentifier(long, { maxLength: 10 }).length).toBe(10);
  });
});

describe('mapProfileTypeToPostgres', () => {
  test('maps Boolean, Date, nested types, and defaults to TEXT', () => {
    expect(mapProfileTypeToPostgres({ type: 'Boolean' })).toBe('BOOLEAN');
    expect(mapProfileTypeToPostgres({ type: 'Date' })).toBe('TIMESTAMP');
    expect(mapProfileTypeToPostgres({ type: 'Object' })).toBe('JSONB');
    expect(mapProfileTypeToPostgres({ type: 'Array' })).toBe('JSONB');
    expect(mapProfileTypeToPostgres({ type: 'Text' })).toBe('TEXT');
    expect(mapProfileTypeToPostgres(null)).toBe('TEXT');
  });

  test('distinguishes integer-only numeric columns from decimals', () => {
    expect(mapProfileTypeToPostgres({ type: 'Numeric', sampleValues: ['1', '2', '3'] })).toBe('BIGINT');
    expect(mapProfileTypeToPostgres({ type: 'Numeric', sampleValues: ['1.5', '2'] })).toBe('NUMERIC');
  });
});

describe('buildPostgresSchema', () => {
  test('builds a safe, typed, de-duplicated schema from rows and a profile', () => {
    const rows = [{ 'User Name': 'Ada', user_name: 'dup', age: 36 }];
    const profileColumns = [
      { column: 'User Name', type: 'Text' },
      { column: 'user_name', type: 'Text' },
      { column: 'age', type: 'Numeric', sampleValues: [36] },
    ];

    const schema = buildPostgresSchema(rows, profileColumns);

    expect(schema).toHaveLength(3);
    expect(new Set(schema.map((c) => c.safe)).size).toBe(3); // no collisions
    expect(schema.find((c) => c.original === 'age').pgType).toBe('BIGINT');
  });
});

describe('detectIdentifierColumn', () => {
  test('finds id-like column names', () => {
    expect(detectIdentifierColumn(['name', 'user_id', 'age'])).toBe('user_id');
    expect(detectIdentifierColumn(['name', 'age'])).toBeNull();
  });
});

describe('summarizeErrors', () => {
  test('dedupes and caps the error list', () => {
    const errors = Array.from({ length: 10 }, (_, i) => `error ${i % 3}`);
    const result = summarizeErrors(errors, 2);
    expect(result).toHaveLength(3); // 2 unique + "...and N more"
    expect(result[2]).toMatch(/more error/);
  });

  test('returns an empty array for no errors', () => {
    expect(summarizeErrors([])).toEqual([]);
  });
});

describe('writeRowsToTarget: postgres', () => {
  test('creates a safe table, types columns from the profile, and reports full success', async () => {
    mockPgQuery.mockResolvedValue({ rowCount: 1 });

    const result = await writeRowsToTarget({
      dbType: 'postgres',
      dbName: 'mydb',
      collectionName: 'My Table!',
      rows: [{ id: '1', name: 'Ada' }],
      columns: [
        { column: 'id', type: 'Numeric', sampleValues: ['1'] },
        { column: 'name', type: 'Text' },
      ],
      identifierColumn: 'id',
    });

    expect(result.status).toBe('imported');
    expect(result.resolvedName).toBe('my_table');
    expect(result.insertedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    // CREATE TABLE call used a quoted, sanitized identifier.
    expect(mockPgQuery.mock.calls[0][0]).toContain('"my_table"');
    expect(mockPgEnd).toHaveBeenCalled();
  });

  test('reports a partial import when some rows fail', async () => {
    mockPgQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // CREATE TABLE
      .mockRejectedValueOnce(new Error('constraint violation')) // ALTER TABLE (identifier constraint) - ignored
      .mockResolvedValueOnce({ rowCount: 1 }) // row 1 insert ok
      .mockRejectedValueOnce(new Error('duplicate key value')); // row 2 insert fails

    const result = await writeRowsToTarget({
      dbType: 'postgres',
      dbName: 'mydb',
      collectionName: 'people',
      rows: [{ id: '1' }, { id: '1' }],
      identifierColumn: 'id',
    });

    expect(result.status).toBe('partial');
    expect(result.insertedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]).toMatch(/duplicate key/);
  });

  test('always closes the connection even when a query throws', async () => {
    mockPgQuery.mockRejectedValue(new Error('connection reset'));

    const result = await writeRowsToTarget({
      dbType: 'postgres',
      dbName: 'mydb',
      collectionName: 'people',
      rows: [{ id: '1' }],
    });

    expect(result.status).toBe('error');
    expect(mockPgEnd).toHaveBeenCalled();
  });
});

describe('writeRowsToTarget: mongodb', () => {
  test('preserves nested objects/arrays and reports full success', async () => {
    mockMongoInsertMany.mockResolvedValue({ insertedCount: 2 });

    const rows = [
      { id: 1, tags: ['a', 'b'], meta: { active: true } },
      { id: 2, tags: [], meta: {} },
    ];

    const result = await writeRowsToTarget({
      dbType: 'mongodb',
      dbName: 'mydb',
      collectionName: 'items',
      rows,
      identifierColumn: 'id',
    });

    expect(result.status).toBe('imported');
    expect(result.insertedCount).toBe(2);
    const insertedDocs = mockMongoInsertMany.mock.calls[0][0];
    expect(insertedDocs[0]._id).toBe(1);
    expect(insertedDocs[0].tags).toEqual(['a', 'b']);
    expect(insertedDocs[0].meta).toEqual({ active: true });
  });

  test('reports duplicate identifiers as a partial import instead of failing the whole batch', async () => {
    const bulkError = new Error('E11000 duplicate key error');
    bulkError.result = { insertedCount: 1 };
    bulkError.writeErrors = [{ err: { code: 11000, errmsg: 'E11000 duplicate key' } }];
    mockMongoInsertMany.mockRejectedValue(bulkError);

    const result = await writeRowsToTarget({
      dbType: 'mongodb',
      dbName: 'mydb',
      collectionName: 'items',
      rows: [{ id: 1 }, { id: 1 }],
      identifierColumn: 'id',
    });

    expect(result.status).toBe('partial');
    expect(result.insertedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]).toMatch(/Duplicate identifier/);
  });
});

describe('writeRowsToTarget: elasticsearch', () => {
  test('creates the index only when it does not already exist, and bulk-indexes rows', async () => {
    mockEsExists.mockResolvedValue(false);
    mockEsBulk.mockResolvedValue({ errors: false, items: [] });

    const result = await writeRowsToTarget({
      dbType: 'elasticsearch',
      dbName: 'My Index',
      rows: [{ id: 1, title: 'hello' }],
      identifierColumn: 'id',
    });

    expect(mockEsCreate).toHaveBeenCalledWith({ index: 'my_index' });
    expect(result.status).toBe('imported');
    expect(result.insertedCount).toBe(1);
  });

  test('skips index creation when it already exists (idempotent)', async () => {
    mockEsExists.mockResolvedValue(true);
    mockEsBulk.mockResolvedValue({ errors: false, items: [] });

    await writeRowsToTarget({ dbType: 'elasticsearch', dbName: 'idx', rows: [{ id: 1 }] });

    expect(mockEsCreate).not.toHaveBeenCalled();
  });

  test('reports partial bulk failures with per-document counts', async () => {
    mockEsBulk.mockResolvedValue({
      errors: true,
      items: [
        { index: { status: 201 } },
        { index: { status: 400, error: { type: 'mapper_parsing_exception', reason: 'bad field' } } },
      ],
    });

    const result = await writeRowsToTarget({
      dbType: 'elasticsearch',
      dbName: 'idx',
      rows: [{ id: 1 }, { id: 2 }],
    });

    expect(result.status).toBe('partial');
    expect(result.insertedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]).toMatch(/bad field/);
  });
});

describe('writeRowsToTarget: shared behavior', () => {
  test('returns a skipped status for an empty row set without touching any client', async () => {
    const result = await writeRowsToTarget({ dbType: 'postgres', dbName: 'mydb', rows: [] });
    expect(result.status).toBe('skipped');
    expect(mockPgConnect).not.toHaveBeenCalled();
  });
});

describe('importFile validation', () => {
  const { importFile, ImportValidationError } = require('../database-service');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('rejects an unsupported database type before touching the file', async () => {
    await expect(
      importFile({ dbType: 'not-a-real-db', dbName: 'x', filePath: '/nonexistent', originalName: 'a.csv' }),
    ).rejects.toBeInstanceOf(ImportValidationError);
  });

  test('rejects a missing database name', async () => {
    await expect(
      importFile({ dbType: 'postgres', dbName: '', filePath: '/nonexistent', originalName: 'a.csv' }),
    ).rejects.toThrow(/database name is required/i);
  });

  test('rejects an unsupported file extension', async () => {
    const tmpFile = path.join(os.tmpdir(), `maestro-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'hello');
    await expect(
      importFile({ dbType: 'postgres', dbName: 'mydb', filePath: tmpFile, originalName: 'notes.txt' }),
    ).rejects.toThrow(/only csv and json/i);
    fs.unlinkSync(tmpFile);
  });

  test('rejects a file with no data rows', async () => {
    const tmpFile = path.join(os.tmpdir(), `maestro-test-${Date.now()}.csv`);
    fs.writeFileSync(tmpFile, 'name,age\n');
    await expect(
      importFile({ dbType: 'postgres', dbName: 'mydb', filePath: tmpFile, originalName: 'empty.csv' }),
    ).rejects.toThrow(/no data rows/i);
    fs.unlinkSync(tmpFile);
  });

  test('imports a valid CSV end-to-end with typed columns and a detected identifier', async () => {
    mockPgQuery.mockResolvedValue({ rowCount: 1 });
    const tmpFile = path.join(os.tmpdir(), `maestro-test-${Date.now()}.csv`);
    fs.writeFileSync(tmpFile, 'id,name,age\n1,Ada,36\n2,Grace,45\n');

    const record = await importFile({
      dbType: 'postgres',
      dbName: 'mydb',
      collectionName: 'people',
      filePath: tmpFile,
      originalName: 'people.csv',
    });

    expect(record.status).toBe('imported');
    expect(record.rowCount).toBe(2);
    expect(record.identifierColumn).toBe('id');
    expect(record.fileType).toBe('csv');
    fs.unlinkSync(tmpFile);
  });
});

describe('importPartitions validation', () => {
  const { importPartitions, ImportValidationError } = require('../database-service');

  test('rejects a plan with no partitions', async () => {
    await expect(
      importPartitions({ plan: { partitions: [] }, defaultDbName: 'mydb', originalName: 'a.csv' }),
    ).rejects.toBeInstanceOf(ImportValidationError);
  });

  test('reports a missing target database name as a per-partition error without throwing', async () => {
    const plan = {
      required: true,
      recordIdentifier: { column: 'id', synthesized: false },
      totalRecords: 1,
      partitions: [{ target: 'postgres', category: 'relational', columns: ['id'], recordCount: 1, rows: [{ id: 1 }] }],
    };

    const result = await importPartitions({ plan, targets: {}, defaultDbName: null, originalName: 'a.csv' });

    expect(result.status).toBe('error');
    expect(result.partitions[0].status).toBe('error');
    expect(result.partitions[0].message).toMatch(/no database name/i);
  });
});
