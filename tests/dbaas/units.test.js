const request = require("supertest");
const keys = require("../../dbaas/api-keys");
const V = require("../../dbaas/validators");
const { ProjectCache, keyForDoc, keyForQuery } = require("../../dbaas/cache");
const { RateLimiter } = require("../../dbaas/rate-limit");
const { recommendStorage } = require("../../dbaas/intelligent-router");
const { isReservedPhysicalName } = require("../../dbaas/reserved");
const { MongoDbAdapter } = require("../../adapters/mongodb-adapter");
const { ElasticsearchAdapter } = require("../../adapters/elasticsearch-adapter");
const { PostgresAdapter } = require("../../adapters/postgres-adapter");
const { Platform } = require("../../dbaas/platform");
const { FakeRedis, FakeMongoClient, FakeEsClient } = require("./_fakes");

describe("Platform usage metric availability", () => {
  test("reports unavailable storage and document metrics instead of false zeroes", async () => {
    const mapping = { project_id: "proj_aaaaaaaaaaaa", collection: "items", db_type: "postgresql" };
    const store = {
      listMappings: jest.fn().mockResolvedValue([mapping]),
      getUsage: jest.fn().mockResolvedValue({ storage_bytes: 999 }),
      setStorageBytes: jest.fn(),
    };
    const controlPlane = {
      store,
      flushUsage: jest.fn().mockRejectedValue(new Error("temporary metrics failure")),
      publicUsage: (usage) => ({ storageBytes: usage.storage_bytes }),
      getQuotas: jest.fn().mockResolvedValue({}),
    };
    const adapter = {
      storageBytes: jest.fn().mockRejectedValue(new Error("storage metrics failure")),
      count: jest.fn().mockRejectedValue(new Error("document count failure")),
    };
    const platform = new Platform({ controlPlane, adapters: { postgresql: adapter } });

    const result = await platform.usage({ projectId: mapping.project_id });

    expect(result.usage.storageBytes).toBeNull();
    expect(result.collections[0]).toMatchObject({ storageBytes: null, documents: null });
    expect(result.warnings).toEqual(expect.arrayContaining([
      "Usage counters may be stale.",
      "Storage size unavailable for one or more collections.",
      "Document counts unavailable for one or more collections.",
    ]));
    expect(store.setStorageBytes).not.toHaveBeenCalled();
  });

  test("storage adapters reject missing measurements instead of fabricating zero bytes", async () => {
    const mapping = {
      project_id: "proj_aaaaaaaaaaaa",
      collection: "items",
      database_name: "maestro_proj_aaaaaaaaaaaa",
      physical_name: "items",
    };
    const pg = new PostgresAdapter();
    pg.pools.set(mapping.database_name, {
      query: jest.fn().mockResolvedValue({ rows: [{ n: null }] }),
    });
    const mongo = new MongoDbAdapter({
      clientFactory: () => ({
        connect: async () => {},
        db: () => ({ collection: () => ({ aggregate: () => ({ toArray: async () => [] }) }) }),
      }),
    });
    const measuredMongo = new MongoDbAdapter({
      clientFactory: () => ({
        connect: async () => {},
        db: () => ({ collection: () => ({ aggregate: () => ({
          toArray: async () => [{ storageStats: { storageSize: 12, totalIndexSize: 3 } }],
        }) }) }),
      }),
    });
    const es = new ElasticsearchAdapter({
      clientFactory: () => ({ indices: { stats: async () => ({ _all: { total: { store: {} } } }) } }),
    });
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(pg.storageBytes(mapping)).rejects.toThrow();
      await expect(mongo.storageBytes(mapping)).rejects.toThrow();
      await expect(measuredMongo.storageBytes(mapping)).resolves.toBe(15);
      await expect(es.storageBytes({
        ...mapping, physical_name: "proj_aaaaaaaaaaaa_items",
      })).rejects.toThrow();
    } finally {
      log.mockRestore();
    }
  });
});

describe("API keys", () => {
  test("format, hashing and verification", () => {
    const g = keys.generateApiKey();
    expect(g.key).toMatch(keys.KEY_FORMAT);
    expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.parseApiKey(g.key).keyId).toBe(g.keyId);
    expect(keys.verifyApiKey(g.key, g.hash)).toBe(true);
    expect(keys.verifyApiKey(`${g.key}x`, g.hash)).toBe(false);
    expect(keys.verifyApiKey(g.key, "zz")).toBe(false);
    expect(keys.verifyApiKey(g.key, undefined)).toBe(false);
    expect(g.prefix).not.toContain(g.key.slice(-10));
  });
  test("keys are unique and high-entropy", () => {
    const set = new Set(Array.from({ length: 200 }, () => keys.generateApiKey().key));
    expect(set.size).toBe(200);
  });
  test("a pepper changes the hash (and is read from the environment)", () => {
    const key = keys.generateApiKey().key;
    const plain = keys.hashApiKey(key);
    process.env.MAESTRO_KEY_PEPPER = "pepper";
    try {
      const peppered = keys.hashApiKey(key);
      expect(peppered).not.toBe(plain);
      expect(keys.verifyApiKey(key, peppered)).toBe(true);
    } finally { delete process.env.MAESTRO_KEY_PEPPER; }
  });
  test("bearer extraction", () => {
    expect(keys.extractBearer("Bearer abc")).toBe("abc");
    expect(keys.extractBearer("bearer abc")).toBe("abc");
    expect(keys.extractBearer("Bearer a b")).toBeNull();
    expect(keys.extractBearer(undefined)).toBeNull();
    expect(keys.parseApiKey("pk_short")).toBeNull();
  });
});

describe("validators", () => {
  test("normalizeFilters accepts the supported shapes only", () => {
    expect(V.normalizeFilters({ a: 1, b: { gt: 2 } })).toEqual([
      { field: "a", operator: "eq", value: 1 }, { field: "b", operator: "gt", value: 2 }]);
    expect(V.normalizeFilters(undefined)).toEqual([]);
    expect(V.normalizeFilters({ "address.city": "X" })[0].field).toBe("address.city");
    expect(() => V.normalizeFilters({ a: { $gt: 1 } })).toThrow(/operator/);
    expect(() => V.normalizeFilters({ a: [1] })).toThrow();
    expect(() => V.normalizeFilters(Array.from({ length: 25 }, (_, i) => ({ field: `f${i}`, value: 1 })))).toThrow(/Too many/);
    expect(() => V.normalizeFilters({ a: { gt: true } })).toThrow();
  });
  test("field paths", () => {
    expect(() => V.validateFieldPath("a.b.c")).not.toThrow();
    for (const bad of ["", "a..b", ".a", "a.", "1a", "a-b", "a b", "__proto__", "a.constructor", "a'b", "$a"]) {
      expect(() => V.validateFieldPath(bad)).toThrow();
    }
  });
  test("document ids", () => {
    expect(V.validateDocumentId("3f2b9a2e-1111-4222-8333-444455556666")).toBeTruthy();
    expect(V.validateDocumentId(42)).toBe("42");
    for (const bad of ["", "a/b", "../x", "a b", "x".repeat(65), null, {}]) expect(() => V.validateDocumentId(bad)).toThrow();
  });
  test("query request defaults and limits", () => {
    const q = V.validateQueryRequest({ collection: "products" });
    expect(q).toMatchObject({ queryType: "select", limit: 50, offset: 0, filters: [], sort: null });
    expect(() => V.validateQueryRequest({ collection: "products", limit: 5000 })).toThrow();
    expect(() => V.validateQueryRequest(null)).toThrow();
  });
  test("legacy `conditions` is accepted as an alias for filters", () => {
    expect(V.validateQueryRequest({ collection: "p", conditions: { a: 1 } }).filters).toHaveLength(1);
  });
});

describe("12-13. Redis cache: project-scoped keys", () => {
  const A = "proj_aaaaaaaaaaaa";
  const B = "proj_bbbbbbbbbbbb";
  const spec = { queryType: "select", filters: [{ field: "a", operator: "eq", value: 1 }], limit: 10, offset: 0, sort: null, text: null, fields: [] };

  test("every key starts with the project id", () => {
    expect(keyForDoc(A, "products", "123", "7")).toBe(`${A}:products:v7:doc:123`);
    expect(keyForQuery(A, "products", spec, "7")).toMatch(new RegExp(`^${A}:products:v7:q:[0-9a-f]{64}$`));
  });
  test("identical queries from two projects get different keys", () => {
    expect(keyForQuery(A, "products", spec)).not.toBe(keyForQuery(B, "products", spec));
    expect(keyForDoc(A, "products", "1")).not.toBe(keyForDoc(B, "products", "1"));
  });
  test("query keys are stable regardless of filter key order", () => {
    const s1 = { ...spec, filters: [{ field: "a", operator: "eq", value: 1 }] };
    const s2 = { ...spec, filters: [{ value: 1, operator: "eq", field: "a" }] };
    expect(keyForQuery(A, "p", s1)).toBe(keyForQuery(A, "p", s2));
    expect(keyForQuery(A, "p", { ...spec, limit: 11 })).not.toBe(keyForQuery(A, "p", spec));
  });
  test("refuses to build a key without a valid project id", () => {
    for (const bad of [undefined, "", "proj_1", "../x", "proj_AAAAAAAAAAAA", null]) {
      expect(() => keyForDoc(bad, "products", "1")).toThrow();
      expect(() => keyForQuery(bad, "products", spec)).toThrow();
    }
    expect(() => keyForDoc(A, "Bad Name", "1")).toThrow();
  });

  test("project A's cached entry is invisible to B; version bump invalidates only A's collection", async () => {
    const redis = new FakeRedis();
    const cache = new ProjectCache({ getClient: async () => redis, isEnabled: () => true, ttlSeconds: 5 });
    const a1 = await cache.getQuery(A, "products", spec);
    await cache.setQuery(A, "products", spec, a1.ver, { results: ["A"] });
    const b1 = await cache.getQuery(B, "products", spec);
    await cache.setQuery(B, "products", spec, b1.ver, { results: ["B"] });
    expect((await cache.getQuery(A, "products", spec)).value).toEqual({ results: ["A"] });
    expect((await cache.getQuery(B, "products", spec)).value).toEqual({ results: ["B"] });
    expect(await cache.invalidateCollection(A, "products")).toBe(1);
    expect((await cache.getQuery(A, "products", spec)).value).toBeNull();
    expect((await cache.getQuery(B, "products", spec)).value).toEqual({ results: ["B"] });
    await cache.invalidateProject(A);
    expect((await cache.getQuery(B, "products", spec)).value).not.toBeNull();
  });

  test("RACE: a result computed before a write can never be served after it", async () => {
    const redis = new FakeRedis();
    const cache = new ProjectCache({ getClient: async () => redis, isEnabled: () => true, ttlSeconds: 60 });
    const reader = await cache.getQuery(A, "products", spec); // reader sees version v, starts a slow DB read
    await cache.invalidateCollection(A, "products");          // a write lands meanwhile
    await cache.setQuery(A, "products", spec, reader.ver, { results: ["stale"] }); // reader stores its old result
    expect((await cache.getQuery(A, "products", spec)).value).toBeNull();         // later reads never see it
  });

  test("a failed version bump bypasses the cache for that collection instead of serving stale data", async () => {
    const redis = new FakeRedis();
    const cache = new ProjectCache({ getClient: async () => redis, isEnabled: () => true, ttlSeconds: 5 });
    const r = await cache.getQuery(A, "products", spec);
    await cache.setQuery(A, "products", spec, r.ver, { results: ["old"] });
    redis.incr = async () => { throw new Error("redis fault"); };
    expect(await cache.invalidateCollection(A, "products")).toBe(0);
    const after = await cache.getQuery(A, "products", spec);
    expect(after.value).toBeNull();
    expect(after.ver).toBe("");
  });

  test("REGRESSION: DEL is never issued with zero keys ('wrong number of arguments for del')", async () => {
    const redis = new FakeRedis();
    const cache = new ProjectCache({ getClient: async () => redis, isEnabled: () => true });
    expect(await cache.del([])).toBe(0);
    expect(await cache.del([""])).toBe(0);
    await cache.invalidateCollection(A, "nothing_cached");
    expect(await cache.invalidateProject(A)).toBeGreaterThanOrEqual(0);
    expect(redis.delCalls.every((c) => c.length > 0)).toBe(true);
    // and a real delete still works, in one batched DEL
    await cache.set("k1", 1); await cache.set("k2", 2);
    expect(await cache.del(["k1", "k2"])).toBe(2);
  });

  test("degrades to a no-op when Redis is disabled or failing", async () => {
    const off = new ProjectCache({ isEnabled: () => false });
    expect(await off.get("x")).toBeNull();
    expect(await off.set("x", 1)).toBe(false);
    const broken = new ProjectCache({ isEnabled: () => true, getClient: async () => { throw new Error("down"); } });
    expect(await broken.get("x")).toBeNull();
    expect(await broken.invalidateProject(A)).toBe(0);
  });
});

describe("rate limiter", () => {
  test("fixed window", () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 2 });
    rl.check("k"); rl.check("k");
    expect(() => rl.check("k")).toThrow(/Rate limit/);
    expect(() => rl.check("other")).not.toThrow();
  });
});

describe("14. intelligent-router safety layer", () => {
  const stubDown = async () => { throw new Error("down"); };
  test("rule-based fallback when Ollama is unavailable", async () => {
    const r = await recommendStorage([{ order_id: 1, customer_id: 2, product_id: 3, quantity: 1 }], "orders", { callOllamaFn: stubDown, useOllama: true });
    expect(r.dbType).toBe("postgresql");
    expect(r.source).toBe("rule-based");
  });
  test("uses the hybrid score when Ollama answers", async () => {
    const ollama = async () => JSON.stringify({ postgresql: 0, mongodb: 95, elasticsearch: 0, recommended_store: "mongodb", confidence: 95, reasons: ["nested"] });
    const r = await recommendStorage([{ student_id: "S", address: { city: "X" }, skills: ["a"] }], "students", { callOllamaFn: ollama, useOllama: true });
    expect(r.dbType).toBe("mongodb");
    expect(r.source).toMatch(/hybrid/);
  });
  test("an Ollama that hangs is abandoned after the routing timeout", async () => {
    process.env.MAESTRO_ROUTING_TIMEOUT_MS = "150";
    try {
      const t = Date.now();
      const r = await recommendStorage([{ order_id: 1, customer_id: 2, product_id: 3 }], "orders", { callOllamaFn: () => new Promise(() => {}), useOllama: true });
      expect(Date.now() - t).toBeLessThan(2000);
      expect(r.dbType).toBe("postgresql");
    } finally { delete process.env.MAESTRO_ROUTING_TIMEOUT_MS; }
  });
  test("low-confidence analyses default to PostgreSQL", async () => {
    process.env.MAESTRO_ROUTING_MIN_CONFIDENCE = "99";
    try {
      const r = await recommendStorage([{ student_id: "S", address: { city: "X" }, skills: ["a"] }], "students", { useOllama: false });
      expect(r.dbType).toBe("postgresql");
      expect(r.warnings).toContain("low_confidence");
    } finally { delete process.env.MAESTRO_ROUTING_MIN_CONFIDENCE; }
  });
});

describe("reserved physical names (legacy-route isolation guard)", () => {
  test("detects per-project and control-plane names", () => {
    expect(isReservedPhysicalName("maestro_proj_aaaaaaaaaaaa")).toBe(true);
    expect(isReservedPhysicalName("MAESTRO_PROJ_x")).toBe(true);
    expect(isReservedPhysicalName("maestro_control")).toBe(true);
    expect(isReservedPhysicalName("proj_aaaaaaaaaaaa_products")).toBe(true);
    expect(isReservedPhysicalName("my_project_db")).toBe(false);
    expect(isReservedPhysicalName("proj_data")).toBe(false);
    expect(isReservedPhysicalName(undefined)).toBe(false);
  });
});

describe("adapter query construction", () => {
  const mapping = (type, extra = {}) => ({ project_id: "proj_aaaaaaaaaaaa", collection: "products", db_type: type, ...extra });

  test("Mongo: operators come from a fixed map; field paths are prefixed with data.", () => {
    const a = new MongoDbAdapter({ clientFactory: () => new FakeMongoClient() });
    const f = a._filter({ queryType: "select", filters: [
      { field: "price", operator: "gte", value: 5 }, { field: "tag", operator: "in", value: ["a"] }, { field: "name", operator: "eq", value: "$ne" }] });
    expect(f).toEqual({ $and: [{ "data.price": { $gte: 5 } }, { "data.tag": { $in: ["a"] } }, { "data.name": "$ne" }] });
    expect(JSON.stringify(f)).not.toMatch(/\$where|\$function|\$expr/);
  });

  test("Mongo: search with explicit fields escapes regex metacharacters", () => {
    const a = new MongoDbAdapter({ clientFactory: () => new FakeMongoClient() });
    const f = a._filter({ queryType: "search", text: ".*(a+)+$", fields: ["name"], filters: [] });
    const re = f.$and[0].$or[0]["data.name"].$regex;
    expect(re.test("zzz")).toBe(false);
    expect(re.test("x.*(a+)+$y")).toBe(true);
  });

  test("Mongo adapter refuses a mapping that points outside its project database", async () => {
    const a = new MongoDbAdapter({ clientFactory: () => new FakeMongoClient() });
    await expect(a.findOne(mapping("mongodb", { database_name: "maestro_proj_bbbbbbbbbbbb", physical_name: "products" }), "1")).rejects.toThrow(/mismatch/);
    await expect(a.findOne({ project_id: "x", collection: "products", database_name: "admin", physical_name: "products" }, "1")).rejects.toThrow();
  });

  test("Elasticsearch: only fixed clause types are produced (no query_string/script)", () => {
    const a = new ElasticsearchAdapter({ clientFactory: () => new FakeEsClient() });
    const q = a._buildQuery({ queryType: "search", text: "laptop OR _exists_:x", fields: [], filters: [
      { field: "price", operator: "lt", value: 10 }, { field: "name", operator: "eq", value: "Laptop" }, { field: "name", operator: "ne", value: "x" }] });
    const text = JSON.stringify(q);
    expect(text).not.toMatch(/query_string|script|simple_query_string/);
    expect(q.bool.filter).toContainEqual({ term: { "data.name": "Laptop" } });
    expect(q.bool.filter).toContainEqual({ range: { "data.price": { lt: 10 } } });
    expect(q.bool.must_not).toContainEqual({ term: { "data.name": "x" } });
    expect(a._buildQuery({ queryType: "select", filters: [] })).toEqual({ match_all: {} });
  });

  test("Elasticsearch adapter refuses a mapping whose index is outside its project", async () => {
    const a = new ElasticsearchAdapter({ clientFactory: () => new FakeEsClient() });
    await expect(a.findOne(mapping("elasticsearch", { physical_name: "proj_bbbbbbbbbbbb_products" }), "1")).rejects.toThrow(/mismatch/);
    await expect(a.findOne(mapping("elasticsearch", { physical_name: "*" }), "1")).rejects.toThrow();
    await expect(a.findOne(mapping("elasticsearch", { physical_name: "_all" }), "1")).rejects.toThrow();
  });

  test("Elasticsearch: deep paging beyond the window is a 400", async () => {
    const es = new FakeEsClient();
    const a = new ElasticsearchAdapter({ clientFactory: () => es });
    const m = { ...mapping("elasticsearch"), physical_name: "proj_aaaaaaaaaaaa_products" };
    await a.createStorage(m);
    await expect(a.find(m, { queryType: "select", filters: [], limit: 100, offset: 9950 })).rejects.toMatchObject({ status: 400 });
  });

  test("Elasticsearch: creating an index twice is idempotent; sorts text fields on .keyword", async () => {
    const es = new FakeEsClient();
    const a = new ElasticsearchAdapter({ clientFactory: () => es });
    const m = { ...mapping("elasticsearch"), physical_name: "proj_aaaaaaaaaaaa_products" };
    await a.createStorage(m);
    await a.createStorage(m);
    await a.create(m, { id: "1", data: { name: "b", price: 1 } });
    await a.find(m, { queryType: "select", filters: [], limit: 5, offset: 0, sort: { field: "name", direction: "asc" } });
    expect(es.calls.find((c) => c.op === "search").sort[0]).toHaveProperty(["data.name"]);
  });

  test("Elasticsearch update uses a fixed, parameterised script", async () => {
    const es = new FakeEsClient();
    const a = new ElasticsearchAdapter({ clientFactory: () => es });
    const m = { ...mapping("elasticsearch"), physical_name: "proj_aaaaaaaaaaaa_products" };
    await a.createStorage(m);
    await a.create(m, { id: "1", data: { a: 1 } });
    await a.update(m, "1", { a: "x\"; ctx._source.hacked = true; \"" });
    const call = es.calls.find((c) => c.op === "update");
    expect(call.script.source).not.toContain("hacked");
    expect(call.script.params.data.a).toContain("hacked");
  });

  test("Postgres adapter refuses malformed mappings before touching SQL", async () => {
    const a = new PostgresAdapter();
    const bad = { project_id: "proj_aaaaaaaaaaaa", collection: 'x"; DROP TABLE y;--', database_name: "maestro_proj_aaaaaaaaaaaa", physical_name: "x", schema: { columns: [] } };
    await expect(a.findOne(bad, "1")).rejects.toThrow(/invalid storage mapping/);
    await expect(a.dropStorage({ ...bad, collection: "ok", project_id: "proj_x'; DROP" })).rejects.toThrow();
  });

  test("Postgres: queries bind every value as a parameter (no value text in SQL)", () => {
    const a = new PostgresAdapter();
    const m = { ...mapping("postgresql"), database_name: "maestro_proj_aaaaaaaaaaaa", physical_name: "products",
      schema: { columns: [{ field: "name", type: "text" }, { field: "price", type: "double precision" }] } };
    const params = [];
    const where = a._where(m, { queryType: "select", filters: [
      { field: "name", operator: "eq", value: "'; DROP TABLE products;--" },
      { field: "price", operator: "gt", value: 5 },
      { field: "extra", operator: "eq", value: "Robert'); --" }] }, params);
    expect(where).not.toMatch(/DROP|Robert|--/);
    expect(params).toContain("'; DROP TABLE products;--");
    expect(() => a._where(m, { filters: [{ field: "price", operator: "eq", value: "five" }] }, [])).toThrow(/number/);
    expect(() => a._where(m, { filters: [{ field: "name.sub", operator: "eq", value: "x" }] }, [])).toThrow();
  });
});

describe("server wiring (real server.js)", () => {
  const app = require("../../server");
  const operatorAuth = { Authorization: "Bearer maestro-test-only-operator-token" };
  test("legacy POST /v1/query without a key still reaches the original query engine", async () => {
    const res = await request(app).post("/v1/query").set(operatorAuth).send({});
    expect(res.status).toBe(400); // original QueryValidationError, not a 401
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeUndefined();
  });
  test("a malformed pk_ key is a 401 from the platform, with no database connection needed", async () => {
    const res = await request(app).post("/v1/query").set("Authorization", "Bearer pk_bad").send({ collection: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
  test("legacy create/import routes cannot target project-owned names", async () => {
    const created = await request(app).post("/database/create").set(operatorAuth).send({ dbType: "postgres", dbName: "maestro_proj_aaaaaaaaaaaa" });
    expect(created.status).toBe(400);
    expect(created.body.message).toMatch(/reserved/i);
    const es = await request(app).post("/database/create").set(operatorAuth).send({ dbType: "elasticsearch", dbName: "proj_aaaaaaaaaaaa_products" });
    expect(es.status).toBe(400);
    const imp = await request(app).post("/database/import").set(operatorAuth).field("dbType", "mongodb").field("dbName", "maestro_proj_aaaaaaaaaaaa")
      .field("collectionName", "products").attach("datasetFile", Buffer.from("a,b\n1,2\n"), "x.csv");
    expect(imp.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(imp.body)).toMatch(/reserved/i);
  });
  test("oversized /v1 JSON bodies get a structured 413 response", async () => {
    const res = await request(app).post("/v1/data").send({
      collection: "items", data: { value: "x".repeat(3 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });
  test("existing health route is unaffected", async () => {
    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
  });
});
