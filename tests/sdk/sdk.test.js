const http = require("http");
const request = require("supertest");
const { buildTestApp } = require("../dbaas/_app");
const { Maestro, MaestroError } = require("../../sdk");

let server; let baseUrl; let ctx;
const projects = {};

beforeAll(async () => {
  delete process.env.MAESTRO_ADMIN_TOKEN;
  ctx = buildTestApp();
  server = http.createServer(ctx.app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["A", "B"]) {
    const res = await request(ctx.app).post("/v1/projects").send({ name });
    projects[name] = res.body;
  }
});
afterAll(() => new Promise((r) => server.close(r)));

const client = (name) => new Maestro({ apiKey: projects[name].apiKey, baseUrl });

describe("JavaScript SDK", () => {
  test("spec example: insert then find", async () => {
    const maestro = client("A");
    const inserted = await maestro.collection("products").insert({ name: "Laptop", price: 75000, category: "electronics" });
    expect(inserted.id).toBeTruthy();
    expect(inserted.data.name).toBe("Laptop");
    const products = await maestro.collection("products").find({ category: "electronics" });
    expect(products).toHaveLength(1);
    expect(products[0].data.name).toBe("Laptop");
  });

  test("get / update / patch / delete / count / search / findOne", async () => {
    const col = client("A").collection("gadgets");
    const d = await col.insert({ name: "Phone", price: 30000 });
    await col.insert({ name: "Watch", price: 9000 });
    expect((await col.get(d.id)).data.name).toBe("Phone");
    expect(await col.get("does-not-exist")).toBeNull();
    expect((await col.update(d.id, { name: "Phone 2", price: 31000 })).data.price).toBe(31000);
    expect((await col.patch(d.id, { price: 1 })).data).toEqual({ name: "Phone 2", price: 1 });
    expect(await col.count()).toBe(2);
    expect(await col.count({ price: { gt: 5000 } })).toBe(1);
    expect((await col.search("watch")).map((r) => r.data.name)).toEqual(["Watch"]);
    expect((await col.findOne({ name: "Watch" })).data.price).toBe(9000);
    expect(await col.findOne({ name: "nobody" })).toBeNull();
    expect((await col.find({}, { sort: "-price", limit: 1 }))[0].data.name).toBe("Watch");
    expect(await col.delete(d.id)).toBe(true);
    expect(await col.delete(d.id)).toBe(false);
  });

  test("collections, project and usage helpers", async () => {
    const m = client("A");
    const c = await m.createCollection("students", { sampleData: { student_id: "S1", address: { city: "X" }, skills: ["a"] } });
    expect(c.storage.dbType).toBe("mongodb");
    expect((await m.listCollections()).map((x) => x.name)).toEqual(expect.arrayContaining(["products", "students"]));
    expect((await m.collection("students").info()).storage.dbType).toBe("mongodb");
    expect((await m.project()).projectId).toBe(projects.A.projectId);
    expect((await m.usage()).usage.inserts).toBeGreaterThan(0);
    expect((await m.dropCollection("students")).deleted).toBe(true);
  });

  test("two SDK clients are isolated from each other", async () => {
    await client("B").collection("products").insert({ name: "Phone" });
    const a = await client("A").collection("products").find();
    const b = await client("B").collection("products").find();
    expect(a.map((r) => r.data.name)).toEqual(["Laptop"]);
    expect(b.map((r) => r.data.name)).toEqual(["Phone"]);
    expect(await client("B").collection("products").get(a[0].id)).toBeNull();
  });

  test("API errors become MaestroError with status and code", async () => {
    const bad = new Maestro({ apiKey: "pk_000000000000_" + "A".repeat(43), baseUrl });
    await expect(bad.collection("products").find()).rejects.toMatchObject({ name: "MaestroError", status: 401, code: "unauthorized" });
    await expect(client("A").collection("Bad Name").insert({ a: 1 })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(client("A").collection("ghosts").find()).rejects.toMatchObject({ status: 404 });
    await expect(client("A").collection("products").find({ price: { $gt: 1 } })).rejects.toBeInstanceOf(MaestroError);
  });

  test("filters with special characters are sent safely", async () => {
    const col = client("A").collection("notes");
    await col.insert({ text: "a&b=c?d#e" });
    expect(await col.count({ text: "a&b=c?d#e" })).toBe(1);
    const d = (await col.find({ text: "a&b=c?d#e" }))[0];
    expect((await col.get(d.id)).data.text).toBe("a&b=c?d#e");
  });

  test("constructor validation, env fallback and timeouts", async () => {
    const saved = process.env.MAESTRO_API_KEY;
    delete process.env.MAESTRO_API_KEY;
    expect(() => new Maestro({})).toThrow(/API key is required/);
    process.env.MAESTRO_API_KEY = projects.A.apiKey;
    expect(new Maestro({ baseUrl }).apiKey).toBe(projects.A.apiKey);
    if (saved === undefined) delete process.env.MAESTRO_API_KEY; else process.env.MAESTRO_API_KEY = saved;
    expect(() => new Maestro({ apiKey: "x", baseUrl: "not a url" })).toThrow(/Invalid baseUrl/);
    expect(() => client("A").collection("")).toThrow();
    const hang = new Maestro({ apiKey: "pk_x", baseUrl, timeoutMs: 20, fetch: (url, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    await expect(hang.project()).rejects.toMatchObject({ code: "timeout" });
    const down = new Maestro({ apiKey: "pk_x", baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 });
    await expect(down.project()).rejects.toMatchObject({ code: "network_error" });
  });

  test("warns when an API key would travel over plain HTTP to a remote host", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    new Maestro({ apiKey: "pk_x", baseUrl: "http://api.example.com" });
    expect(warn).toHaveBeenCalledTimes(1);
    new Maestro({ apiKey: "pk_x", baseUrl: "https://api.example.com" });
    new Maestro({ apiKey: "pk_x", baseUrl: "http://localhost:3000" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
