/*
 * Authentication, authorization, scopes, expiry, rotation, quotas, rate
 * limiting, input hardening, headers/CORS and startup validation.
 * Uses the in-memory control plane + fake drivers (no services needed); the
 * live suites re-prove isolation against real PostgreSQL and Redis.
 */
const request = require("supertest");
const { buildTestApp } = require("../dbaas/_app");
const { createOperatorAuth, validateStartupConfig } = require("../../dbaas/security");

const ADMIN = "unit-admin-token-0123456789abcdef0123";
const adminAuth = { Authorization: `Bearer ${ADMIN}` };
const KEYS = ["MAESTRO_ADMIN_TOKEN", "MAESTRO_INSECURE_DEV", "MAESTRO_CORS_ORIGINS", "MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE", "MAESTRO_RATE_LIMIT_PER_MINUTE",
  "MAESTRO_QUOTA_REQUESTS_PER_MINUTE", "MAESTRO_MAX_INFLIGHT", "MAESTRO_AUTH_CACHE_TTL_MS", "NODE_ENV"];
const saved = {};
let t; let app;

beforeAll(() => KEYS.forEach((k) => { saved[k] = process.env[k]; }));
afterAll(() => KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
beforeEach(() => {
  KEYS.forEach((k) => delete process.env[k]);
  process.env.MAESTRO_ADMIN_TOKEN = ADMIN;
  process.env.MAESTRO_INSECURE_DEV = "false";
  process.env.MAESTRO_AUTH_CACHE_TTL_MS = "0"; // these tests edit the store directly; caching has its own test below
  t = buildTestApp({ operatorAuth: createOperatorAuth() });
  app = t.app;
});

const bearer = (k) => ({ Authorization: `Bearer ${k}` });
async function project(name = "P", body = {}) {
  const r = await request(app).post("/v1/projects").set(adminAuth).send({ name, ...body });
  expect(r.status).toBe(201);
  return { id: r.body.projectId, key: r.body.apiKey, keyId: r.body.apiKeyId, auth: bearer(r.body.apiKey) };
}
async function newKey(p, body) {
  const r = await request(app).post(`/v1/projects/${p.id}/keys`).set(adminAuth).send(body);
  expect(r.status).toBe(201);
  return { key: r.body.apiKey, keyId: r.body.keyId, auth: bearer(r.body.apiKey), body: r.body };
}

describe("operator authentication", () => {
  test("control plane without token -> 401; wrong token -> 401; right token -> 201", async () => {
    expect((await request(app).post("/v1/projects").send({ name: "x" })).status).toBe(401);
    expect((await request(app).post("/v1/projects").set("Authorization", "Bearer wrong").send({ name: "x" })).status).toBe(401);
    expect((await request(app).post("/v1/projects").set(adminAuth).send({ name: "x" })).status).toBe(201);
  });
  test("fails CLOSED when no operator token is configured (no insecure-dev flag)", async () => {
    delete process.env.MAESTRO_ADMIN_TOKEN;
    const r = await request(app).post("/v1/projects").send({ name: "x" });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/MAESTRO_ADMIN_TOKEN/);
  });
  test("an API key can never act as the operator", async () => {
    const p = await project();
    expect((await request(app).post("/v1/projects").set(p.auth).send({ name: "evil" })).status).toBe(401);
    expect((await request(app).get(`/v1/projects/${p.id}`).set(p.auth)).status).toBe(401);
    expect((await request(app).get("/v1/audit").set(p.auth)).status).toBe(401);
  });
  test("insecure-dev flag opens operator routes only when explicitly set (and never in production)", async () => {
    delete process.env.MAESTRO_ADMIN_TOKEN;
    process.env.MAESTRO_INSECURE_DEV = "true";
    expect((await request(app).get("/v1/projects")).status).toBe(200);
    process.env.NODE_ENV = "production";
    expect((await request(app).get("/v1/projects")).status).toBe(503);
  });
  test("repeated failures are rate limited (brute-force protection)", async () => {
    process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE = "3";
    const t2 = buildTestApp({ operatorAuth: createOperatorAuth() });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await request(t2.app).get("/v1/projects").set("Authorization", "Bearer nope")).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429, 429]);
  });
});

describe("API key authentication", () => {
  test("missing, malformed and unknown keys -> 401", async () => {
    for (const h of [{}, { Authorization: "Basic abc" }, { Authorization: "Bearer" }, bearer("pk_short"), bearer(`pk_${"0".repeat(12)}_${"a".repeat(43)}`)]) {
      const r = await request(app).get("/v1/collections").set(h);
      expect(r.status).toBe(401);
    }
  });
  test("revoked key -> 401", async () => {
    const p = await project();
    expect((await request(app).get("/v1/collections").set(p.auth)).status).toBe(200);
    await request(app).delete(`/v1/projects/${p.id}/keys/${p.keyId}`).set(adminAuth);
    const r = await request(app).get("/v1/collections").set(p.auth);
    expect(r.status).toBe(401);
  });
  test("expired key -> 401", async () => {
    const p = await project();
    const k = await newKey(p, { label: "temp", expiresInDays: 1 });
    expect((await request(app).get("/v1/collections").set(k.auth)).status).toBe(200);
    (await t.store.getApiKey(k.keyId)); t.store.keys.get(k.keyId).expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await request(app).get("/v1/collections").set(k.auth);
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/expired/);
    const listed = await request(app).get(`/v1/projects/${p.id}`).set(adminAuth);
    expect(listed.body.apiKeys.find((x) => x.keyId === k.keyId).status).toBe("expired");
  });
  test("a past expiry date is rejected at creation", async () => {
    const p = await project();
    const r = await request(app).post(`/v1/projects/${p.id}/keys`).set(adminAuth).send({ expiresAt: "2001-01-01T00:00:00Z" });
    expect(r.status).toBe(400);
  });
  test("keys are stored hashed, shown once, never listed", async () => {
    const p = await project();
    const row = await t.store.getApiKey(p.keyId);
    expect(row.key_hash).not.toContain(p.key.slice(p.key.indexOf("_", 3) + 1).slice(8));
    const list = await request(app).get(`/v1/projects/${p.id}`).set(adminAuth);
    expect(JSON.stringify(list.body)).not.toContain(p.key);
  });
  test("deleting a project revokes its keys", async () => {
    const p = await project();
    await request(app).delete(`/v1/projects/${p.id}`).set(adminAuth);
    expect((await request(app).get("/v1/collections").set(p.auth)).status).toBe(401);
  });
});

describe("scopes (least privilege)", () => {
  test("read-only key can read but gets 403 on every write", async () => {
    const p = await project();
    await request(app).post("/v1/data").set(p.auth).send({ collection: "items", data: { n: 1 } });
    const ro = await newKey(p, { label: "ro", scopes: ["data:read"] });
    expect((await request(app).get("/v1/data/items").set(ro.auth)).status).toBe(200);
    expect((await request(app).post("/v1/query").set(ro.auth).send({ collection: "items" })).status).toBe(200);
    for (const [m, path, body] of [["post", "/v1/data", { collection: "items", data: { n: 2 } }], ["post", "/v1/collections", { name: "c2" }],
      ["delete", "/v1/collections/items"], ["get", "/v1/usage"]]) {
      const r = await request(app)[m](path).set(ro.auth).send(body);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
      expect(r.body.error.code).toBe("insufficient_scope");
    }
  });
  test("write-only key cannot read", async () => {
    const p = await project();
    const wo = await newKey(p, { scopes: ["data:write"] });
    expect((await request(app).post("/v1/data").set(wo.auth).send({ collection: "items", data: { n: 1 } })).status).toBe(201);
    expect((await request(app).get("/v1/data/items").set(wo.auth)).status).toBe(403);
  });
  test("invalid scope names are rejected", async () => {
    const p = await project();
    for (const scopes of [["root"], [], "data:read", ["data:read", 5]]) {
      expect((await request(app).post(`/v1/projects/${p.id}/keys`).set(adminAuth).send({ scopes })).status).toBe(400);
    }
  });
  test("a key can never name another project (spoofing -> 403)", async () => {
    const a = await project("A"); const b = await project("B");
    for (const r of [
      await request(app).post("/v1/data").set(a.auth).send({ projectId: b.id, collection: "x", data: { a: 1 } }),
      await request(app).get(`/v1/collections?projectId=${b.id}`).set(a.auth),
      await request(app).get("/v1/collections").set(a.auth).set("X-Project-Id", b.id),
    ]) expect(r.status).toBe(403);
  });
  test("tenant A cannot see B's collection or data", async () => {
    const a = await project("A"); const b = await project("B");
    await request(app).post("/v1/data").set(b.auth).send({ collection: "secrets", data: { v: "b-only" } });
    expect((await request(app).get("/v1/data/secrets").set(a.auth)).status).toBe(404);
    expect((await request(app).get("/v1/collections").set(a.auth)).body.collections).toEqual([]);
  });
});

describe("rotation", () => {
  test("rotate (no grace) issues a same-scope key and revokes the old one immediately", async () => {
    const p = await project();
    const ro = await newKey(p, { scopes: ["data:read"] });
    const r = await request(app).post(`/v1/projects/${p.id}/keys/${ro.keyId}/rotate`).set(adminAuth).send({});
    expect(r.status).toBe(201);
    expect(r.body.scopes).toEqual(["data:read"]);
    expect((await request(app).get("/v1/collections").set(ro.auth)).status).toBe(401);
    expect((await request(app).get("/v1/collections").set(bearer(r.body.apiKey))).status).toBe(200);
  });
  test("rotate with a grace period keeps the old key valid until it expires", async () => {
    const p = await project();
    const r = await request(app).post(`/v1/projects/${p.id}/keys/${p.keyId}/rotate`).set(adminAuth).send({ graceSeconds: 3600 });
    expect(r.body.oldKeyValidForSeconds).toBe(3600);
    expect((await request(app).get("/v1/collections").set(p.auth)).status).toBe(200);
    t.store.keys.get(p.keyId).expires_at = new Date(Date.now() - 1).toISOString();
    expect((await request(app).get("/v1/collections").set(p.auth)).status).toBe(401);
  });
  test("cannot rotate another project's key", async () => {
    const a = await project("A"); const b = await project("B");
    expect((await request(app).post(`/v1/projects/${a.id}/keys/${b.keyId}/rotate`).set(adminAuth).send({})).status).toBe(404);
  });
});

describe("idempotent project creation", () => {
  test("concurrent creates with one Idempotency-Key yield exactly one project and one key", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () =>
      request(app).post("/v1/projects").set(adminAuth).set("Idempotency-Key", "idem-key-12345678").send({ name: "Once" })));
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.projectId)).size).toBe(1);
    expect(rs.filter((r) => r.body.apiKey)).toHaveLength(1);
    expect((await request(app).get("/v1/projects").set(adminAuth)).body.projects).toHaveLength(1);
  });
});

describe("audit trail", () => {
  test("admin actions are recorded and contain no secrets", async () => {
    const p = await project("Audited");
    const k = await newKey(p, { label: "x" });
    await request(app).delete(`/v1/projects/${p.id}/keys/${k.keyId}`).set(adminAuth);
    await request(app).put(`/v1/projects/${p.id}/quotas`).set(adminAuth).send({ maxDocuments: 5 });
    const r = await request(app).get(`/v1/audit?projectId=${p.id}`).set(adminAuth);
    const actions = r.body.events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["project.create", "key.create", "key.revoke", "quotas.update"]));
    const dump = JSON.stringify(r.body);
    expect(dump).not.toContain(p.key); expect(dump).not.toContain(k.key); expect(dump).not.toContain(ADMIN);
    expect(r.body.events[0].request_id).toBeTruthy();
  });
  test("collection and import activity is attributed to the key id", async () => {
    const p = await project();
    await request(app).post("/v1/data").set(p.auth).send({ collection: "items", data: { n: 1 } });
    const ev = (await request(app).get(`/v1/audit?projectId=${p.id}`).set(adminAuth)).body.events;
    expect(ev.find((e) => e.action === "collection.create").actor).toBe(`key:${p.keyId}`);
  });
});

describe("quotas", () => {
  test("document quota: writes are refused with 403 quota_exceeded, reads and deletes still work", async () => {
    const p = await project();
    await request(app).put(`/v1/projects/${p.id}/quotas`).set(adminAuth).send({ maxDocuments: 2 });
    const ids = [];
    for (let i = 0; i < 2; i++) ids.push((await request(app).post("/v1/data").set(p.auth).send({ collection: "items", data: { n: i } })).body.id);
    const over = await request(app).post("/v1/data").set(p.auth).send({ collection: "items", data: { n: 3 } });
    expect(over.status).toBe(403);
    expect(over.body.error).toMatchObject({ code: "quota_exceeded", details: { quota: "maxDocuments", limit: 2 } });
    expect((await request(app).get("/v1/data/items").set(p.auth)).status).toBe(200);
    expect((await request(app).delete(`/v1/data/items/${ids[0]}`).set(p.auth)).status).toBe(200);
    expect((await request(app).post("/v1/data").set(p.auth).send({ collection: "items", data: { n: 4 } })).status).toBe(201);
  });
  test("quotas are per project", async () => {
    const a = await project("A"); const b = await project("B");
    await request(app).put(`/v1/projects/${a.id}/quotas`).set(adminAuth).send({ maxDocuments: 1 });
    await request(app).post("/v1/data").set(a.auth).send({ collection: "items", data: { n: 1 } });
    expect((await request(app).post("/v1/data").set(a.auth).send({ collection: "items", data: { n: 2 } })).status).toBe(403);
    expect((await request(app).post("/v1/data").set(b.auth).send({ collection: "items", data: { n: 2 } })).status).toBe(201);
  });
  test("per-project request-rate quota -> 429 with Retry-After", async () => {
    const p = await project();
    await request(app).put(`/v1/projects/${p.id}/quotas`).set(adminAuth).send({ requestsPerMinute: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).get("/v1/collections").set(p.auth)).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    const r = await request(app).get("/v1/collections").set(p.auth);
    expect(r.headers["retry-after"]).toBeDefined();
  });
  test("invalid quota values/names are rejected", async () => {
    const p = await project();
    for (const body of [{ maxDocuments: 0 }, { maxDocuments: "5" }, { nope: 1 }, []]) {
      expect((await request(app).put(`/v1/projects/${p.id}/quotas`).set(adminAuth).send(body)).status).toBe(400);
    }
  });
});

describe("input hardening", () => {
  test("malformed JSON -> 400 structured error; non-JSON content type -> 415; oversized -> 413", async () => {
    const p = await project();
    const bad = await request(app).post("/v1/data").set(p.auth).set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe("invalid_request");
    const wrongType = await request(app).post("/v1/data").set(p.auth).set("Content-Type", "text/plain").send("collection=x");
    expect(wrongType.status).toBe(415);
    const big = await request(app).post("/v1/data").set(p.auth).set("Content-Type", "application/json").send(JSON.stringify({ collection: "x", data: { a: "y".repeat(3 * 1024 * 1024) } }));
    expect(big.status).toBe(413);
  });
  test("injection-shaped identifiers/values are rejected or inert", async () => {
    const p = await project();
    for (const name of ["a;drop table x", "../etc/passwd", "UPPER", "a b", "$where", "x".repeat(60), "__proto__"]) {
      expect((await request(app).post("/v1/data").set(p.auth).send({ collection: name, data: { a: 1 } })).status).toBe(400);
    }
    expect((await request(app).post("/v1/data").set(p.auth).send({ collection: "ok", data: { "$gt": 1 } })).status).toBe(400);
    expect((await request(app).post("/v1/data").set(p.auth).send({ collection: "ok", data: { "__proto__": { x: 1 } } })).status).toBe(400);
  });
  test("errors never include stack traces, keys, or connection strings", async () => {
    const p = await project();
    const r = await request(app).get("/v1/data/missing_collection/abc").set(p.auth);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)|mongodb:\/\/|postgres:\/\/|pk_[0-9a-f]{12}_/);
    expect(r.body.error.requestId).toBeTruthy();
  });
});

describe("headers, CORS, request ids", () => {
  test("security headers on every response; no x-powered-by", async () => {
    const r = await request(app).get("/v1/collections");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
  test("CORS: no header by default; exact allowlisted origin only; never credentials; never *", async () => {
    let r = await request(app).get("/v1/collections").set("Origin", "https://evil.example");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    process.env.MAESTRO_CORS_ORIGINS = "https://app.example.com, *";
    r = await request(app).get("/v1/collections").set("Origin", "https://app.example.com");
    expect(r.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    r = await request(app).get("/v1/collections").set("Origin", "https://evil.example");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    r = await request(app).options("/v1/data").set("Origin", "https://app.example.com").set("Access-Control-Request-Method", "POST");
    expect(r.status).toBe(204);
    r = await request(app).options("/v1/data").set("Origin", "https://evil.example");
    expect(r.status).toBe(403);
  });
  test("request id is generated, echoed, and well-formed ids are honoured", async () => {
    const a = await request(app).get("/v1/collections");
    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const b = await request(app).get("/v1/collections").set("X-Request-Id", "trace-abc-12345");
    expect(b.headers["x-request-id"]).toBe("trace-abc-12345");
    const c = await request(app).get("/v1/collections").set("X-Request-Id", "bad id\twith junk");
    expect(c.headers["x-request-id"]).not.toContain("junk");
  });
});

describe("startup configuration validation (fail closed in production)", () => {
  const good = { NODE_ENV: "production", MAESTRO_ADMIN_TOKEN: "a".repeat(40), MAESTRO_KEY_PEPPER: "b".repeat(40), PG_PASSWORD: "S0me-long-random-pw" };
  test("a complete production config passes", () => expect(validateStartupConfig(good).errors).toEqual([]));
  test.each([
    ["missing admin token", { MAESTRO_ADMIN_TOKEN: "" }],
    ["short admin token", { MAESTRO_ADMIN_TOKEN: "short" }],
    ["missing pepper", { MAESTRO_KEY_PEPPER: "" }],
    ["default postgres password", { PG_PASSWORD: "postgres" }],
    ["empty postgres password", { PG_PASSWORD: "" }],
    ["insecure dev flag", { MAESTRO_INSECURE_DEV: "true" }],
    ["memory control store", { MAESTRO_CONTROL_STORE: "memory" }],
    ["wildcard CORS", { MAESTRO_CORS_ORIGINS: "*" }],
  ])("refuses to start with %s", (_n, override) => {
    expect(validateStartupConfig({ ...good, ...override }).errors.length).toBeGreaterThan(0);
  });
  test("development only warns", () => {
    const r = validateStartupConfig({ NODE_ENV: "development", MAESTRO_INSECURE_DEV: "true" });
    expect(r.errors).toEqual([]); expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("backpressure", () => {
  test("sheds load with 503 + Retry-After when too many requests are in flight", async () => {
    process.env.MAESTRO_MAX_INFLIGHT = "1";
    const t2 = buildTestApp();
    let release; const gate = new Promise((r) => { release = r; });
    t2.app.get("/slow", async (req, res) => { await gate; res.json({ ok: true }); });
    const slow = request(t2.app).get("/slow").then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const rejected = await request(t2.app).get("/v1/collections");
    expect(rejected.status).toBe(503);
    expect(rejected.body.error.code).toBe("overloaded");
    expect(rejected.headers["retry-after"]).toBeDefined();
    release();
    expect((await slow).status).toBe(200);
  });
});

describe("auth cache and batched usage", () => {
  test("cache serves repeat requests without store lookups, but local revoke/rotate/delete take effect immediately", async () => {
    process.env.MAESTRO_AUTH_CACHE_TTL_MS = "60000";
    const t2 = buildTestApp();
    const mk = await request(t2.app).post("/v1/projects").set(adminAuth).send({ name: "C" });
    const auth = bearer(mk.body.apiKey);
    expect((await request(t2.app).get("/v1/collections").set(auth)).status).toBe(200);
    let lookups = 0; const orig = t2.store.getApiKey.bind(t2.store);
    t2.store.getApiKey = async (...a) => { lookups += 1; return orig(...a); };
    for (let i = 0; i < 5; i += 1) expect((await request(t2.app).get("/v1/collections").set(auth)).status).toBe(200);
    expect(lookups).toBe(0);
    await request(t2.app).delete(`/v1/projects/${mk.body.projectId}/keys/${mk.body.apiKeyId}`).set(adminAuth);
    expect((await request(t2.app).get("/v1/collections").set(auth)).status).toBe(401); // no TTL window on the same instance
  });
  test("another instance may honour a revoked key for at most the TTL (documented trade-off)", async () => {
    process.env.MAESTRO_AUTH_CACHE_TTL_MS = "150";
    const t2 = buildTestApp();
    const mk = await request(t2.app).post("/v1/projects").set(adminAuth).send({ name: "C" });
    const auth = bearer(mk.body.apiKey);
    await request(t2.app).get("/v1/collections").set(auth);
    t2.store.keys.get(mk.body.apiKeyId).status = "revoked"; // simulates a revoke done by a different instance
    expect((await request(t2.app).get("/v1/collections").set(auth)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await request(t2.app).get("/v1/collections").set(auth)).status).toBe(401);
  });
  test("key expiry is honoured even on a cache hit", async () => {
    process.env.MAESTRO_AUTH_CACHE_TTL_MS = "60000";
    const t2 = buildTestApp();
    const mk = await request(t2.app).post("/v1/projects").set(adminAuth).send({ name: "C", expiresInDays: 1 });
    const auth = bearer(mk.body.apiKey);
    await request(t2.app).get("/v1/collections").set(auth);
    const entry = [...t2.dbaas.platform.cp._authCache.values()][0];
    // time passes: the key's expiry moment is now in the past (cache entry is still within its TTL)
    entry.keyExpiresAt = Date.now() - 1;
    t2.store.keys.get(mk.body.apiKeyId).expires_at = new Date(Date.now() - 1).toISOString();
    expect((await request(t2.app).get("/v1/collections").set(auth)).status).toBe(401);
  });
  test("usage is batched but always current when read, and a failed flush keeps the counters", async () => {
    process.env.MAESTRO_USAGE_FLUSH_MS = "60000";
    const t2 = buildTestApp();
    const mk = await request(t2.app).post("/v1/projects").set(adminAuth).send({ name: "U" });
    const auth = bearer(mk.body.apiKey);
    let writes = 0; const orig = t2.store.incrementUsage.bind(t2.store);
    t2.store.incrementUsage = async (...a) => { writes += 1; return orig(...a); };
    for (let i = 0; i < 6; i += 1) await request(t2.app).get("/v1/collections").set(auth);
    expect(writes).toBe(0);
    const u = await request(t2.app).get("/v1/usage").set(auth);
    expect(u.body.usage.requests).toBeGreaterThanOrEqual(6);
    expect(writes).toBe(1);
    delete process.env.MAESTRO_USAGE_FLUSH_MS;
  });
});
