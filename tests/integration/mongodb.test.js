// No jest.mock() — real MongoDB (see docker-compose.yml). Soft-skips
// if nothing is listening at the configured MONGO_URI host/port.
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const request = require('supertest');
const { isPortOpen, announceSkip } = require('./_helpers');

const mongoUrl = new URL(process.env.MONGO_URI || 'mongodb://localhost:27017');
const MONGO_HOST = mongoUrl.hostname || 'localhost';
const MONGO_PORT = Number(mongoUrl.port || 27017);
const DB_NAME = `maestro_real_test_${Date.now()}`;
const jsonBuffer = fs.readFileSync(path.join(__dirname, '..', '..', 'sample-data', 'orders_with_items.json'));

let available = false;
let app;

beforeAll(async () => {
  available = await isPortOpen(MONGO_HOST, MONGO_PORT);
  if (available) {
    app = require('../../server');
  } else {
    announceSkip('MongoDB', 'docker compose up -d mongo');
  }
});

const { liveTest } = require('../helpers/live');
const realTest = (name, fn, timeout) => liveTest(["mongo"])(name, fn, timeout);

describe('MongoDB — real service integration', () => {
  realTest('imports sample-data/orders_with_items.json, preserving nested item arrays', async () => {
    const response = await request(app)
      .post('/database/import')
      .field('dbType', 'mongodb')
      .field('dbName', DB_NAME)
      .field('collectionName', 'orders')
      .attach('datasetFile', jsonBuffer, 'orders_with_items.json');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('imported');
    expect(response.body.data.insertedCount).toBe(4);
    expect(response.body.data.dbType).toBe('mongodb');
  }, 15000);

  realTest('queries the real collection and gets nested items back intact', async () => {
    const response = await request(app).post('/v1/query').send({
      dataset: 'orders_with_items.json',
      queryType: 'select',
      conditions: { customer_id: 100 },
      targetDatabase: 'mongodb',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.selectedDatabase).toBe('mongodb');
    expect(response.body.results.length).toBeGreaterThanOrEqual(1);
    // Nested arrays/objects must survive the round trip unflattened.
    expect(Array.isArray(response.body.results[0].items)).toBe(true);
    expect(response.body.results[0].items[0]).toHaveProperty('sku');
  }, 15000);

  realTest('a real count query matches the imported document count', async () => {
    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'orders_with_items.json', queryType: 'count', targetDatabase: 'mongodb' });

    expect(response.status).toBe(200);
    expect(response.body.resultCount).toBe(4);
  }, 15000);

  realTest('re-importing with the same identifier reports duplicates rather than doubling the collection', async () => {
    await request(app)
      .post('/database/import')
      .field('dbType', 'mongodb')
      .field('dbName', DB_NAME)
      .field('collectionName', 'orders')
      .attach('datasetFile', jsonBuffer, 'orders_with_items.json');

    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'orders_with_items.json', queryType: 'count', targetDatabase: 'mongodb' });

    expect(response.body.resultCount).toBe(4); // still 4, duplicates rejected by _id
  }, 20000);
});
