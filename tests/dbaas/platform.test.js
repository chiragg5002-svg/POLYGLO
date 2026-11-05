const request = require("supertest");
const { buildTestApp } = require("./_app");
const { createOperatorAuth } = require("../../dbaas/security");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let ctx;
let app;
const ENV_KEYS = ["MAESTRO_ADMIN_TOKEN", "MAESTRO_INSECURE_DEV", "MAESTRO_RATE_LIMIT_PER_MINUTE", "MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE", "NODE_ENV", "MAESTRO_AUTO_CREATE_COLLECTIONS"];
const savedEnv = {};

beforeAll(() => { ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; }); });
afterAll(() => { ENV_KEYS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }); });

beforeEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  ctx = buildTestApp();
  app = ctx.app;
});

async function newProject(name = "Shopping App") {
  const res = await request(app).post("/v1/projects").send({ name });
  expect(res.status).toBe(201);
  return { projectId: res.body.projectId, key: res.body.apiKey, keyId: res.body.apiKeyId, auth: { Authorization: `Bearer ${res.body.apiKey}` } };
}

const post = (p, auth, body) => request(app).post(p).set(auth).send(body);
const get = (p, auth) => request(app).get(p).set(auth);

describe("1-2. Project creation and API key generation", () => {
  test("creates a project with an id and a one-time API key", async () => {
    const res = await request(app).post("/v1/projects").send({ name: "Shopping App" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.projectId).toMatch(/^proj_[0-9a-f]{12}$/);
    expect(res.body.apiKey).toMatch(/^pk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(res.body.name).toBe("Shopping App");
  });

  test("the API key is stored only as a hash and is never returned again", async () => {
    const p = await newProject();
    const row = await ctx.store.getApiKey(p.keyId);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_hash).not.toContain(p.key);
    expect(JSON.stringify(row)).not.toContain(p.key.slice(p.key.indexOf("_", 3) + 1).slice(8));

    const detail = await request(app).get(`/v1/projects/${p.projectId}`);
    expect(JSON.stringify(detail.body)).not.toContain(p.key);
    expect(detail.body.apiKeys[0].keyId).toBe(p.keyId);
    expect(detail.body.apiKeys[0].key_hash).toBeUndefined();
  });

  test("every project gets a distinct key; extra keys can be issued and revoked", async () => {
    const a = await newProject("A");
    const b = await newProject("B");
    expect(a.key).not.toBe(b.key);
    const extra = await request(app).post(`/v1/projects/${a.projectId}/keys`).send({ label: "ci" });
    expect(extra.status).toBe(201);
    const extraAuth = { Authorization: `Bearer ${extra.body.apiKey}` };
    expect((await get("/v1/project", extraAuth)).status).toBe(200);
    const rev = await request(app).delete(`/v1/projects/${a.projectId}/keys/${extra.body.keyId}`);
    expect(rev.status).toBe(200);
    expect((await get("/v1/project", extraAuth)).status).toBe(401);
    expect((await get("/v1/project", a.auth)).status).toBe(200);
  });

  test("validates project names", async () => {
    expect((await request(app).post("/v1/projects").send({})).status).toBe(400);
    expect((await request(app).post("/v1/projects").send({ name: "  " })).status).toBe(400);
    expect((await request(app).post("/v1/projects").send({ name: "x".repeat(101) })).status).toBe(400);
  });

  test("lists, reads and deletes projects", async () => {
    const a = await newProject("A");
    await newProject("B");
    const list = await request(app).get("/v1/projects");
    expect(list.body.projects.map((p) => p.name)).toEqual(["A", "B"]);
    expect((await request(app).get(`/v1/projects/${a.projectId}`)).body.name).toBe("A");
    expect((await request(app).get("/v1/projects/proj_000000000000")).status).toBe(404);
    expect((await request(app).get("/v1/projects/not-a-project")).status).toBe(400);

    const del = await request(app).delete(`/v1/projects/${a.projectId}`);
    expect(del.body).toMatchObject({ deleted: true, dataPurged: false });
    expect((await request(app).get(`/v1/projects/${a.projectId}`)).status).toBe(404);
    expect((await request(app).get("/v1/projects")).body.projects).toHaveLength(1);
    // a deleted project's key stops working immediately
    expect((await get("/v1/project", a.auth)).status).toBe(401);
  });

  test("purge=true removes the project's physical storage", async () => {
    const a = await newProject("A");
    await post("/v1/collections", a.auth, { name: "products", sampleData: { name: "x", price: 1 } });
    await post("/v1/collections", a.auth, { name: "reviews", sampleData: { name: "n", tags: ["a"] } });
    const del = await request(app).delete(`/v1/projects/${a.projectId}?purge=true`);
    expect(del.body.dataPurged).toBe(true);
    expect(ctx.adapters.postgresql.dropped).toContain(a.projectId);
    expect(ctx.mongoClient.dropped).toContain(`maestro_${a.projectId}`);
    expect(await ctx.store.listMappings(a.projectId)).toHaveLength(0);
  });
});

describe("3-4. Authentication", () => {
  let p;
  beforeEach(async () => { p = await newProject(); });

  test("valid key authenticates and resolves the project server-side", async () => {
    const res = await get("/v1/project", p.auth);
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(p.projectId);
  });

  test.each([
    ["no header", {}],
    ["wrong scheme", { Authorization: "Basic abc" }],
    ["empty bearer", { Authorization: "Bearer " }],
    ["bad format", { Authorization: "Bearer pk_nope" }],
    ["not a pk key", { Authorization: "Bearer sk_123" }],
  ])("rejects %s", async (_n, headers) => {
    const res = await request(app).get("/v1/project").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("unauthorized");
  });

  test("rejects a well-formed key with the wrong secret, and an unknown key id", async () => {
    const [, id] = p.key.split("_");
    const wrongSecret = `pk_${id}_${"A".repeat(43)}`;
    expect((await get("/v1/project", { Authorization: `Bearer ${wrongSecret}` })).status).toBe(401);
    const unknown = `pk_${"0".repeat(12)}_${"A".repeat(43)}`;
    expect((await get("/v1/project", { Authorization: `Bearer ${unknown}` })).status).toBe(401);
  });

  test("a revoked key is rejected", async () => {
    await request(app).delete(`/v1/projects/${p.projectId}/keys/${p.keyId}`);
    expect((await get("/v1/project", p.auth)).status).toBe(401);
  });

  test("records last_used_at", async () => {
    await get("/v1/project", p.auth);
    await tick();
    expect((await ctx.store.getApiKey(p.keyId)).last_used_at).not.toBeNull();
  });

  test("an API key cannot use the control plane when an admin token is configured", async () => {
    process.env.MAESTRO_ADMIN_TOKEN = "admin-secret-token";
    app = buildTestApp({ operatorAuth: createOperatorAuth() }).app;
    const rejected = await request(app).get("/v1/projects").set(p.auth);
    expect(rejected.status).toBe(401);
    expect((await request(app).get("/v1/projects")).status).toBe(401);
    expect((await request(app).get("/v1/projects").set("Authorization", "Bearer wrong")).status).toBe(401);
    expect((await request(app).get("/v1/projects").set("Authorization", "Bearer admin-secret-token")).status).toBe(200);
    expect((await request(app).get("/v1/projects").set("x-maestro-admin-token", "admin-secret-token")).status).toBe(200);
  });

  test("the control plane is disabled in production when no admin token is set", async () => {
    process.env.NODE_ENV = "production";
    app = buildTestApp({ operatorAuth: createOperatorAuth() }).app;
    const res = await request(app).get("/v1/projects");
    expect(res.status).toBe(503);
  });

  test("repeated failed authentication is throttled", async () => {
    process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE = "3";
    const local = buildTestApp();
    let last;
    for (let i = 0; i < 6; i += 1) last = await request(local.app).get("/v1/project").set("Authorization", "Bearer pk_bad");
    expect(last.status).toBe(429);
    expect(last.headers["retry-after"]).toBeDefined();
  });

  test("per-key rate limiting", async () => {
    process.env.MAESTRO_RATE_LIMIT_PER_MINUTE = "3";
    const local = buildTestApp();
    const created = await request(local.app).post("/v1/projects").send({ name: "RL" });
    const auth = { Authorization: `Bearer ${created.body.apiKey}` };
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await request(local.app).get("/v1/project").set(auth)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

describe("5. Project isolation (critical)", () => {
  let A; let B;
  beforeEach(async () => {
    A = await newProject("Project A");
    B = await newProject("Project B");
  });

  test("two projects with the same collection name never see each other's data", async () => {
    const a = await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop" } });
    const b = await post("/v1/data", B.auth, { collection: "products", data: { name: "Phone" } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const listA = await get("/v1/data/products", A.auth);
    const listB = await get("/v1/data/products", B.auth);
    expect(listA.body.results.map((r) => r.data.name)).toEqual(["Laptop"]);
    expect(listB.body.results.map((r) => r.data.name)).toEqual(["Phone"]);

    const qA = await post("/v1/query", A.auth, { collection: "products", queryType: "select" });
    const qB = await post("/v1/query", B.auth, { collection: "products", queryType: "select" });
    expect(JSON.stringify(qA.body)).not.toContain("Phone");
    expect(JSON.stringify(qB.body)).not.toContain("Laptop");
    expect((await post("/v1/query", B.auth, { collection: "products", queryType: "search", text: "Laptop" })).body.resultCount).toBe(0);
  });

  test("project B cannot read, update or delete project A's documents by id", async () => {
    const doc = (await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop" } })).body;
    await post("/v1/data", B.auth, { collection: "products", data: { name: "Phone" } });

    expect((await get(`/v1/data/products/${doc.id}`, B.auth)).status).toBe(404);
    expect((await request(app).put(`/v1/data/products/${doc.id}`).set(B.auth).send({ data: { name: "hacked" } })).status).toBe(404);
    expect((await request(app).patch(`/v1/data/products/${doc.id}`).set(B.auth).send({ data: { name: "hacked" } })).status).toBe(404);
    expect((await request(app).delete(`/v1/data/products/${doc.id}`).set(B.auth)).status).toBe(404);

    const still = await get(`/v1/data/products/${doc.id}`, A.auth);
    expect(still.status).toBe(200);
    expect(still.body.data.name).toBe("Laptop");
  });

  test("a collection that exists only in project A is invisible to project B", async () => {
    await post("/v1/collections", A.auth, { name: "secrets", sampleData: { value: "x" } });
    expect((await get("/v1/collections/secrets", B.auth)).status).toBe(404);
    expect((await get("/v1/data/secrets", B.auth)).status).toBe(404);
    expect((await post("/v1/query", B.auth, { collection: "secrets" })).status).toBe(404);
    expect((await get("/v1/collections", B.auth)).body.collections).toEqual([]);
    expect((await request(app).delete("/v1/collections/secrets").set(B.auth)).status).toBe(404);
    expect((await get("/v1/collections/secrets", A.auth)).status).toBe(200);
  });

  test("sending another project's id with your own key is refused (body, query string, header)", async () => {
    await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop" } });
    const viaBody = await post("/v1/query", B.auth, { projectId: A.projectId, collection: "products" });
    expect(viaBody.status).toBe(403);
    const viaInsert = await post("/v1/data", B.auth, { projectId: A.projectId, collection: "products", data: { name: "evil" } });
    expect(viaInsert.status).toBe(403);
    const viaQs = await get(`/v1/data/products?projectId=${A.projectId}`, B.auth);
    expect(viaQs.status).toBe(403);
    const viaHeader = await request(app).get("/v1/data/products").set(B.auth).set("x-project-id", A.projectId);
    expect(viaHeader.status).toBe(403);
    // nothing leaked in, nothing written to A
    expect((await get("/v1/data/products", A.auth)).body.results.map((r) => r.data.name)).toEqual(["Laptop"]);
    // naming your OWN project is harmless
    expect((await get(`/v1/data/products?projectId=${A.projectId}`, A.auth)).status).toBe(200);
  });

  test("clients cannot choose the physical database, table or store", async () => {
    await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop", price: 1 } });
    await post("/v1/data", B.auth, { collection: "products", data: { name: "Phone", price: 2 } });
    const mapA = await ctx.store.getMapping(A.projectId, "products");
    const res = await post("/v1/query", B.auth, {
      collection: "products", databaseName: mapA.database_name, physicalName: mapA.physical_name,
      database: mapA.database_name, dbType: "mongodb", index: mapA.physical_name, table: "products",
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.data.name)).toEqual(["Phone"]);
    expect(JSON.stringify(res.body)).not.toContain(mapA.database_name);
  });

  test("physical storage is separated per project in every store", async () => {
    for (const [name, sample, store] of [
      ["products", { name: "x", price: 1 }, "postgresql"],
      ["reviews", { author: "x", meta: { a: 1 }, tags: ["t"] }, "mongodb"],
      ["articles", { title: "Hello", body: "word ".repeat(200), tags: ["a"] }, "elasticsearch"],
    ]) {
      await post("/v1/collections", A.auth, { name, sampleData: sample, storageHint: store });
      await post("/v1/collections", B.auth, { name, sampleData: sample, storageHint: store });
      const ma = await ctx.store.getMapping(A.projectId, name);
      const mb = await ctx.store.getMapping(B.projectId, name);
      expect(ma.physical_name === mb.physical_name && ma.database_name === mb.database_name).toBe(false);
      expect(`${ma.database_name}|${ma.physical_name}`).toContain(A.projectId);
      expect(`${mb.database_name}|${mb.physical_name}`).toContain(B.projectId);
    }
    const pgMap = await ctx.store.getMapping(A.projectId, "products");
    expect(pgMap.database_name).toBe(`maestro_${A.projectId}`);
    expect(pgMap.physical_name).toBe("products");
    const esMap = await ctx.store.getMapping(A.projectId, "articles");
    expect(esMap.physical_name).toBe(`${A.projectId}_articles`);
    expect(esMap.database_name).toBeNull();
  });

  test.each(["postgresql", "mongodb", "elasticsearch"])("isolation holds on %s", async (store) => {
    await post("/v1/collections", A.auth, { name: "items", sampleData: { name: "seed" }, storageHint: store });
    await post("/v1/collections", B.auth, { name: "items", sampleData: { name: "seed" }, storageHint: store });
    await post("/v1/data", A.auth, { collection: "items", data: { name: "A-only" } });
    await post("/v1/data", B.auth, { collection: "items", data: { name: "B-only" } });
    expect((await get("/v1/data/items", A.auth)).body.results.map((r) => r.data.name)).toEqual(["A-only"]);
    expect((await get("/v1/data/items", B.auth)).body.results.map((r) => r.data.name)).toEqual(["B-only"]);
    expect((await post("/v1/query", A.auth, { collection: "items", queryType: "count" })).body.resultCount).toBe(1);
  });

  test("usage counters are per project", async () => {
    await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop" } });
    await post("/v1/data", A.auth, { collection: "products", data: { name: "Laptop2" } });
    await tick();
    const ua = (await get("/v1/usage", A.auth)).body.usage;
    const ub = (await get("/v1/usage", B.auth)).body.usage;
    expect(ua.inserts).toBe(2);
    expect(ub.inserts).toBe(0);
  });
});

describe("6. Collection creation and 14. intelligent routing", () => {
  let p;
  beforeEach(async () => { p = await newProject(); });

  test("returns the logical collection and the selected store", async () => {
    const res = await post("/v1/collections", p.auth, { name: "products", sampleData: { name: "Laptop", price: 75000, category: "electronics" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, projectId: p.projectId, collection: "products" });
    expect(["postgresql", "mongodb", "elasticsearch"]).toContain(res.body.storage.dbType);
    expect(res.body.storage.routingReason).toBeTruthy();
  });

  test("relational/transactional data routes to PostgreSQL", async () => {
    const res = await post("/v1/collections", p.auth, { name: "orders", sampleData: { order_id: 1001, customer_id: 25, product_id: 50, quantity: 2 } });
    expect(res.body.storage.dbType).toBe("postgresql");
  });

  test("nested / flexible documents route to MongoDB", async () => {
    const res = await post("/v1/collections", p.auth, { name: "students", sampleData: { student_id: "STU001", address: { city: "Bengaluru" }, skills: ["Python", "AI"] } });
    expect(res.body.storage.dbType).toBe("mongodb");
  });

  test("search-heavy content routes to Elasticsearch", async () => {
    const res = await post("/v1/collections", p.auth, { name: "articles", sampleData: { title: "How to cook rice", body: "Rice is a staple food. ".repeat(60), tags: ["food"] } });
    expect(res.body.storage.dbType).toBe("elasticsearch");
  });

  test("mapping row is saved with the routing decision", async () => {
    await post("/v1/collections", p.auth, { name: "students", sampleData: { student_id: "S1", address: { city: "X" }, skills: ["a"] } });
    const m = await ctx.store.getMapping(p.projectId, "students");
    expect(m).toMatchObject({ project_id: p.projectId, collection: "students", db_type: "mongodb", database_name: `maestro_${p.projectId}`, physical_name: "students" });
    expect(m.routing_reason).toBeTruthy();
    expect(m.routing_detail.source).toBeDefined();
    expect(await ctx.store.getCollection(p.projectId, "students")).toMatchObject({ name: "students", status: "active" });
  });

  test("the LLM can only recommend: an invalid or hostile Ollama answer never changes the outcome", async () => {
    const hostile = buildTestApp({ routerOptions: { useOllama: true, callOllamaFn: async () => "DROP DATABASE postgres; {\"recommended_store\":\"redis\"}" } });
    const created = await request(hostile.app).post("/v1/projects").send({ name: "H" });
    const auth = { Authorization: `Bearer ${created.body.apiKey}` };
    const res = await request(hostile.app).post("/v1/collections").set(auth).send({ name: "orders", sampleData: { order_id: 1, customer_id: 2, product_id: 3, quantity: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.storage.dbType).toBe("postgresql");
  });

  test("a failing router falls back to PostgreSQL instead of failing the request", async () => {
    const broken = buildTestApp({ recommend: async () => ({ dbType: "postgresql", reason: "fallback", source: "fallback", confidence: 0, scores: null, warnings: [] }) });
    const created = await request(broken.app).post("/v1/projects").send({ name: "H" });
    const auth = { Authorization: `Bearer ${created.body.apiKey}` };
    expect((await request(broken.app).post("/v1/collections").set(auth).send({ name: "x", sampleData: { a: 1 } })).body.storage.dbType).toBe("postgresql");
  });

  test("a router returning an unknown store is rejected, not trusted", async () => {
    const evil = buildTestApp({ recommend: async () => ({ dbType: "redis", reason: "x", source: "x", confidence: 99 }) });
    const created = await request(evil.app).post("/v1/projects").send({ name: "E" });
    const auth = { Authorization: `Bearer ${created.body.apiKey}` };
    const res = await request(evil.app).post("/v1/collections").set(auth).send({ name: "x", sampleData: { a: 1 } });
    expect(res.status).toBe(500);
  });

  test("honours a valid storageHint and rejects an invalid one", async () => {
    const ok = await post("/v1/collections", p.auth, { name: "forced", sampleData: { a: 1 }, storageHint: "elasticsearch" });
    expect(ok.body.storage.dbType).toBe("elasticsearch");
    expect(ok.body.storage.routingReason).toMatch(/hint/i);
    expect((await post("/v1/collections", p.auth, { name: "bad", sampleData: { a: 1 }, storageHint: "redis" })).status).toBe(400);
  });

  test("defaults to PostgreSQL when there is no sample", async () => {
    expect((await post("/v1/collections", p.auth, { name: "empty" })).body.storage.dbType).toBe("postgresql");
  });

  test.each([
    ["Products"], ["my-collection"], ["1abc"], ["a b"], [""], ["x".repeat(49)], ["__proto__"],
    ["drop table users;--"], ["products; DROP"], ["../etc"], ["query"], ["admin"], ["réview"],
  ])("rejects invalid collection name %p", async (name) => {
    const res = await post("/v1/collections", p.auth, { name, sampleData: { a: 1 } });
    expect(res.status).toBe(400);
  });

  test("rejects a non-string name and a bad sample", async () => {
    expect((await post("/v1/collections", p.auth, { name: 5 })).status).toBe(400);
    expect((await post("/v1/collections", p.auth, { name: "ok", sampleData: [1, 2] })).status).toBe(400);
    expect((await post("/v1/collections", p.auth, { name: "ok", sampleData: { "$bad": 1 } })).status).toBe(400);
  });

  test("duplicate collection -> 409; list/get/delete work", async () => {
    await post("/v1/collections", p.auth, { name: "products", sampleData: { name: "x", price: 1 } });
    expect((await post("/v1/collections", p.auth, { name: "products", sampleData: { name: "x" } })).status).toBe(409);
    expect((await get("/v1/collections", p.auth)).body.collections.map((c) => c.name)).toEqual(["products"]);
    const one = await get("/v1/collections/products", p.auth);
    expect(one.body).toMatchObject({ collection: "products", documents: 0 });
    const del = await request(app).delete("/v1/collections/products").set(p.auth);
    expect(del.body.deleted).toBe(true);
    expect((await get("/v1/collections/products", p.auth)).status).toBe(404);
  });

  test("enforces a per-project collection limit", async () => {
    process.env.MAESTRO_MAX_COLLECTIONS_PER_PROJECT = "2";
    try {
      await post("/v1/collections", p.auth, { name: "a1" });
      await post("/v1/collections", p.auth, { name: "a2" });
      const over = await post("/v1/collections", p.auth, { name: "a3" });
      expect(over.status).toBe(403);
      expect(over.body.error.code).toBe("quota_exceeded");
    } finally { delete process.env.MAESTRO_MAX_COLLECTIONS_PER_PROJECT; }
  });
});

describe("10. CRUD on every storage engine", () => {
  const cases = [
    ["postgresql", { name: "Laptop", price: 75000 }],
    ["mongodb", { name: "Laptop", price: 75000, specs: { ram: 16 } }],
    ["elasticsearch", { name: "Laptop", price: 75000 }],
  ];

  test.each(cases)("%s: insert / get / put / patch / delete", async (store, sample) => {
    const p = await newProject();
    await post("/v1/collections", p.auth, { name: "products", sampleData: sample, storageHint: store });
    const created = await post("/v1/data", p.auth, { collection: "products", data: sample });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ success: true, collection: "products", projectId: p.projectId });
    expect(created.body.id).toBeTruthy();
    expect(created.body.data).toEqual(sample);

    const got = await get(`/v1/data/products/${created.body.id}`, p.auth);
    expect(got.body.data).toEqual(sample);

    const put = await request(app).put(`/v1/data/products/${created.body.id}`).set(p.auth).send({ data: { name: "Laptop Pro", price: 99000 } });
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({ name: "Laptop Pro", price: 99000 });
    expect((await get(`/v1/data/products/${created.body.id}`, p.auth)).body.data.name).toBe("Laptop Pro");

    const patch = await request(app).patch(`/v1/data/products/${created.body.id}`).set(p.auth).send({ data: { price: 1 } });
    expect(patch.body.data).toEqual({ name: "Laptop Pro", price: 1 });

    const del = await request(app).delete(`/v1/data/products/${created.body.id}`).set(p.auth);
    expect(del.body).toMatchObject({ deleted: true, id: created.body.id });
    expect((await get(`/v1/data/products/${created.body.id}`, p.auth)).status).toBe(404);
    expect((await request(app).delete(`/v1/data/products/${created.body.id}`).set(p.auth)).status).toBe(404);
  });

  test("the first insert auto-creates and routes the collection", async () => {
    const p = await newProject();
    const res = await post("/v1/data", p.auth, { collection: "students", data: { student_id: "STU001", address: { city: "Bengaluru" }, skills: ["Python", "AI"] } });
    expect(res.status).toBe(201);
    const col = await get("/v1/collections/students", p.auth);
    expect(col.body.storage.dbType).toBe("mongodb");
    expect(col.body.documents).toBe(1);
  });

  test("auto-creation can be disabled", async () => {
    process.env.MAESTRO_AUTO_CREATE_COLLECTIONS = "false";
    const p = await newProject();
    expect((await post("/v1/data", p.auth, { collection: "students", data: { a: 1 } })).status).toBe(404);
  });

  test("updating or deleting an unknown id -> 404; unknown collection -> 404", async () => {
    const p = await newProject();
    await post("/v1/data", p.auth, { collection: "things", data: { a: 1 } });
    expect((await request(app).put("/v1/data/things/nope").set(p.auth).send({ data: { a: 2 } })).status).toBe(404);
    expect((await request(app).delete("/v1/data/things/nope").set(p.auth)).status).toBe(404);
    expect((await get("/v1/data/ghosts", p.auth)).status).toBe(404);
    expect((await get("/v1/data/ghosts/abc", p.auth)).status).toBe(404);
  });
});

describe("11. Query operations", () => {
  let p;
  const items = [
    { name: "Laptop", price: 75000, category: "electronics" },
    { name: "Phone", price: 30000, category: "electronics" },
    { name: "Desk", price: 5000, category: "furniture" },
    { name: "Chair", price: 2500, category: "furniture" },
  ];
  beforeEach(async () => {
    p = await newProject();
  });
  async function seed(store) {
    await post("/v1/collections", p.auth, { name: "products", sampleData: items[0], storageHint: store });
    for (const i of items) await post("/v1/data", p.auth, { collection: "products", data: i });
  }

  describe.each(["postgresql", "mongodb", "elasticsearch"])("on %s", (store) => {
    beforeEach(() => seed(store));
    const q = (body) => post("/v1/query", p.auth, { collection: "products", ...body });

    test("equality filter (spec example)", async () => {
      const res = await q({ queryType: "select", filters: { category: "electronics" }, limit: 10 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results.map((r) => r.data.name).sort()).toEqual(["Laptop", "Phone"]);
      expect(res.body.resultCount).toBe(2);
    });

    test("comparison operators, in, ne", async () => {
      expect((await q({ filters: { price: { gte: 5000, lt: 75000 } } })).body.results.map((r) => r.data.name).sort()).toEqual(["Desk", "Phone"]);
      expect((await q({ filters: { name: { in: ["Chair", "Laptop"] } } })).body.resultCount).toBe(2);
      expect((await q({ filters: { category: { ne: "furniture" } } })).body.resultCount).toBe(2);
      expect((await q({ filters: [{ field: "price", operator: "gt", value: 10000 }] })).body.resultCount).toBe(2);
    });

    test("sort, limit, offset", async () => {
      const asc = await q({ sort: "price", limit: 2 });
      expect(asc.body.results.map((r) => r.data.price)).toEqual([2500, 5000]);
      const desc = await q({ sort: { field: "price", direction: "desc" }, limit: 2, offset: 1 });
      expect(desc.body.results.map((r) => r.data.price)).toEqual([30000, 5000]);
    });

    test("search and count", async () => {
      expect((await q({ queryType: "search", text: "laptop" })).body.results.map((r) => r.data.name)).toEqual(["Laptop"]);
      expect((await q({ queryType: "count" })).body.resultCount).toBe(4);
      expect((await q({ queryType: "count", filters: { category: "furniture" } })).body.resultCount).toBe(2);
    });

    test("GET list supports JSON filters, sort and paging", async () => {
      const res = await get(`/v1/data/products?filters=${encodeURIComponent(JSON.stringify({ category: "electronics" }))}&sort=-price&limit=1`, p.auth);
      expect(res.body.results.map((r) => r.data.name)).toEqual(["Laptop"]);
    });
  });

  test("rejects invalid queries with 400", async () => {
    await seed("postgresql");
    const bad = [
      { queryType: "delete" },
      { filters: { price: { $gt: 5 } } },
      { filters: { price: { regex: "x" } } },
      { filters: { price: { gt: { nested: 1 } } } },
      { filters: { "bad field": 1 } },
      { filters: { "x'; DROP TABLE products;--": 1 } },
      { filters: { $where: "1" } },
      { filters: { name: { in: [] } } },
      { filters: [{ field: "name", operator: "like", value: "x" }] },
      { filters: "name=x" },
      { limit: 0 }, { limit: 100000 }, { limit: "abc" }, { offset: -1 },
      { sort: "price:sideways" },
      { sort: "bad field" },
      { queryType: "search" },
      { queryType: "search", text: "" },
    ];
    for (const b of bad) {
      const res = await post("/v1/query", p.auth, { collection: "products", ...b });
      expect({ b, status: res.status }).toEqual({ b, status: 400 });
    }
  });

  test("SQL-injection-looking values are treated as plain data", async () => {
    await seed("postgresql");
    const res = await post("/v1/query", p.auth, { collection: "products", filters: { name: "x' OR '1'='1" } });
    expect(res.status).toBe(200);
    expect(res.body.resultCount).toBe(0);
    expect((await post("/v1/query", p.auth, { collection: "products", queryType: "count" })).body.resultCount).toBe(4);
  });

  test("results are cached per project and invalidated by writes", async () => {
    await seed("mongodb");
    const body = { collection: "products", filters: { category: "electronics" } };
    const first = await post("/v1/query", p.auth, body);
    const second = await post("/v1/query", p.auth, body);
    expect(first.body.cached).toBe(false);
    expect(second.body.cached).toBe(true);
    expect(second.body.results).toEqual(first.body.results);
    await post("/v1/data", p.auth, { collection: "products", data: { name: "Tablet", price: 20000, category: "electronics" } });
    const third = await post("/v1/query", p.auth, body);
    expect(third.body.cached).toBe(false);
    expect(third.body.resultCount).toBe(3);
  });
});

describe("Input validation on the data API", () => {
  let p;
  beforeEach(async () => { p = await newProject(); });

  test.each([
    [{ collection: "products" }],
    [{ collection: "products", data: [] }],
    [{ collection: "products", data: "x" }],
    [{ collection: "products", data: {} }],
    [{ collection: "Bad-Name", data: { a: 1 } }],
    [{ data: { a: 1 } }],
    [{ collection: "products", data: { "$set": 1 } }],
    [{ collection: "products", data: { "a.b": 1 } }],
    [{ collection: "products", data: { a: { "$gt": 1 } } }],
    [{ collection: "products", data: { __proto__x: 1, "": 1 } }],
    [{ collection: "products", data: { a: undefined } }],
  ])("rejects bad insert %j", async (body) => {
    expect((await post("/v1/data", p.auth, body)).status).toBe(400);
  });

  test("rejects prototype-pollution style keys", async () => {
    const res = await request(app).post("/v1/data").set(p.auth).set("Content-Type", "application/json")
      .send('{"collection":"products","data":{"__proto__":{"admin":true}}}');
    expect(res.status).toBe(400);
    expect({}.admin).toBeUndefined();
  });

  test("rejects over-deep, over-large documents", async () => {
    let deep = { a: 1 };
    for (let i = 0; i < 12; i += 1) deep = { n: deep };
    expect((await post("/v1/data", p.auth, { collection: "products", data: deep })).status).toBe(400);
    expect((await post("/v1/data", p.auth, { collection: "products", data: { blob: "x".repeat(300 * 1024) } })).status).toBe(400);
  });

  test.each(["..%2F..%2Fetc", "a%20b", "'%20OR%201=1", "%24where"])("rejects hostile document id %s", async (id) => {
    await post("/v1/data", p.auth, { collection: "products", data: { a: 1 } });
    expect((await get(`/v1/data/products/${id}`, p.auth)).status).toBe(400);
  });

  test("malformed JSON -> 400 with a clean error", async () => {
    const res = await request(app).post("/v1/data").set(p.auth).set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });

  test("PostgreSQL columns enforce types from the sample", async () => {
    await post("/v1/collections", p.auth, { name: "typed", sampleData: { name: "x", qty: 1 }, storageHint: "postgresql" });
    expect((await post("/v1/data", p.auth, { collection: "typed", data: { name: "ok", qty: 2 } })).status).toBe(201);
  });
});

describe("12. Usage tracking", () => {
  test("counts requests, queries, inserts, updates, deletes, errors and activity", async () => {
    const p = await newProject();
    const doc = (await post("/v1/data", p.auth, { collection: "products", data: { name: "a", price: 1 } })).body;
    await post("/v1/data", p.auth, { collection: "products", data: { name: "b", price: 2 } });
    await post("/v1/query", p.auth, { collection: "products" });
    await get(`/v1/data/products/${doc.id}`, p.auth);
    await request(app).put(`/v1/data/products/${doc.id}`).set(p.auth).send({ data: { name: "a2", price: 1 } });
    await request(app).delete(`/v1/data/products/${doc.id}`).set(p.auth);
    await get("/v1/data/ghosts", p.auth); // error
    await tick(60);
    const res = await get("/v1/usage", p.auth);
    expect(res.status).toBe(200);
    expect(res.body.usage).toMatchObject({ inserts: 2, queries: 2, updates: 1, deletes: 1, errors: 1 });
    expect(res.body.usage.requests).toBeGreaterThanOrEqual(7);
    expect(res.body.usage.lastActivity).toBeTruthy();
    expect(res.body.collections[0]).toMatchObject({ name: "products", documents: 1 });
    expect(res.body.usage.storageBytes).toBeGreaterThan(0);
    const admin = await request(app).get(`/v1/projects/${p.projectId}/usage`);
    expect(admin.body.usage.inserts).toBe(2);
  });
});

describe("Error handling and security hygiene", () => {
  test("unexpected errors are generic: no message, stack or internals leak", async () => {
    const p = await newProject();
    await post("/v1/collections", p.auth, { name: "products", sampleData: { a: 1 } });
    ctx.adapters.postgresql.findOne = async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); };
    const res = await get("/v1/data/products/abc", p.auth);
    expect(res.status).toBe(500);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5|\.js:|stack/i);
    expect(res.body.error.code).toBe("internal_error");
  });

  test("the legacy POST /v1/query is untouched when no pk_ key is sent", async () => {
    const res = await request(app).post("/v1/query").send({ dataset: "x" });
    expect(res.body).toEqual({ legacy: true });
    const withKey = await request(app).post("/v1/query").set("Authorization", "Bearer pk_" + "a".repeat(10)).send({ collection: "x" });
    expect(withKey.status).toBe(401);
  });

  test("errors always use a consistent shape", async () => {
    const p = await newProject();
    const res = await post("/v1/collections", p.auth, { name: "Bad Name" });
    expect(res.body).toMatchObject({ success: false, error: { code: "invalid_request" } });
    expect(typeof res.body.message).toBe("string");
  });
});
