// Mocks must be declared before requiring the app, since server.js
// (via database-service.js / query-engine.js / query-cache.js) wires
// up pg and redis clients at call time. mongodb/@elastic/elasticsearch
// are intentionally left un-mocked here — no route in this test talks
// to either, so the real (unused) packages just sit there idle.
const { liveTest } = require("./helpers/live");
process.env.PORT = "0"; // server.js only listens when run directly (see server.js), but keep this in case that ever changes

const SAMPLE_ROWS = [
  { id: "1", name: "Ada", age: "36", status: "active" },
  { id: "2", name: "Grace", age: "45", status: "active" },
  { id: "3", name: "Alan", age: "41", status: "inactive" },
];

function toCsv(rows) {
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  rows.forEach((row) => lines.push(headers.map((h) => row[h]).join(",")));
  return lines.join("\n");
}

const mockPgConnect = jest.fn().mockResolvedValue();
const mockPgEnd = jest.fn().mockResolvedValue();

// A minimal fake Postgres that's just smart enough to make the real
// import -> query -> cache pipeline behave correctly, keyed off the
// SQL text query-engine.js/database-service.js actually generate.
const mockPgQuery = jest.fn((sql, values) => {
  if (/^CREATE TABLE/i.test(sql)) return Promise.resolve({ rowCount: 0 });
  if (/^ALTER TABLE/i.test(sql)) return Promise.reject(new Error("constraint already exists"));
  if (/^INSERT INTO/i.test(sql)) {
    if (Array.isArray(values) && values.includes("FAIL_ME")) {
      return Promise.reject(new Error("null value in column violates not-null constraint"));
    }
    return Promise.resolve({ rowCount: 1 });
  }
  if (/^SELECT COUNT/i.test(sql)) return Promise.resolve({ rows: [{ count: String(SAMPLE_ROWS.length) }] });
  if (/^SELECT \*/i.test(sql)) return Promise.resolve({ rows: SAMPLE_ROWS });
  return Promise.resolve({ rows: [], rowCount: 0 });
});

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockPgConnect,
    query: mockPgQuery,
    end: mockPgEnd,
  })),
}));

// A real (if tiny) in-memory Redis so the actual query-cache.js code
// path runs end-to-end through HTTP — a cache hit in this test means
// the whole get/set/key-generation/TTL machinery genuinely worked,
// not just that a mock was told to return something.
function createFakeRedis() {
  const store = new Map();
  return {
    isReady: true,
    connect: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (key) => {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    }),
    scanIterator: jest.fn(({ MATCH } = {}) => {
      const prefix = MATCH ? MATCH.replace(/\*$/, "") : "";
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix));
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              return i < keys.length
                ? Promise.resolve({ value: keys[i++], done: false })
                : Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
    }),
  };
}

const mockFakeRedis = createFakeRedis();
jest.mock("redis", () => ({ createClient: jest.fn(() => mockFakeRedis) }));

const supertest = require("supertest");
const OPERATOR_AUTH = "Bearer maestro-test-only-operator-token";
const request = (target) => ({
  get: (path) => supertest(target).get(path).set("Authorization", OPERATOR_AUTH),
  post: (path) => supertest(target).post(path).set("Authorization", OPERATOR_AUTH),
});
const app = require("../server");

describe("full workflow: upload -> profile -> partition preview -> import -> query -> cache", () => {
  const csv = toCsv(SAMPLE_ROWS);

  test("profiles the dataset before import", async () => {
    const response = await request(app)
      .post("/profile")
      .attach("datasetFile", Buffer.from(csv), "orders.csv");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.profile.rowCount).toBe(3);
    expect(response.body.profile.columnCount).toBe(4);
    expect(response.body.profile.columns.map((c) => c.column)).toEqual(
      expect.arrayContaining(["id", "name", "age", "status"]),
    );
  });

  test("shows a partition preview before import", async () => {
    const response = await request(app)
      .post("/partition/preview")
      .attach("datasetFile", Buffer.from(csv), "orders.csv");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.plan).toBeTruthy();
    expect(Array.isArray(response.body.plan.partitions)).toBe(true);
  });

  test("imports the file and reports records imported/failed, selected database, and table name", async () => {
    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .field("collectionName", "orders")
      .attach("datasetFile", Buffer.from(csv), "orders.csv");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("imported");
    expect(response.body.data.insertedCount).toBe(3);
    expect(response.body.data.failedCount).toBe(0);
    expect(response.body.data.dbType).toBe("postgres");
    expect(response.body.data.collectionName).toBe("orders");
    expect(response.body.data.rowCount).toBe(3);
    expect(response.body.report.postgres.status).toBe("imported");
  });

  test("metadata reflects the import", async () => {
    const summary = await request(app).get("/metadata/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.totalImports).toBeGreaterThanOrEqual(1);

    const table = await request(app).get("/metadata/table");
    expect(table.status).toBe(200);
    expect(table.body.some((row) => row.type === "import" && row.status === "imported")).toBe(true);
  });

  test("queries the imported dataset (cache miss -> source: database)", async () => {
    const response = await request(app)
      .post("/v1/query")
      .send({ dataset: "orders.csv", queryType: "select", conditions: { status: "active" } });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe("success");
    expect(response.body.selectedDatabase).toBe("postgres");
    expect(response.body.source).toBe("database");
    expect(Array.isArray(response.body.results)).toBe(true);
    expect(response.body.resultCount).toBe(response.body.results.length);
  });

  // Needs a real Redis AND REDIS_URL (the app only caches then). Skipped visibly otherwise
  // instead of failing — this was the one baseline failure when no Redis was running.
  liveTest(["redis"])("repeating the identical query is served from the cache (source: cache), without hitting Postgres again", async () => {
    const callsBefore = mockPgQuery.mock.calls.length;

    const response = await request(app)
      .post("/v1/query")
      .send({ dataset: "orders.csv", queryType: "select", conditions: { status: "active" } });

    expect(response.status).toBe(200);
    expect(response.body.source).toBe("cache");
    expect(mockPgQuery.mock.calls.length).toBe(callsBefore); // no new SQL was run
  });

  test("re-importing the dataset invalidates the cache, so the next identical query hits the database again", async () => {
    await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .field("collectionName", "orders")
      .attach("datasetFile", Buffer.from(csv), "orders.csv");

    const callsBefore = mockPgQuery.mock.calls.length;

    const response = await request(app)
      .post("/v1/query")
      .send({ dataset: "orders.csv", queryType: "select", conditions: { status: "active" } });

    expect(response.body.source).toBe("database");
    expect(mockPgQuery.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test("a count query works end-to-end", async () => {
    const response = await request(app).post("/v1/query").send({ dataset: "orders.csv", queryType: "count" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("success");
    expect(response.body.resultCount).toBe(3);
    expect(response.body.results).toEqual([]);
  });
});

describe("clear error reporting", () => {
  test("invalid file: rejects a non-CSV/JSON upload with a clear message", async () => {
    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .attach("datasetFile", Buffer.from("just some text"), "notes.txt");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/csv or json/i);
  });

  test("database unavailable: a connection failure during import is reported clearly, not a 500", async () => {
    mockPgConnect.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .field("collectionName", "unreachable")
      .attach("datasetFile", Buffer.from(toCsv(SAMPLE_ROWS)), "unreachable.csv");

    expect(response.status).toBe(200); // the request itself was valid
    expect(response.body.success).toBe(false);
    expect(response.body.data.status).toBe("error");
    expect(response.body.data.message).toMatch(/ECONNREFUSED/);
  });

  test("import failure: a row that fails to insert is reported as a partial import with counts and error details", async () => {
    const rowsWithOneBadRecord = [
      { id: "1", name: "Ada", age: "36", status: "active" },
      { id: "2", name: "FAIL_ME", age: "45", status: "active" },
    ];

    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .field("collectionName", "partial_orders")
      .attach("datasetFile", Buffer.from(toCsv(rowsWithOneBadRecord)), "partial.csv");

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("partial");
    expect(response.body.data.insertedCount).toBe(1);
    expect(response.body.data.failedCount).toBe(1);
    expect(response.body.data.errors.length).toBeGreaterThan(0);
  });

  test("invalid query: a missing dataset is rejected with a clear 400", async () => {
    const response = await request(app).post("/v1/query").send({ queryType: "select" });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/dataset/i);
  });

  test("invalid query: an unsupported queryType is rejected with a clear 400", async () => {
    const response = await request(app).post("/v1/query").send({ dataset: "orders.csv", queryType: "delete" });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/queryType/i);
  });

  test("Ollama unavailable: routing/recommend still returns a usable fallback recommendation", async () => {
    // No mocking here on purpose — nothing is listening on the
    // configured Ollama host/port in this environment, so this
    // exercises the real "unreachable" code path in
    // gemini-service.js/routing-engine.js.
    const response = await request(app)
      .post("/routing/recommend")
      .send({ rows: [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }], originalName: "sample.csv" });

    expect(response.status).toBe(200);
    expect(response.body.source).toBe("fallback");
    expect(response.body.target).toBeTruthy();
    expect(response.body.reason).toMatch(/ollama is unavailable/i);
  }, 10000);
});

describe("no credentials or connection strings ever leak into a response", () => {
  test("a database-unavailable error response contains no embedded credentials", async () => {
    mockPgConnect.mockRejectedValueOnce(new Error("connect ECONNREFUSED user:s3cr3t@127.0.0.1:5432"));

    const response = await request(app)
      .post("/database/import")
      .field("dbType", "postgres")
      .field("dbName", "shop")
      .attach("datasetFile", Buffer.from(toCsv(SAMPLE_ROWS)), "creds-check.csv");

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/user:s3cr3t@/);
    expect(serialized).not.toMatch(/\w+:\/\/[^\s"]+:[^\s"]+@/);
  });

  test("/connections/status never reveals actual configured values, only ready/pending", async () => {
    const response = await request(app).get("/connections/status");
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/\w+:\/\/[^\s"]+:[^\s"]+@/);
    Object.values(response.body).forEach((entry) => {
      expect(["ready", "pending"]).toContain(entry.status);
    });
  });
});
