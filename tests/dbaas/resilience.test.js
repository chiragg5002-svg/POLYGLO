const { CircuitBreaker, protectAdapter, isTransient, internalStoreError } = require("../../adapters/common");
const { DbaasError } = require("../../dbaas/errors");
const { PostgresAdapter } = require("../../adapters/postgres-adapter");
const { ProjectCache } = require("../../dbaas/cache");
const { Platform } = require("../../dbaas/platform");

const transient = () => new DbaasError(503, "storage_unavailable", "down");
const fake = (impl = {}) => ({ dbType: "fake", create: async () => ({}), findOne: async () => null, find: async () => ({}), count: async () => 0, query: async () => ({}), update: async () => null, delete: async () => false, createStorage: async () => {}, storageBytes: async () => 0, ...impl });
const fast = { baseDelayMs: 1, maxDelayMs: 2, cooldownMs: 40, threshold: 3, retries: 2 };

describe("error classification", () => {
  test.each([["ECONNREFUSED"], ["ETIMEDOUT"], ["57P01"], ["08006"]])("code %s is transient", (code) => expect(isTransient({ code })).toBe(true));
  test("driver error names/messages are transient; ordinary errors are not", () => {
    expect(isTransient({ name: "MongoServerSelectionError" })).toBe(true);
    expect(isTransient({ message: "Connection terminated unexpectedly" })).toBe(true);
    expect(isTransient({ name: "AggregateError", errors: [{ code: "ECONNREFUSED" }] })).toBe(true);
    expect(isTransient({ code: "23505" })).toBe(false);
    expect(isTransient(new Error("syntax error at or near"))).toBe(false);
  });
  test("transient -> 503 storage_unavailable with Retry-After; other -> 502 storage_error; nothing leaks", () => {
    const a = internalStoreError("x", { code: "ECONNREFUSED", message: "connect ECONNREFUSED postgres://u:pw@h:5432" });
    expect(a).toMatchObject({ status: 503, code: "storage_unavailable", retryAfterSeconds: 2 });
    expect(a.message).not.toMatch(/postgres:|pw/);
    expect(internalStoreError("x", new Error("boom"))).toMatchObject({ status: 502, code: "storage_error" });
  });
});

describe("bounded retries (reads only)", () => {
  test("a read is retried with backoff and then succeeds", async () => {
    let calls = 0;
    const a = protectAdapter(fake({ findOne: async () => { calls += 1; if (calls < 3) throw transient(); return { id: "1" }; } }), fast);
    expect(await a.findOne({}, "1")).toEqual({ id: "1" });
    expect(calls).toBe(3);
  });
  test("retries are bounded", async () => {
    let calls = 0;
    const a = protectAdapter(fake({ find: async () => { calls += 1; throw transient(); } }), { ...fast, threshold: 99 });
    await expect(a.find({}, {})).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(calls).toBe(3); // 1 try + 2 retries
  });
  test("WRITES are never retried (they may already have applied)", async () => {
    let calls = 0;
    const a = protectAdapter(fake({ create: async () => { calls += 1; throw transient(); } }), { ...fast, threshold: 99 });
    await expect(a.create({}, {})).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(calls).toBe(1);
  });
  test("non-transient errors are not retried and do not trip the breaker", async () => {
    let calls = 0;
    const a = protectAdapter(fake({ findOne: async () => { calls += 1; throw new DbaasError(400, "invalid_request", "bad"); } }), fast);
    for (let i = 0; i < 5; i += 1) await expect(a.findOne({}, "x")).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(5);
    expect(a.breaker.state).toBe("closed");
  });
});

describe("circuit breaker", () => {
  test("opens after consecutive transient failures, fails fast, half-opens, and recovers", async () => {
    let healthy = false; let calls = 0;
    const a = protectAdapter(fake({ delete: async () => { calls += 1; if (!healthy) throw transient(); return true; } }), fast);
    for (let i = 0; i < 3; i += 1) await expect(a.delete({}, "x")).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(a.breaker.state).toBe("open");
    const before = calls;
    const e = await a.delete({}, "x").catch((x) => x);
    expect(e).toMatchObject({ status: 503, code: "storage_unavailable" });
    expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(before); // failed fast: backend not touched
    await new Promise((r) => setTimeout(r, 60));
    expect(a.breaker.state).toBe("half-open");
    healthy = true;
    expect(await a.delete({}, "x")).toBe(true);
    expect(a.breaker.state).toBe("closed");
  });
  test("a failed half-open trial re-opens the breaker", async () => {
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 20 });
    await expect(b.run(async () => { throw transient(); })).rejects.toBeDefined();
    expect(b.state).toBe("open");
    await new Promise((r) => setTimeout(r, 30));
    await expect(b.run(async () => { throw transient(); })).rejects.toBeDefined();
    expect(b.state).toBe("open");
  });
});

describe("real PostgresAdapter against an unreachable server", () => {
  test("returns 503 storage_unavailable quickly (no hang, no leak)", async () => {
    const a = protectAdapter(new PostgresAdapter({ pgConfig: { host: "127.0.0.1", port: 1, user: "x", password: "secret-pw", database: "postgres" } }), { ...fast, threshold: 99 });
    const m = { project_id: "proj_aaaaaaaaaaaa", collection: "items", database_name: "maestro_proj_aaaaaaaaaaaa", physical_name: "items", schema: { columns: [] } };
    const started = Date.now();
    const e = await a.findOne(m, "1").catch((x) => x);
    expect(e).toMatchObject({ status: 503, code: "storage_unavailable" });
    expect(JSON.stringify(e.message)).not.toMatch(/secret-pw|127\.0\.0\.1/);
    expect(Date.now() - started).toBeLessThan(5000);
    await a.close();
  });
});

describe("cache degradation", () => {
  test("a throwing Redis client never breaks reads: cache returns miss, writes are no-ops", async () => {
    const boom = { get: async () => { throw new Error("redis down"); }, set: async () => { throw new Error("redis down"); }, incr: async () => { throw new Error("x"); }, expire: async () => 1 };
    const c = new ProjectCache({ getClient: async () => boom, isEnabled: () => true });
    const q = await c.getQuery("proj_aaaaaaaaaaaa", "items", { queryType: "select", filters: [] });
    expect(q).toEqual({ value: null, ver: "" });
    expect(await c.setQuery("proj_aaaaaaaaaaaa", "items", {}, "", {})).toBe(false);
    expect(await c.invalidateCollection("proj_aaaaaaaaaaaa", "items")).toBe(0);
  });
  test("an unreachable Redis (getClient rejects) is also a miss", async () => {
    const c = new ProjectCache({ getClient: async () => { throw new Error("ECONNREFUSED"); }, isEnabled: () => true });
    expect((await c.getDoc("proj_aaaaaaaaaaaa", "items", "1")).value).toBeNull();
  });
});

describe("purge reports per-store outcomes and never half-deletes silently", () => {
  test("if one store fails the project stays, with a 502 purge_incomplete listing each store", async () => {
    const { MemoryControlStore } = require("../../dbaas/control-plane/memory-store");
    const { ControlPlane } = require("../../dbaas/control-plane");
    const cp = new ControlPlane(new MemoryControlStore());
    const { project } = await cp.createProject("P");
    const ok = fake({ dbType: "postgresql", dropProjectStorage: async () => {} });
    const bad = fake({ dbType: "mongodb", dropProjectStorage: async () => { throw new Error("mongo down"); } });
    const platform = new Platform({ controlPlane: cp, adapters: { postgresql: ok, mongodb: bad, elasticsearch: fake() }, cache: new ProjectCache({ isEnabled: () => false }) });
    for (const [c, t] of [["a", "postgresql"], ["b", "mongodb"]]) {
      await cp.store.createCollectionWithMapping({ collection_id: `col_${c}`, project_id: project.projectId, name: c },
        { project_id: project.projectId, collection: c, db_type: t, database_name: `maestro_${project.projectId}`, physical_name: c });
    }
    const err = await platform.deleteProject(project.projectId, { purge: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "purge_incomplete" });
    expect(err.details.stores).toEqual([{ store: "postgresql", status: "purged", collections: 1 }, { store: "mongodb", status: "failed", collections: 1, error: "storage backend failed" }]);
    expect((await cp.getProject(project.projectId)).status).toBe("active");
    bad.dropProjectStorage = async () => {}; // operator retries after fixing the backend
    const done = await platform.deleteProject(project.projectId, { purge: true });
    expect(done).toMatchObject({ deleted: true, dataPurged: true });
  });
});
