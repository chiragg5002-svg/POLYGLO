/*
 * LIVE end-to-end tests for the DBaaS layer — real PostgreSQL (control
 * plane + data), real Redis, and (when reachable) real MongoDB and
 * Elasticsearch. No mocks. Each suite soft-skips with a clear message
 * if its service isn't reachable, exactly like tests/integration/.
 *
 *   docker compose up -d postgres mongodb elasticsearch redis
 *   npm run test:live
 */
require("dotenv").config(); // same .env the server reads (PG_PASSWORD etc.)
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.QUERY_CACHE_ENABLED = "true";
process.env.MAESTRO_ROUTING_USE_OLLAMA = "false";
delete process.env.MAESTRO_ADMIN_TOKEN;

const express = require("express");
const request = require("supertest");
const { Client } = require("pg");
const { isPortOpen, isHttpReachable, announceSkip } = require("../integration/_helpers");

const PG = { host: process.env.PG_HOST || "localhost", port: Number(process.env.PG_PORT || 5432) };
const CONTROL_DB = `maestro_control_test_${Date.now()}`;
process.env.MAESTRO_CONTROL_DB = CONTROL_DB;

const { createDbaas } = require("../../dbaas");
const { PostgresControlStore } = require("../../dbaas/control-plane/postgres-store");
const queryCache = require("../../query-cache");

let up = { pg: false, redis: false, mongo: false, es: false };
let dbaas; let app; let redisClient;
const projects = [];

beforeAll(async () => {
  const redisUrl = new URL(process.env.REDIS_URL);
  const mongoUrl = new URL(process.env.MONGO_URI || "mongodb://localhost:27017");
  const [pg, redis, mongo, es] = await Promise.all([
    isPortOpen(PG.host, PG.port), isPortOpen(redisUrl.hostname, Number(redisUrl.port || 6379)),
    isPortOpen(mongoUrl.hostname, Number(mongoUrl.port || 27017)),
    isHttpReachable(process.env.ELASTICSEARCH_URL || "http://localhost:9200"),
  ]);
  up = { pg, redis, mongo, es };
  if (!pg) announceSkip("PostgreSQL", "docker compose up -d postgres");
  if (!redis) announceSkip("Redis", "docker compose up -d redis");
  if (!mongo) announceSkip("MongoDB", "docker compose up -d mongodb");
  if (!es) announceSkip("Elasticsearch", "docker compose up -d elasticsearch");
  if (pg && redis) {
    dbaas = createDbaas({ store: new PostgresControlStore() });
    app = express();
    app.use(express.json({ limit: "25mb" }));
    app.use(dbaas.router);
    app.use("/v1", dbaas.errorHandler);
    redisClient = await queryCache.getClient();
  }
}, 30000);

afterAll(async () => {
  if (!dbaas) return;
  for (const id of projects) await request(app).delete(`/v1/projects/${id}?purge=true`).catch(() => {});
  await dbaas.platform.close();
  queryCache._resetForTests();
  if (redisClient) await redisClient.quit().catch(() => {});
  const admin = new Client({ host: PG.host, port: PG.port, user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "", database: "postgres" });
  await admin.connect().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${CONTROL_DB}" WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}, 30000);

const { liveTest } = require("../helpers/live");
const live = (needs, name, fn, timeout = 30000) => liveTest(needs)(name, fn, timeout);

async function newProject(name) {
  const res = await request(app).post("/v1/projects").send({ name });
  expect(res.status).toBe(201);
  projects.push(res.body.projectId);
  return { projectId: res.body.projectId, auth: { Authorization: `Bearer ${res.body.apiKey}` }, key: res.body.apiKey };
}
const post = (p, a, b) => request(app).post(p).set(a).send(b);
const get = (p, a) => request(app).get(p).set(a);

describe("LIVE PostgreSQL + Redis", () => {
  let A; let B;

  live(["pg", "redis"], "control plane tables are created in a dedicated database and keys are hashed", async () => {
    A = await newProject("Live A");
    B = await newProject("Live B");
    const c = new Client({ host: PG.host, port: PG.port, user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "", database: CONTROL_DB });
    await c.connect();
    try {
      const tables = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name);
      expect(tables).toEqual(expect.arrayContaining(["projects", "api_keys", "collections", "storage_mappings", "usage"]));
      const k = (await c.query("SELECT * FROM api_keys WHERE project_id=$1", [A.projectId])).rows[0];
      expect(k.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(k)).not.toContain(A.key.slice(A.key.indexOf("_", 3) + 1).slice(8));
    } finally { await c.end(); }
  });

  live(["pg", "redis"], "CRITICAL: Project A sees only Laptop, Project B only Phone (real PostgreSQL)", async () => {
    await post("/v1/collections", A.auth, { name: "products", sampleData: { name: "Laptop", price: 75000 }, storageHint: "postgresql" });
    await post("/v1/collections", B.auth, { name: "products", sampleData: { name: "Phone", price: 30000 }, storageHint: "postgresql" });
    expect((await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop", price: 75000 } })).status).toBe(201);
    expect((await post("/v1/data", B.auth, { collection: "products", data: { name: "Phone", price: 30000 } })).status).toBe(201);

    const a = await get("/v1/data/products", A.auth);
    const b = await get("/v1/data/products", B.auth);
    expect(a.body.results.map((r) => r.data.name)).toEqual(["Laptop"]);
    expect(b.body.results.map((r) => r.data.name)).toEqual(["Phone"]);
    expect(JSON.stringify(b.body)).not.toContain("Laptop");

    const claim = await post("/v1/query", B.auth, { projectId: A.projectId, collection: "products" });
    expect(claim.status).toBe(403);

    // physically separate databases
    const admin = new Client({ host: PG.host, port: PG.port, user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "", database: "postgres" });
    await admin.connect();
    const dbs = (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'maestro_proj_%'")).rows.map((r) => r.datname);
    await admin.end();
    expect(dbs).toEqual(expect.arrayContaining([`maestro_${A.projectId}`, `maestro_${B.projectId}`]));
  });

  live(["pg", "redis"], "PostgreSQL CRUD, typed columns, extra fields, nested paths", async () => {
    const created = await post("/v1/data", A.auth, { collection: "products", data: { name: "Desk", price: 5000, color: "oak", dims: { w: 120 }, tags: ["office", "wood"] } });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await get(`/v1/data/products/${id}`, A.auth)).body.data).toEqual({ name: "Desk", price: 5000, color: "oak", dims: { w: 120 }, tags: ["office", "wood"] });
    const q = await post("/v1/query", A.auth, { collection: "products", filters: { price: { lte: 5000 }, "dims.w": 120, color: { in: ["oak", "pine"] } } });
    expect(q.body.results.map((r) => r.id)).toEqual([id]);
    expect((await post("/v1/data", A.auth, { collection: "products", data: { name: 5 } })).status).toBe(400);
    expect((await request(app).put(`/v1/data/products/${id}`).set(A.auth).send({ data: { name: "Desk2", price: 1 } })).body.data).toEqual({ name: "Desk2", price: 1 });
    expect((await post("/v1/query", A.auth, { collection: "products", queryType: "search", text: "desk2" })).body.resultCount).toBe(1);
    expect((await request(app).delete(`/v1/data/products/${id}`).set(A.auth)).body.deleted).toBe(true);
    expect((await post("/v1/query", A.auth, { collection: "products", filters: { name: "x' OR 1=1 --" } })).body.resultCount).toBe(0);
  });

  live(["pg", "redis"], "Redis: results are cached under project-prefixed keys and never shared", async () => {
    const body = { collection: "products", filters: { name: "Laptop" } };
    const first = await post("/v1/query", A.auth, body);
    const second = await post("/v1/query", A.auth, body);
    expect(first.body.cached).toBe(false);
    expect(second.body.cached).toBe(true);

    // B runs the identical query: must be a MISS and must return B's (empty) data
    const bRes = await post("/v1/query", B.auth, body);
    expect(bRes.body.cached).toBe(false);
    expect(bRes.body.resultCount).toBe(0);

    const aKeys = []; const bKeys = [];
    for await (const batch of redisClient.scanIterator({ MATCH: "proj_*" })) {
      for (const k of (Array.isArray(batch) ? batch : [batch])) {
        if (k.startsWith(`${A.projectId}:`)) aKeys.push(k); else if (k.startsWith(`${B.projectId}:`)) bKeys.push(k);
      }
    }
    expect(aKeys.length).toBeGreaterThan(0);
    expect(bKeys.length).toBeGreaterThan(0);
    expect(aKeys.every((k) => /^proj_[0-9a-f]{12}:(ver:products|products:v\d+:(q:[0-9a-f]{64}|doc:[A-Za-z0-9_-]+))$/.test(k))).toBe(true);
    expect(aKeys.filter((k) => bKeys.includes(k))).toEqual([]);

    // a write invalidates A's cache but not B's
    await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop", price: 1 } });
    expect((await post("/v1/query", A.auth, body)).body.cached).toBe(false);
    expect((await post("/v1/query", B.auth, body)).body.cached).toBe(true);
  });

  live(["pg", "redis"], "REGRESSION: empty-key DEL is the real Redis error; the cache never sends it", async () => {
    await expect(redisClient.del([])).rejects.toThrow(/wrong number of arguments for 'del'/);
    const { ProjectCache } = require("../../dbaas/cache");
    const cache = new ProjectCache();
    expect(await cache.del([])).toBe(0);
    await cache.invalidateCollection(A.projectId, "never_cached");
    expect(await cache.invalidateProject("proj_ffffffffffff")).toBe(0);
    const legacy = await queryCache.invalidateDataset("dataset-that-has-no-cached-keys");
    expect(legacy).toBe(0);
  });

  live(["pg", "redis"], "usage is persisted in PostgreSQL and reported per project", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const u = await get("/v1/usage", A.auth);
    expect(u.body.usage.requests).toBeGreaterThan(5);
    expect(u.body.usage.inserts).toBeGreaterThanOrEqual(3);
    expect(u.body.usage.storageBytes).toBeGreaterThan(0);
    expect(u.body.collections[0]).toMatchObject({ name: "products", dbType: "postgresql" });
    const ub = await get("/v1/usage", B.auth);
    expect(ub.body.usage.inserts).toBe(1);
  });

  live(["pg", "redis"], "state survives a restart (new platform instance, same control database)", async () => {
    const second = createDbaas({ store: new PostgresControlStore() });
    const app2 = express();
    app2.use(express.json());
    app2.use(second.router);
    app2.use("/v1", second.errorHandler);
    const res = await request(app2).get("/v1/data/products").set(A.auth);
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    await second.platform.close();
  });

  live(["pg", "redis"], "concurrent first inserts create the collection exactly once", async () => {
    const P = await newProject("Race");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post("/v1/data", P.auth, { collection: "events", data: { order_id: i, customer_id: 1, product_id: 2, quantity: 1 } })));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect((await get("/v1/collections", P.auth)).body.collections).toHaveLength(1);
    expect((await post("/v1/query", P.auth, { collection: "events", queryType: "count" })).body.resultCount).toBe(8);
  });

  live(["pg", "redis"], "intelligent routing picks the expected store for the spec examples", async () => {
    const P = await newProject("Routing");
    const order = await post("/v1/collections", P.auth, { name: "orders", sampleData: { order_id: 1001, customer_id: 25, product_id: 50, quantity: 2 } });
    expect(order.body.storage.dbType).toBe("postgresql");
    if (up.mongo) {
      const student = await post("/v1/collections", P.auth, { name: "students", sampleData: { student_id: "STU001", address: { city: "Bengaluru" }, skills: ["Python", "AI"] } });
      expect(student.body.storage.dbType).toBe("mongodb");
    }
  });

  live(["pg", "redis"], "purge removes the project's PostgreSQL database", async () => {
    const P = await newProject("Purge");
    await post("/v1/data", P.auth, { collection: "things", data: { a: 1 } });
    const del = await request(app).delete(`/v1/projects/${P.projectId}?purge=true`);
    expect(del.body.dataPurged).toBe(true);
    const admin = new Client({ host: PG.host, port: PG.port, user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "", database: "postgres" });
    await admin.connect();
    const left = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [`maestro_${P.projectId}`]);
    await admin.end();
    expect(left.rowCount).toBe(0);
    expect((await get("/v1/project", P.auth)).status).toBe(401);
  });
});

describe("LIVE MongoDB (skips when not reachable)", () => {
  live(["pg", "redis", "mongo"], "insert/query/update/delete + project isolation on real MongoDB", async () => {
    const A = await newProject("Mongo A"); const B = await newProject("Mongo B");
    for (const [P, name] of [[A, "A-student"], [B, "B-student"]]) {
      await post("/v1/collections", P.auth, { name: "students", sampleData: { student_id: "S", address: { city: "X" }, skills: ["a"] }, storageHint: "mongodb" });
      const r = await post("/v1/data", P.auth, { collection: "students", data: { student_id: name, address: { city: "Bengaluru" }, skills: ["Python", "AI"] } });
      expect(r.status).toBe(201);
    }
    expect((await get("/v1/data/students", A.auth)).body.results.map((r) => r.data.student_id)).toEqual(["A-student"]);
    expect((await get("/v1/data/students", B.auth)).body.results.map((r) => r.data.student_id)).toEqual(["B-student"]);
    const q = await post("/v1/query", A.auth, { collection: "students", filters: { "address.city": "Bengaluru", skills: "AI" } });
    expect(q.body.resultCount).toBe(1);
    const id = q.body.results[0].id;
    expect((await request(app).put(`/v1/data/students/${id}`).set(A.auth).send({ data: { student_id: "A2" } })).body.data.student_id).toBe("A2");
    // unscoped $text search needs real MongoDB's wildcard text index (not available on FerretDB)
    const searchBody = process.env.MONGO_COMPAT_ONLY === "1" ? { text: "A2", fields: ["student_id"] } : { text: "A2" };
    expect((await post("/v1/query", A.auth, { collection: "students", queryType: "search", ...searchBody })).body.resultCount).toBe(1);
    expect((await request(app).delete(`/v1/data/students/${id}`).set(A.auth)).body.deleted).toBe(true);
  });
});

describe("LIVE Elasticsearch (skips when not reachable)", () => {
  live(["pg", "redis", "es"], "index creation, insert, search, filters, update, delete + isolation on real Elasticsearch", async () => {
    const A = await newProject("ES A"); const B = await newProject("ES B");
    for (const P of [A, B]) await post("/v1/collections", P.auth, { name: "articles", sampleData: { title: "x", body: "y" }, storageHint: "elasticsearch" });
    await post("/v1/data", A.auth, { collection: "articles", data: { title: "Cooking rice", body: "Rice is a staple food", views: 10 } });
    await post("/v1/data", A.auth, { collection: "articles", data: { title: "Gardening", body: "Plant tomatoes", views: 50 } });
    await post("/v1/data", B.auth, { collection: "articles", data: { title: "Secret B article", body: "private", views: 1 } });
    const s = await post("/v1/query", A.auth, { collection: "articles", queryType: "search", text: "rice" });
    expect(s.body.results.map((r) => r.data.title)).toEqual(["Cooking rice"]);
    expect((await post("/v1/query", A.auth, { collection: "articles", queryType: "search", text: "private" })).body.resultCount).toBe(0);
    const f = await post("/v1/query", A.auth, { collection: "articles", filters: { views: { gte: 20 } }, sort: "-views" });
    expect(f.body.results.map((r) => r.data.title)).toEqual(["Gardening"]);
    expect((await post("/v1/query", A.auth, { collection: "articles", filters: { title: "Gardening" } })).body.resultCount).toBe(1);
    expect((await post("/v1/query", A.auth, { collection: "articles", queryType: "count" })).body.resultCount).toBe(2);
    expect((await post("/v1/query", B.auth, { collection: "articles", queryType: "count" })).body.resultCount).toBe(1);
    const id = f.body.results[0].id;
    expect((await request(app).put(`/v1/data/articles/${id}`).set(A.auth).send({ data: { title: "Gardening 2", views: 51 } })).body.data.title).toBe("Gardening 2");
    expect((await request(app).delete(`/v1/data/articles/${id}`).set(A.auth)).body.deleted).toBe(true);
    expect((await get(`/v1/data/articles/${id}`, B.auth)).status).toBe(404);
  });
});
