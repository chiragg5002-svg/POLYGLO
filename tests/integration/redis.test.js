// No jest.mock() — real Redis AND real Postgres (a cache needs
// something real underneath it to cache). Soft-skips if either is
// unreachable, since a meaningful cache-hit test needs both.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { isPortOpen, announceSkip, dropPgDatabase } = require('./_helpers');

const { URL } = require('url');
const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const REDIS_HOST = redisUrl.hostname || 'localhost';
const REDIS_PORT = Number(redisUrl.port || 6379);
const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = Number(process.env.PG_PORT || 5432);

const DB_NAME = `maestro_real_test_${Date.now()}`;
const csvBuffer = fs.readFileSync(path.join(__dirname, '..', '..', 'sample-data', 'customers.csv'));

let available = false;
let app;

beforeAll(async () => {
  const [redisUp, pgUp] = await Promise.all([
    isPortOpen(REDIS_HOST, REDIS_PORT),
    isPortOpen(PG_HOST, PG_PORT),
  ]);
  available = redisUp && pgUp;

  if (available) {
    app = require('../../server');
  } else if (!redisUp) {
    announceSkip('Redis', 'docker compose up -d redis');
  } else {
    announceSkip('PostgreSQL (needed alongside Redis for this cache test)', 'docker compose up -d postgres');
  }
});

afterAll(async () => {
  await dropPgDatabase(DB_NAME);
  await require('../../query-cache').closeClient();
});

const { liveTest } = require('../helpers/live');
const realTest = (name, fn, timeout) => liveTest(["pg","redis"])(name, fn, timeout);

describe('Redis — real cache integration', () => {
  realTest('sets up: create db + import sample-data/customers.csv into real Postgres', async () => {
    await request(app).post('/database/create').send({ dbType: 'postgres', dbName: DB_NAME });
    const response = await request(app)
      .post('/database/import')
      .field('dbType', 'postgres')
      .field('dbName', DB_NAME)
      .field('collectionName', 'customers')
      .attach('datasetFile', csvBuffer, 'customers.csv');

    expect(response.body.data.status).toBe('imported');
  }, 20000);

  realTest('first query is a real cache miss (source: database)', async () => {
    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'customers.csv', queryType: 'select', conditions: { city: 'Boston' }, targetDatabase: 'postgres' });

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('database');
  }, 15000);

  realTest('repeating the identical query is a real cache hit (source: cache)', async () => {
    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'customers.csv', queryType: 'select', conditions: { city: 'Boston' }, targetDatabase: 'postgres' });

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('cache');
  }, 15000);

  realTest('re-importing invalidates the real cache — next query is a miss again', async () => {
    await request(app)
      .post('/database/import')
      .field('dbType', 'postgres')
      .field('dbName', DB_NAME)
      .field('collectionName', 'customers')
      .attach('datasetFile', csvBuffer, 'customers.csv');

    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'customers.csv', queryType: 'select', conditions: { city: 'Boston' }, targetDatabase: 'postgres' });

    expect(response.body.source).toBe('database');
  }, 20000);
});
