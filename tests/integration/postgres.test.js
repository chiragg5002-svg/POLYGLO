// No jest.mock() here on purpose — this suite talks to a REAL local
// PostgreSQL (see docker-compose.yml), never a mock. It soft-skips
// (each test logs a notice and returns immediately) if nothing is
// listening on PG_HOST:PG_PORT, so `npm test` still passes cleanly in
// an environment without Docker — see requirement "ensure tests do
// not require cloud APIs" and README.md's testing section.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { isPortOpen, announceSkip, dropPgDatabase } = require('./_helpers');

const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = Number(process.env.PG_PORT || 5432);
const DB_NAME = `maestro_real_test_${Date.now()}`;
const csvBuffer = fs.readFileSync(path.join(__dirname, '..', '..', 'sample-data', 'customers.csv'));

let available = false;
let app;

beforeAll(async () => {
  available = await isPortOpen(PG_HOST, PG_PORT);
  if (available) {
    app = require('../../server');
  } else {
    announceSkip('PostgreSQL', 'docker compose up -d postgres  (or: docker compose up -d)');
  }
});

afterAll(async () => {
  await dropPgDatabase(DB_NAME);
  await require('../../query-cache').closeClient();
});

const { liveTest } = require('../helpers/live');
const realTest = (name, fn, timeout) => liveTest(["pg"])(name, fn, timeout);

describe('PostgreSQL — real service integration', () => {
  realTest('creates a real database', async () => {
    const response = await request(app).post('/database/create').send({ dbType: 'postgres', dbName: DB_NAME });
    expect(response.status).toBe(200);
    expect(['created', 'exists']).toContain(response.body.data.status);
  }, 15000);

  realTest('imports sample-data/customers.csv into a real table', async () => {
    const response = await request(app)
      .post('/database/import')
      .field('dbType', 'postgres')
      .field('dbName', DB_NAME)
      .field('collectionName', 'customers')
      .attach('datasetFile', csvBuffer, 'customers.csv');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('imported');
    expect(response.body.data.insertedCount).toBe(6);
    expect(response.body.data.dbType).toBe('postgres');
    expect(response.body.data.collectionName).toBe('customers');
  }, 15000);

  realTest('queries the real table with a filter', async () => {
    const response = await request(app)
      .post('/v1/query')
      .send({
        dataset: 'customers.csv',
        queryType: 'select',
        conditions: { city: 'London' },
        targetDatabase: 'postgres',
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.selectedDatabase).toBe('postgres');
    expect(response.body.results.length).toBeGreaterThanOrEqual(1);
    expect(response.body.results[0].name).toBe('Ada Lovelace');
  }, 15000);

  realTest('a real count query matches the imported row count', async () => {
    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'customers.csv', queryType: 'count', targetDatabase: 'postgres' });

    expect(response.status).toBe(200);
    expect(response.body.resultCount).toBe(6);
  }, 15000);

  realTest('re-importing the same file is idempotent (no duplicate rows for the same id)', async () => {
    await request(app)
      .post('/database/import')
      .field('dbType', 'postgres')
      .field('dbName', DB_NAME)
      .field('collectionName', 'customers')
      .attach('datasetFile', csvBuffer, 'customers.csv');

    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'customers.csv', queryType: 'count', targetDatabase: 'postgres' });

    expect(response.body.resultCount).toBe(6); // still 6, not 12
  }, 20000);
});
