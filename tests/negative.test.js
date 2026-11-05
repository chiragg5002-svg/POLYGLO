// Fills the negative-test gaps not already covered by
// tests/workflow.integration.test.js (which covers Postgres-
// unavailable, invalid file, import partial-failure, invalid query,
// and Ollama-unavailable already). Everything here runs through real
// HTTP via supertest, with pg/mongodb/@elastic/elasticsearch/redis
// mocked at the boundary — no real service or cloud API is needed.
process.env.PORT = "0";

const mockPgConnect = jest.fn().mockResolvedValue();
const mockPgEnd = jest.fn().mockResolvedValue();
const mockPgQuery = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockPgConnect,
    query: mockPgQuery,
    end: mockPgEnd,
  })),
}));

const mockMongoConnect = jest.fn().mockResolvedValue();
const mockMongoClose = jest.fn().mockResolvedValue();
const mockMongoCreateCollection = jest.fn().mockResolvedValue();
const mockMongoInsertMany = jest.fn().mockResolvedValue({ insertedCount: 0 });

jest.mock("mongodb", () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockMongoConnect,
    close: mockMongoClose,
    db: jest.fn(() => ({
      createCollection: mockMongoCreateCollection,
      collection: jest.fn(() => ({ insertMany: mockMongoInsertMany })),
    })),
  })),
}));

const mockEsExists = jest.fn().mockResolvedValue(false);
const mockEsCreate = jest.fn().mockResolvedValue();
const mockEsBulk = jest.fn().mockResolvedValue({ errors: false, items: [] });

jest.mock("@elastic/elasticsearch", () => ({
  Client: jest.fn().mockImplementation(() => ({
    indices: { exists: mockEsExists, create: mockEsCreate },
    bulk: mockEsBulk,
  })),
}));

// No real cache needed for these — every test here either doesn't
// touch caching or explicitly wants it disabled/unreachable.
jest.mock("redis", () => ({
  createClient: jest.fn().mockImplementation(() => ({
    isReady: false,
    connect: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    on: jest.fn(),
  })),
}));

const supertest = require("supertest");
const OPERATOR_AUTH = "Bearer maestro-test-only-operator-token";
const request = (target) => ({
  get: (path) => supertest(target).get(path).set("Authorization", OPERATOR_AUTH),
  post: (path) => supertest(target).post(path).set("Authorization", OPERATOR_AUTH),
});
const app = require("../server");

const SAMPLE_ROWS = [{ id: "1", name: "Ada" }];
function toCsv(rows) {
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => r[h]).join(","))].join("\n");
}

describe("negative: unavailable services", () => {
  test("MongoDB unavailable during import is reported clearly, not a 500", async () => {
    mockMongoConnect.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:27017"));

    const response = await request(app)
      .post("/database/import")
      .field("dbType", "mongodb")
      .field("dbName", "shop")
      .field("collectionName", "customers")
      .attach("datasetFile", Buffer.from(toCsv(SAMPLE_ROWS)), "mongo-down.csv");

    expect(response.status).toBe(200); // the request itself was valid
    expect(response.body.success).toBe(false);
    expect(response.body.data.status).toBe("error");
    expect(response.body.data.dbType).toBe("mongodb");
    expect(response.body.data.message).toMatch(/ECONNREFUSED/);
  });

  test("Elasticsearch unavailable during import is reported clearly, not a 500", async () => {
    mockEsExists.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9200"), {
      meta: { body: { error: { type: "connection_error" } } },
    }));

    const response = await request(app)
      .post("/database/import")
      .field("dbType", "elasticsearch")
      .field("dbName", "logs_idx")
      .attach("datasetFile", Buffer.from(toCsv(SAMPLE_ROWS)), "es-down.csv");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(false);
    expect(response.body.data.status).toBe("error");
    expect(response.body.data.dbType).toBe("elasticsearch");
    expect(response.body.data.message).toMatch(/ECONNREFUSED/);
  });

  test("Redis unavailable during a query: the query still succeeds from the database (source: database)", async () => {
    mockPgQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 1, name: "Ada" }] });

    // Import first so the dataset is resolvable.
    await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .field("collectionName", "people")
      .attach("datasetFile", Buffer.from(toCsv(SAMPLE_ROWS)), "redis-down.csv");

    const response = await request(app)
      .post("/v1/query")
      .send({ dataset: "redis-down.csv", queryType: "select", targetDatabase: "postgres" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("success");
    expect(response.body.source).toBe("database"); // cache was unreachable, not used
  });
});

describe("negative: invalid data", () => {
  test("malformed JSON upload is rejected with a clear 400, not a raw SyntaxError / 500", async () => {
    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .attach("datasetFile", Buffer.from("{ this is not valid json"), "broken.json");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/could not parse/i);
  });

  test("a JSON file that is neither an object nor an array is rejected with a clear 400", async () => {
    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .attach("datasetFile", Buffer.from('"just a string"'), "not-an-object.json");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  test("an empty CSV (header row only, no data) is rejected with a clear 400", async () => {
    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .attach("datasetFile", Buffer.from("id,name\n"), "empty.csv");

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no data rows/i);
  });

  test("a federated query with an unsupported join type is rejected with a clear 400 over real HTTP", async () => {
    const response = await request(app)
      .post("/v1/query/federated")
      .send({
        sources: [
          { dataset: "a.csv", alias: "a" },
          { dataset: "b.csv", alias: "b" },
        ],
        join: { type: "right", left: { alias: "a", field: "id" }, right: { alias: "b", field: "id" } },
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/unsupported join type/i);
  });

  test("a federated query with only one source is rejected with a clear 400", async () => {
    const response = await request(app)
      .post("/v1/query/federated")
      .send({
        sources: [{ dataset: "a.csv", alias: "a" }],
        join: { type: "inner", left: { alias: "a", field: "id" }, right: { alias: "b", field: "id" } },
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/exactly 2 sources/i);
  });
});
