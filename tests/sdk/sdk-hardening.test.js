const http = require("http");
const util = require("util");
const request = require("supertest");
const { buildTestApp } = require("../dbaas/_app");
const sdk = require("../../sdk");
const { Maestro } = sdk;

const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const KEY = "pk_aaaaaaaaaaaa_" + "S".repeat(43);

describe("SDK error mapping", () => {
  const cases = [[401, "unauthorized", sdk.AuthenticationError], [403, "insufficient_scope", sdk.PermissionError], [403, "quota_exceeded", sdk.QuotaExceededError],
    [404, "not_found", sdk.NotFoundError], [409, "duplicate_id", sdk.ConflictError], [400, "invalid_request", sdk.ValidationError], [429, "rate_limited", sdk.RateLimitError], [500, "internal_error", sdk.ServerError]];
  test.each(cases)("%i %s -> typed error", async (status, code, Cls) => {
    const m = new Maestro({ apiKey: KEY, maxRetries: 0, fetch: async () => resp(status, { success: false, error: { code, message: "m" } }) });
    const e = await m.listCollections().catch((x) => x);
    expect(e).toBeInstanceOf(Cls); expect(e).toBeInstanceOf(sdk.MaestroError);
    expect(e.status).toBe(status); expect(e.code).toBe(code);
  });
});

describe("SDK retries", () => {
  test("idempotent read retries 503 then succeeds", async () => {
    let n = 0;
    const m = new Maestro({ apiKey: KEY, fetch: async () => (++n < 3 ? resp(503, { success: false, error: { code: "storage_unavailable", message: "x" } }) : resp(200, { success: true, collections: [] })) });
    expect(await m.listCollections()).toEqual([]);
    expect(n).toBe(3);
  });
  test("POST insert is NOT retried on 503 (it may have been applied)", async () => {
    let n = 0;
    const m = new Maestro({ apiKey: KEY, fetch: async () => { n += 1; return resp(503, { success: false, error: { code: "storage_unavailable", message: "x" } }); } });
    await expect(m.collection("c").insert({ a: 1 })).rejects.toBeInstanceOf(sdk.ServerError);
    expect(n).toBe(1);
  });
  test("429 is retried for any method, honouring Retry-After (capped)", async () => {
    let n = 0;
    const m = new Maestro({ apiKey: KEY, fetch: async () => (++n < 2 ? resp(429, { success: false, error: { code: "rate_limited", message: "x" } }, { "retry-after": "0" }) : resp(201, { success: true, id: "1", data: {} })) });
    expect((await m.collection("c").insert({ a: 1 })).id).toBe("1");
    expect(n).toBe(2);
  });
  test("read-only /v1/query is retried; retries are bounded", async () => {
    let n = 0;
    const m = new Maestro({ apiKey: KEY, maxRetries: 2, fetch: async () => { n += 1; throw Object.assign(new Error("ECONNRESET"), { name: "FetchError" }); } });
    await expect(m.query({ collection: "c" })).rejects.toBeInstanceOf(sdk.NetworkError);
    expect(n).toBe(3);
  });
  test("timeouts surface as TimeoutError", async () => {
    const m = new Maestro({ apiKey: KEY, timeoutMs: 20, maxRetries: 0, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    await expect(m.listCollections()).rejects.toBeInstanceOf(sdk.TimeoutError);
  });
});

describe("SDK never leaks the API key", () => {
  const m = new Maestro({ apiKey: KEY, fetch: async () => { throw new Error(`boom with Bearer ${KEY}`); }, maxRetries: 0 });
  test("not in inspect, JSON, enumerable keys or string form", () => {
    expect(util.inspect(m)).not.toContain(KEY);
    expect(JSON.stringify(m)).not.toContain(KEY);
    expect(Object.keys(m)).not.toContain("apiKey");
    expect(String(m)).not.toContain(KEY);
  });
  test("not in network error messages", async () => {
    const e = await m.listCollections().catch((x) => x);
    expect(e.message).not.toContain(KEY);
    expect(util.inspect(e)).not.toContain(KEY);
  });
});

describe("SDK import against the real API chain", () => {
  let server; let baseUrl; let ctx; let client;
  beforeAll(async () => {
    ctx = buildTestApp();
    server = http.createServer(ctx.app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const p = await request(ctx.app).post("/v1/projects").send({ name: "SDK" });
    expect(p.status).toBe(201);
    expect(p.body.apiKey).toMatch(/^pk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    client = new Maestro({ apiKey: p.body.apiKey, baseUrl });
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test("dry run, real import, partial import and failed import", async () => {
    const csv = "sku,qty\na1,1\na2,2\n";
    const dry = await client.importFile("stock", csv, { filename: "s.csv", dryRun: true });
    expect(dry.status).toBe("dry_run");
    const real = await client.importFile("stock", csv, { filename: "s.csv", idField: "sku", onDuplicate: "skip" });
    expect(real.summary.inserted).toBe(2);
    const again = await client.importFile("stock", csv, { filename: "s.csv", idField: "sku", onDuplicate: "skip" });
    expect(again.summary).toMatchObject({ inserted: 0, skipped: 2 });
    const partial = await client.importFile("p", "a,b\n1,2\n3\n", { filename: "p.csv" });
    expect(partial.status).toBe("partial");
    expect(partial.errors[0].row).toBe(2);
    const failed = await client.importFile("f", "a,b\n1\n", { filename: "f.csv" }).catch((e) => e);
    expect(failed).toBeInstanceOf(sdk.ValidationError);
    expect(failed.details.status).toBe("failed");
    expect(await client.collection("stock").count()).toBe(2);
  });
});
