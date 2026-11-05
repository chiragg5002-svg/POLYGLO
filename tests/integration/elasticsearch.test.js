// No jest.mock() — real Elasticsearch (see docker-compose.yml).
// Soft-skips if its health endpoint isn't reachable.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { isHttpReachable, announceSkip } = require('./_helpers');

const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const DB_NAME = `maestro_real_test_${Date.now()}`;
const jsonBuffer = fs.readFileSync(path.join(__dirname, '..', '..', 'sample-data', 'application_logs.json'));

let available = false;
let app;

beforeAll(async () => {
  available = await isHttpReachable(`${ES_URL}/_cluster/health`);
  if (available) {
    app = require('../../server');
  } else {
    announceSkip('Elasticsearch', 'docker compose up -d elasticsearch  (can take ~30s to become healthy)');
  }
}, 10000);

const { liveTest } = require('../helpers/live');
const realTest = (name, fn, timeout) => liveTest(["es"])(name, fn, timeout);

describe('Elasticsearch — real service integration', () => {
  realTest('imports sample-data/application_logs.json into a real index', async () => {
    const response = await request(app)
      .post('/database/import')
      .field('dbType', 'elasticsearch')
      .field('dbName', DB_NAME)
      .field('collectionName', 'logs')
      .attach('datasetFile', jsonBuffer, 'application_logs.json');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('imported');
    expect(response.body.data.insertedCount).toBe(5);
    expect(response.body.data.dbType).toBe('elasticsearch');

    // Elasticsearch indexes asynchronously; bulk was called with
    // refresh: true (see writeRowsToTarget in database-service.js),
    // so the documents should already be searchable, but give it a
    // brief grace period before the next test queries the index.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 20000);

  realTest('a full-text search finds matching log messages', async () => {
    const response = await request(app).post('/v1/query').send({
      dataset: 'application_logs.json',
      queryType: 'search',
      conditions: { text: 'declined', fields: ['message'] },
      targetDatabase: 'elasticsearch',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.selectedDatabase).toBe('elasticsearch');
    expect(response.body.results.length).toBeGreaterThanOrEqual(1);
    expect(response.body.results.some((doc) => /declined/i.test(doc.message))).toBe(true);
  }, 15000);

  realTest('a real count query matches the imported document count', async () => {
    const response = await request(app)
      .post('/v1/query')
      .send({ dataset: 'application_logs.json', queryType: 'count', targetDatabase: 'elasticsearch' });

    expect(response.status).toBe(200);
    expect(response.body.resultCount).toBe(5);
  }, 15000);
});
