/*
 * POST /v1/import: parsing, validation, dry-run, duplicates/idempotency,
 * partial failures, cache invalidation, tenant isolation, quotas.
 */
const request = require("supertest");
const { buildTestApp } = require("./_app");
const { DbaasError } = require("../../dbaas/errors");
const { CsvTokenizer } = require("../../dbaas/importer");

const ADMIN = "import-admin-token-0123456789abcdef01";
let t; let app; let p;
const adminAuth = { Authorization: `Bearer ${ADMIN}` };

beforeEach(async () => {
  process.env.MAESTRO_ADMIN_TOKEN = ADMIN;
  process.env.MAESTRO_INSECURE_DEV = "false";
  t = buildTestApp(); app = t.app;
  const r = await request(app).post("/v1/projects").set(adminAuth).send({ name: "Imp" });
  p = { id: r.body.projectId, auth: { Authorization: `Bearer ${r.body.apiKey}` } };
});
afterAll(() => { delete process.env.MAESTRO_ADMIN_TOKEN; });

const upload = (content, filename, fields = {}, auth = () => p.auth) => {
  let r = request(app).post("/v1/import").set(auth());
  for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
  return r.attach("file", Buffer.from(content), filename);
};
const count = async (c = "people") => (await request(app).post("/v1/query").set(p.auth).send({ collection: c, queryType: "count" })).body.resultCount;

describe("CSV", () => {
  const csv = "Name,Age,Active,Zip\nAlice,30,true,00501\nBob,,false,10001\n\"Carter, Dana\",41,TRUE,94105\n";
  test("imports valid rows, infers types conservatively, reports a clean summary", async () => {
    const r = await upload(csv, "people.csv", { collection: "people" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "success", success: true, summary: { total: 3, valid: 3, invalid: 0, inserted: 3, failed: 0 } });
    expect(r.body.note).toMatch(/idField/);
    const rows = (await request(app).get("/v1/data/people").set(p.auth)).body.results.map((x) => x.data);
    expect(rows[0]).toEqual({ name: "Alice", age: 30, active: true, zip: "00501" }); // leading zero stays a string
    expect(rows[1].age).toBeNull();
    expect(rows[2].name).toBe("Carter, Dana");
  });
  test("dry run validates and profiles but writes nothing, not even the collection", async () => {
    const r = await upload(csv, "people.csv", { collection: "people", dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("dry_run");
    expect(r.body.summary.valid).toBe(3);
    expect(r.body.routing.dbType).toBeDefined();
    expect(r.body.schema.fields.map((f) => f.name)).toEqual(["name", "age", "active", "zip"]);
    expect(r.body.schema.fields.find((f) => f.name === "age").nullRate).toBeCloseTo(0.333, 2);
    expect((await request(app).get("/v1/collections").set(p.auth)).body.collections).toEqual([]);
  });
  test("normalises headers, de-duplicates them and reports the mapping", async () => {
    const r = await upload("Full Name,full name,Price (USD),\nA,B,1,2\n", "x.csv", { collection: "hdr" });
    expect(r.body.fieldMapping.map((m) => m.field)).toEqual(["full_name", "full_name_2", "price_usd", "column_4"]);
  });
  test("BOM, CRLF, tab-separated, and quoted newlines parse correctly", async () => {
    const bom = await upload("\uFEFFa,b\r\n1,2\r\n", "bom.csv", { collection: "bom" });
    expect(bom.body.summary.inserted).toBe(1);
    const tsv = await upload("a\tb\n1\thello\n", "t.tsv", { collection: "tsv" });
    expect((await request(app).get("/v1/data/tsv").set(p.auth)).body.results[0].data).toEqual({ a: 1, b: "hello" });
    const nl = await upload('a,b\n"line1\nline2",2\n', "nl.csv", { collection: "nl" });
    expect((await request(app).get("/v1/data/nl").set(p.auth)).body.results[0].data.a).toBe("line1\nline2");
    expect(nl.status).toBe(201);
  });
  test("malformed rows are row-level errors; the import is PARTIAL (207), never 'success'", async () => {
    const r = await upload("a,b\n1,2\n3\n4,5,6\n7,8\n", "bad.csv", { collection: "bad" });
    expect(r.status).toBe(207);
    expect(r.body.status).toBe("partial");
    expect(r.body.success).toBe(true);
    expect(r.body.summary).toMatchObject({ total: 4, inserted: 2, failed: 2 });
    expect(r.body.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(r.body.errors[0].message).toMatch(/Expected 2 columns but found 1/);
    expect(await count("bad")).toBe(2);
  });
  test("a file where every row is bad fails (422) and records nothing as imported", async () => {
    const r = await upload("a,b\n1\n2\n", "allbad.csv", { collection: "allbad" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: "failed", success: false });
    expect(r.body.summary.inserted).toBe(0);
  });
  test("unterminated quote is reported, not silently swallowed", async () => {
    const r = await upload('a,b\n1,2\n3,"oops\n', "q.csv", { collection: "q" });
    expect(r.body.errors.some((e) => /unterminated/i.test(e.message))).toBe(true);
  });
  test("empty file / header-only file -> 400", async () => {
    expect((await upload("", "e.csv", { collection: "e" })).status).toBe(400);
    expect((await upload("a,b\n", "h.csv", { collection: "h" })).status).toBe(400);
  });
  test("sensitive-looking fields are flagged and their sample values withheld", async () => {
    const r = await upload("email,password,card,city\nx@y.com,hunter2,4111 1111 1111 1111,Paris\n", "s.csv", { collection: "sens", dryRun: true });
    const by = Object.fromEntries(r.body.schema.fields.map((f) => [f.name, f]));
    expect(by.email.sensitive && by.password.sensitive && by.card.sensitive).toBe(true);
    expect(by.city.sensitive).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect(JSON.stringify(r.body)).not.toContain("4111");
    expect(r.body.warnings.length).toBe(3);
  });
});

describe("JSON / NDJSON", () => {
  test("JSON array with nested objects and unicode", async () => {
    const data = [{ name: "Zoë", tags: ["a", "b"], meta: { x: 1 } }, { name: "李雷", tags: [], meta: { x: 2 } }];
    const r = await upload(JSON.stringify(data), "d.json", { collection: "docs" });
    expect(r.status).toBe(201);
    const got = (await request(app).get("/v1/data/docs").set(p.auth)).body.results.map((x) => x.data.name);
    expect(got.sort()).toEqual(["Zoë", "李雷"].sort());
  });
  test("non-object records and invalid field names are row errors", async () => {
    const r = await upload(JSON.stringify([{ a: 1 }, 5, { "bad key": 1 }, { ok: 2 }]), "m.json", { collection: "mix" });
    expect(r.status).toBe(207);
    expect(r.body.errors.map((e) => e.row)).toEqual([2, 3]);
  });
  test("NDJSON streams line by line and flags bad lines", async () => {
    const r = await upload('{"a":1}\n\nnot json\n{"a":2}\n[1]\n', "l.ndjson", { collection: "nd" });
    expect(r.body.summary).toMatchObject({ total: 4, inserted: 2, failed: 2 });
  });
  test("invalid JSON / wrong shape -> 400", async () => {
    expect((await upload("{oops", "x.json", { collection: "x" })).status).toBe(400);
    expect((await upload('{"a":1}', "x.json", { collection: "x" })).status).toBe(400);
  });
});

describe("duplicates, idempotency and retries", () => {
  const body = JSON.stringify([{ sku: "a1", qty: 1 }, { sku: "a2", qty: 2 }]);
  test("idField + onDuplicate=skip makes re-uploads idempotent", async () => {
    const f = { collection: "stock", idField: "sku", onDuplicate: "skip" };
    expect((await upload(body, "s.json", f)).body.summary.inserted).toBe(2);
    const again = await upload(body, "s.json", f);
    expect(again.body.summary).toMatchObject({ inserted: 0, skipped: 2, failed: 0 });
    expect(again.body.status).toBe("success");
    expect(await count("stock")).toBe(2);
    expect((await request(app).get("/v1/data/stock/a1").set(p.auth)).body.data.qty).toBe(1);
  });
  test("onDuplicate=error reports each duplicate and keeps the originals", async () => {
    await upload(body, "s.json", { collection: "stock", idField: "sku" });
    const r = await upload(body, "s.json", { collection: "stock", idField: "sku", onDuplicate: "error" });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].message).toMatch(/Duplicate id/);
    expect(await count("stock")).toBe(2);
  });
  test("onDuplicate=replace overwrites", async () => {
    await upload(body, "s.json", { collection: "stock", idField: "sku" });
    const r = await upload(JSON.stringify([{ sku: "a1", qty: 99 }]), "s.json", { collection: "stock", idField: "sku", onDuplicate: "replace" });
    expect(r.body.summary.replaced).toBe(1);
    expect((await request(app).get("/v1/data/stock/a1").set(p.auth)).body.data.qty).toBe(99);
  });
  test("duplicate ids inside one file are detected", async () => {
    const r = await upload(JSON.stringify([{ sku: "z", n: 1 }, { sku: "z", n: 2 }]), "d.json", { collection: "dd", idField: "sku" });
    expect(r.status).toBe(207);
    expect(r.body.errors[0].message).toMatch(/within the file/);
  });
  test("missing or unsafe id values are row errors", async () => {
    const r = await upload(JSON.stringify([{ sku: "ok" }, { n: 1 }, { sku: "../x" }]), "i.json", { collection: "ids", idField: "sku" });
    expect(r.body.summary).toMatchObject({ inserted: 1, failed: 2 });
  });
  test("invalid options are 400", async () => {
    expect((await upload(body, "s.json", { collection: "stock", onDuplicate: "explode" })).status).toBe(400);
    expect((await upload(body, "s.json", { collection: "Bad Name" })).status).toBe(400);
    expect((await upload(body, "s.json", { collection: "stock", storageHint: "oracle" })).status).toBe(400);
    expect((await upload(body, "s.json", {})).status).toBe(400);
  });
});

describe("partial backend failures are reported per row, never as success", () => {
  test("some rows fail in the store -> 207 with row numbers; successful rows stay; cache is invalidated", async () => {
    await request(app).post("/v1/data").set(p.auth).send({ collection: "flaky", data: { n: 0 } });
    const warm = await request(app).post("/v1/query").set(p.auth).send({ collection: "flaky" });
    expect(warm.body.cached).toBe(false);
    expect((await request(app).post("/v1/query").set(p.auth).send({ collection: "flaky" })).body.cached).toBe(true);

    const pg = t.adapters.postgresql; const orig = pg.create.bind(pg);
    pg.create = async (m, args) => { if (args.data.n === 3) throw new DbaasError(502, "storage_error", "boom"); return orig(m, args); };
    const r = await upload(JSON.stringify([1, 2, 3, 4].map((n) => ({ n }))), "f.json", { collection: "flaky" });
    expect(r.status).toBe(207);
    expect(r.body.status).toBe("partial");
    expect(r.body.summary).toMatchObject({ inserted: 3, failed: 1 });
    expect(r.body.errors).toEqual([{ row: 3, message: "Storage backend error; row not imported." }]);
    // the cached pre-import query must NOT be served after the import
    const after = await request(app).post("/v1/query").set(p.auth).send({ collection: "flaky" });
    expect(after.body.cached).toBe(false);
    expect(after.body.resultCount).toBe(4);
  });
  test("a backend that keeps failing aborts the import and says so", async () => {
    const pg = t.adapters.postgresql;
    await request(app).post("/v1/data").set(p.auth).send({ collection: "dead", data: { n: 0 } });
    pg.create = async () => { throw new DbaasError(503, "storage_unavailable", "down"); };
    const r = await upload(JSON.stringify(Array.from({ length: 60 }, (_, n) => ({ n }))), "f.json", { collection: "dead" });
    expect(["partial", "failed"]).toContain(r.body.status);
    expect(r.body.summary.aborted).toMatch(/kept failing/);
    expect(r.body.summary.inserted).toBe(0);
  });
  test("import jobs are recorded (counts only, no data)", async () => {
    await upload('[{"a":1}]', "j.json", { collection: "jobs" });
    const jobs = (await request(app).get("/v1/imports").set(p.auth)).body.imports;
    expect(jobs[0]).toMatchObject({ collection: "jobs", status: "success", inserted: 1 });
  });
});

describe("security", () => {
  test("requires a key with the import scope; read-only keys get 403; no key 401", async () => {
    expect((await request(app).post("/v1/import").attach("file", Buffer.from("a\n1\n"), "a.csv")).status).toBe(401);
    const ro = await request(app).post(`/v1/projects/${p.id}/keys`).set(adminAuth).send({ scopes: ["data:read"] });
    const r = await upload("a\n1\n", "a.csv", { collection: "c" }, () => ({ Authorization: `Bearer ${ro.body.apiKey}` }));
    expect(r.status).toBe(403);
  });
  test("tenant isolation: A's import is invisible to B and cannot target B's collection", async () => {
    const rb = await request(app).post("/v1/projects").set(adminAuth).send({ name: "B" });
    const B = { Authorization: `Bearer ${rb.body.apiKey}` };
    await upload('[{"v":"A-secret"}]', "a.json", { collection: "shared_name" });
    expect((await request(app).get("/v1/data/shared_name").set(B)).status).toBe(404);
    await upload('[{"v":"B-data"}]', "b.json", { collection: "shared_name" }, () => B);
    const a = (await request(app).get("/v1/data/shared_name").set(p.auth)).body.results.map((x) => x.data.v);
    expect(a).toEqual(["A-secret"]);
  });
  test("rejects disallowed extensions and oversized uploads; cannot spoof projectId", async () => {
    expect((await upload("MZ", "evil.exe", { collection: "c" })).status).toBe(415);
    process.env.MAESTRO_MAX_IMPORT_BYTES = "1024";
    const t2 = buildTestApp();
    const r2 = await request(t2.app).post("/v1/projects").set(adminAuth).send({ name: "Big" });
    const big = await request(t2.app).post("/v1/import").set({ Authorization: `Bearer ${r2.body.apiKey}` }).field("collection", "c").attach("file", Buffer.alloc(5000, "a"), "a.csv");
    delete process.env.MAESTRO_MAX_IMPORT_BYTES;
    expect(big.status).toBe(413);
    const spoof = await upload("a\n1\n", "a.csv", { collection: "c", projectId: "proj_ffffffffffff" });
    expect(spoof.status).toBe(403);
  });
  test("row-count and document quotas are enforced", async () => {
    await request(app).put(`/v1/projects/${p.id}/quotas`).set(adminAuth).send({ maxImportRows: 3 });
    // quotas are resolved at authentication time -> re-read through a fresh request
    const r = await upload("a\n1\n2\n3\n4\n", "a.csv", { collection: "q1" });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("import_too_large");
    await request(app).put(`/v1/projects/${p.id}/quotas`).set(adminAuth).send({ maxImportRows: 100, maxDocuments: 2 });
    const r2 = await upload("a\n1\n2\n3\n4\n", "a.csv", { collection: "q2" });
    expect(["partial", "failed"]).toContain(r2.body.status);
    expect(r2.body.summary.aborted).toMatch(/quota/i);
  });
  test("uploaded temp files are removed after the request", async () => {
    const fs = require("fs"); const os = require("os"); const path = require("path");
    const dir = process.env.MAESTRO_IMPORT_TMP;
    await upload("a\n1\n", "a.csv", { collection: "tmpcheck" });
    await upload("{bad", "b.json", { collection: "tmpcheck" });
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readdirSync(dir).length).toBe(0);
  });
});

describe("CSV tokenizer is chunk-boundary safe", () => {
  test("feeding byte-by-byte equals feeding at once", () => {
    const src = 'a,b\n"x,1","he said ""hi"""\n"multi\nline",2\n3,4';
    const whole = new CsvTokenizer(","); whole.feed(src); whole.end();
    const bytes = new CsvTokenizer(","); for (const ch of src) bytes.feed(ch); bytes.end();
    expect(bytes.drain()).toEqual(whole.drain());
  });
});
