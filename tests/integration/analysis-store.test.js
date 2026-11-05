// Real HTTP through supertest, with pg/mongodb/@elastic/elasticsearch/
// redis mocked at the boundary (same pattern as
// tests/negative.test.js) since server.js wires them up at require
// time even though POST /analysis/store never touches any of them.
// gemini-service's callOllama is mocked too, so this suite never
// makes a real network call to a local Ollama instance.
process.env.PORT = "0";

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(),
    query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
    end: jest.fn().mockResolvedValue(),
  })),
}));

jest.mock("mongodb", () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(),
    close: jest.fn().mockResolvedValue(),
    db: jest.fn(() => ({
      createCollection: jest.fn().mockResolvedValue(),
      collection: jest.fn(() => ({ insertMany: jest.fn().mockResolvedValue({ insertedCount: 0 }) })),
    })),
  })),
}));

jest.mock("@elastic/elasticsearch", () => ({
  Client: jest.fn().mockImplementation(() => ({
    indices: { exists: jest.fn().mockResolvedValue(false), create: jest.fn().mockResolvedValue() },
    bulk: jest.fn().mockResolvedValue({ errors: false, items: [] }),
  })),
}));

jest.mock("redis", () => ({
  createClient: jest.fn().mockImplementation(() => ({
    isReady: false,
    connect: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    on: jest.fn(),
  })),
}));

jest.mock("../../gemini-service", () => {
  const actual = jest.requireActual("../../gemini-service");
  return {
    ...actual,
    callOllama: jest.fn().mockRejectedValue(new Error("Could not connect to Ollama (mocked, no real service in this test).")),
  };
});

const request = require("supertest");
const app = require("../../server");
const operatorRequest = (method, path) => request(app)[method](path)
  .set("Authorization", "Bearer maestro-test-only-operator-token");

function toCsv(rows) {
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((h) => row[h]).join(","))].join("\n");
}

describe("POST /analysis/store", () => {
  test("returns the full hybrid analysis shape for a transactional CSV", async () => {
    const rows = [
      { order_id: "A1", customer_id: "C1", amount: "100" },
      { order_id: "A2", customer_id: "C1", amount: "250" },
      { order_id: "A3", customer_id: "C2", amount: "75" },
    ];

    const response = await operatorRequest("post", "/analysis/store")
      .attach("datasetFile", Buffer.from(toCsv(rows)), "orders.csv");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.dataset).toBe("orders.csv");

    expect(response.body).toHaveProperty("metadata");
    expect(response.body).toHaveProperty("relationships");
    expect(response.body).toHaveProperty("ruleBased");
    expect(response.body).toHaveProperty("ollama");
    expect(response.body).toHaveProperty("hybrid");
    expect(response.body).toHaveProperty("warnings");

    ["postgresql", "mongodb", "elasticsearch"].forEach((store) => {
      expect(response.body.ruleBased[store]).toHaveProperty("score");
      expect(response.body.ruleBased[store]).toHaveProperty("reasons");
      expect(response.body.hybrid.scores).toHaveProperty(store);
    });

    expect(response.body.hybrid.recommendation).toBe("postgresql");
    expect(response.body.ollama.available).toBe(false);
    expect(response.body.warnings.some((warning) => /Ollama unavailable/i.test(warning))).toBe(true);
  });

  test("rejects a request with no file", async () => {
    const response = await operatorRequest("post", "/analysis/store");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  test("existing endpoints are unaffected by the new feature", async () => {
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const metadata = await operatorRequest("get", "/metadata");
    expect(metadata.status).toBe(200);

    const status = await operatorRequest("get", "/connections/status");
    expect(status.status).toBe(200);
  });
});
