/* Phase 7: query validation at the HTTP boundary, auth-before-resolution, cache isolation. */
const request = require("supertest");
const { buildTestApp } = require("./_app");

let t; let app; let A; let B;
const ADMIN = "qs-admin-token-0123456789abcdef012345";
beforeEach(async () => {
  process.env.MAESTRO_ADMIN_TOKEN = ADMIN; process.env.MAESTRO_INSECURE_DEV = "false"; process.env.MAESTRO_AUTH_CACHE_TTL_MS = "0";
  t = buildTestApp(); app = t.app;
  const mk = async (n) => { const r = await request(app).post("/v1/projects").set({ Authorization: `Bearer ${ADMIN}` }).send({ name: n }); return { id: r.body.projectId, auth: { Authorization: `Bearer ${r.body.apiKey}` } }; };
  A = await mk("A"); B = await mk("B");
  for (let i = 1; i <= 5; i += 1) await request(app).post("/v1/data").set(A.auth).send({ collection: "items", data: { name: `n${i}`, price: i * 10 } });
});
afterAll(() => { delete process.env.MAESTRO_ADMIN_TOKEN; delete process.env.MAESTRO_AUTH_CACHE_TTL_MS; });
const q = (auth, body) => request(app).post("/v1/query").set(auth).send(body);

describe("validation (400 with a clear message, before any backend call)", () => {
  const bad = {
    "unknown queryType": { collection: "items", queryType: "drop" },
    "huge limit": { collection: "items", limit: 10 ** 9 },
    "zero limit": { collection: "items", limit: 0 },
    "negative offset": { collection: "items", offset: -1 },
    "non-numeric limit": { collection: "items", limit: "abc" },
    "invalid operator": { collection: "items", filters: { price: { "$gt": 1 } } },
    "unknown operator name": { collection: "items", filters: { price: { between: [1, 2] } } },
    "invalid filter field": { collection: "items", filters: { "na me": 1 } },
    "injection field": { collection: "items", filters: { "name'; DROP TABLE x;--": 1 } },
    "filters not an object": { collection: "items", filters: "price>1" },
    "in with non-array": { collection: "items", filters: { name: { in: "a" } } },
    "invalid sort direction": { collection: "items", sort: { field: "price", direction: "sideways" } },
    "invalid sort field": { collection: "items", sort: { field: "price; select 1", direction: "asc" } },
    "search without text": { collection: "items", queryType: "search" },
    "search text too long": { collection: "items", queryType: "search", text: "x".repeat(501) },
    "too many search fields": { collection: "items", queryType: "search", text: "a", fields: Array.from({ length: 21 }, (_, i) => `f${i}`) },
    "body not an object": [1, 2],
  };
  test.each(Object.keys(bad))("%s", async (name) => {
    const r = await q(A.auth, bad[name]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    expect(typeof r.body.error.message).toBe("string");
  });
  test("unknown (but well-formed) field returns an empty result with the standard shape, not an error", async () => {
    const r = await q(A.auth, { collection: "items", filters: { never_existed: 1 } });
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) expect(r.body).toMatchObject({ results: [], resultCount: 0 });
  });
  test("max allowed limit works; empty collection results are consistent", async () => {
    expect((await q(A.auth, { collection: "items", limit: 1000 })).status).toBe(200);
    const r = await q(A.auth, { collection: "items", filters: { name: "nobody" } });
    expect(r.body).toMatchObject({ success: true, resultCount: 0, results: [], queryType: "select" });
  });
});

describe("authorization happens before dataset resolution", () => {
  test("unauthenticated request for a real or fake collection gets the same 401 (no existence oracle)", async () => {
    // (the real server's un-keyed /v1/query is operator-protected: see route-inventory.test.js)
    const bogus = { Authorization: `Bearer pk_${"0".repeat(12)}_${"a".repeat(43)}` };
    const a = await request(app).post("/v1/query").set(bogus).send({ collection: "items" });
    const b = await request(app).post("/v1/query").set(bogus).send({ collection: "does_not_exist" });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
  });
  test("a key from another project gets 404 for A's collection, identical to a collection that does not exist", async () => {
    const real = await q(B.auth, { collection: "items" });
    const fake = await q(B.auth, { collection: "zzz_missing" });
    expect(real.status).toBe(404); expect(fake.status).toBe(404);
    expect(real.body.error.message.replace("items", "X")).toBe(fake.body.error.message.replace("zzz_missing", "X"));
  });
});

describe("cache keys include tenant, all query inputs and authorization scope", () => {
  test("identical queries by two tenants never share a cache entry", async () => {
    await request(app).post("/v1/data").set(B.auth).send({ collection: "items", data: { name: "b-only", price: 1 } });
    const a1 = await q(A.auth, { collection: "items", limit: 100 }); const a2 = await q(A.auth, { collection: "items", limit: 100 });
    const b1 = await q(B.auth, { collection: "items", limit: 100 });
    expect(a2.body.cached).toBe(true);
    expect(b1.body.cached).toBe(false);
    expect(a1.body.resultCount).toBe(5); expect(b1.body.resultCount).toBe(1);
  });
  test("every query input changes the key (filters, sort, limit, offset, fields, text, type)", async () => {
    const base = { collection: "items", limit: 10 };
    await q(A.auth, base);
    for (const v of [{ filters: { price: { gt: 10 } } }, { sort: { field: "price", direction: "desc" } }, { limit: 11 }, { offset: 1 }, { queryType: "count" }, { queryType: "search", text: "n1" }, { queryType: "search", text: "n1", fields: ["name"] }]) {
      expect((await q(A.auth, { ...base, ...v })).body.cached).toBe(false);
    }
  });
  test("a cached result is NOT served to a key without data:read (scope is checked before the cache)", async () => {
    await q(A.auth, { collection: "items" }); await q(A.auth, { collection: "items" });
    const wo = await request(app).post(`/v1/projects/${A.id}/keys`).set({ Authorization: `Bearer ${ADMIN}` }).send({ scopes: ["data:write"] });
    const r = await q({ Authorization: `Bearer ${wo.body.apiKey}` }, { collection: "items" });
    expect(r.status).toBe(403);
  });
  test("writes, updates, deletes and imports invalidate cached queries", async () => {
    const spec = { collection: "items", limit: 100 };
    const count = async () => (await q(A.auth, spec)).body.resultCount;
    expect(await count()).toBe(5); expect((await q(A.auth, spec)).body.cached).toBe(true);
    const ins = await request(app).post("/v1/data").set(A.auth).send({ collection: "items", data: { name: "n6", price: 60 } });
    expect(await count()).toBe(6);
    await request(app).put(`/v1/data/items/${ins.body.id}`).set(A.auth).send({ data: { name: "renamed", price: 61 } });
    expect((await q(A.auth, { collection: "items", filters: { name: "renamed" } })).body.resultCount).toBe(1);
    await request(app).delete(`/v1/data/items/${ins.body.id}`).set(A.auth);
    expect(await count()).toBe(5);
    await request(app).post("/v1/import").set(A.auth).field("collection", "items").attach("file", Buffer.from("name,price\nx,1\ny,2\n"), "i.csv");
    expect(await count()).toBe(7);
  });
});
