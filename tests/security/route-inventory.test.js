/*
 * Proves every HTTP route is classified and protected as declared:
 *  1. the routes registered on the REAL Express app == the route registry
 *  2. every non-public route rejects a request with no credentials
 *  3. every non-public route rejects an invalid credential
 *  4. only the explicitly public routes answer without credentials
 */
const request = require("supertest");

const ADMIN = "inventory-admin-token-0123456789abcdef";
let app; let registry;

beforeAll(() => {
  process.env.MAESTRO_INSECURE_DEV = "false";
  process.env.MAESTRO_ADMIN_TOKEN = ADMIN;
  process.env.MAESTRO_CONTROL_STORE = "memory";
  process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE = "100000"; // brute-force limiting has its own test
  app = require("../../server");
  registry = require("../../dbaas/route-registry");
});
afterAll(async () => { await app.dbaas.platform.close(); delete process.env.MAESTRO_CONTROL_STORE; });

function walk(stack, out = []) {
  for (const l of stack) {
    if (l.route) for (const m of Object.keys(l.route.methods)) out.push(`${m.toUpperCase()} ${l.route.path}`);
    else if (l.handle && l.handle.stack) walk(l.handle.stack, out);
  }
  return out;
}

const concrete = (p) => p.replace(":projectId", "proj_aaaaaaaaaaaa").replace(":keyId", "aaaaaaaaaaaa").replace(":collection", "products")
  .replace(":name", "products").replace(":id", "abc123");

test("every registered Express route is in the route registry, and vice versa", () => {
  const actual = [...new Set(walk(app.router.stack))].sort();
  const declared = [...new Set(registry.list().map((r) => `${r.method} ${r.path}`))].sort();
  expect(actual).toEqual(declared);
});

test("every route has an explicit access class", () => {
  for (const r of registry.list()) expect(["public", "operator", "key", "client"]).toContain(r.access);
});

test("the public surface is exactly the UI, client auth entrypoints, health, readiness and openapi", () => {
  const pub = registry.list().filter((r) => r.access === "public").map((r) => `${r.method} ${r.path}`).sort();
  expect(pub).toEqual([
    "GET /", "GET /client", "GET /client/billing", "GET /health", "GET /ready",
    "GET /v1/openapi.yaml", "POST /v1/client/auth/login", "POST /v1/client/auth/register",
    "POST /v1/client/auth/resend-otp", "POST /v1/client/auth/verify-otp",
  ].sort());
});

describe("protected routes reject missing and invalid credentials", () => {
  const protectedRoutes = () => registry.list().filter((r) => r.access !== "public");
  test("no credentials -> 401 on every protected route", async () => {
    for (const r of protectedRoutes()) {
      const res = await request(app)[r.method.toLowerCase()](concrete(r.path)).send(r.method === "GET" || r.method === "DELETE" ? undefined : {});
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: 401 });
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules/);
    }
  });
  test("a bogus bearer token -> 401 on every protected route", async () => {
    for (const r of protectedRoutes()) {
      const res = await request(app)[r.method.toLowerCase()](concrete(r.path)).set("Authorization", "Bearer pk_000000000000_" + "x".repeat(43)).send(r.method === "GET" || r.method === "DELETE" ? undefined : {});
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: 401 });
    }
  });
  test("a wrong operator token -> 401 on every operator route", async () => {
    for (const r of protectedRoutes().filter((x) => x.access === "operator")) {
      const res = await request(app)[r.method.toLowerCase()](concrete(r.path)).set("Authorization", "Bearer not-the-admin-token").send(r.method === "GET" || r.method === "DELETE" ? undefined : {});
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: 401 });
    }
  });
});

test("the two legacy routes called out in the audit now require credentials", async () => {
  expect((await request(app).post("/v1/query").send({ dataset: "x" })).status).toBe(401);
  expect((await request(app).post("/database/create").send({ dbType: "postgres", dbName: "attacker_db" })).status).toBe(401);
});

test("a read-only project key can use its scoped data API but not operator metadata or control-plane routes", async () => {
  const created = await request(app).post("/v1/projects").set("Authorization", `Bearer ${ADMIN}`)
    .send({ name: "Read only portal key", scopes: ["data:read"] });
  expect(created.status).toBe(201);
  const projectKey = `Bearer ${created.body.apiKey}`;
  expect((await request(app).get("/v1/project").set("Authorization", projectKey)).status).toBe(200);
  expect((await request(app).get("/metadata/table").set("Authorization", projectKey)).status).toBe(401);
  expect((await request(app).get("/v1/projects").set("Authorization", projectKey)).status).toBe(401);
});

test("public routes answer without credentials and reveal nothing sensitive", async () => {
  expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
  const ui = await request(app).get("/");
  expect(ui.status).toBe(200);
  const clientUi = await request(app).get("/client");
  expect(clientUi.status).toBe(200);
  expect(clientUi.headers["cache-control"]).toBe("no-store");
  expect(clientUi.text).toContain("MAESTRO Client Portal");
  expect(clientUi.text).toContain('/static/client.css?v=');
  expect(clientUi.text).toContain('/static/client.js?v=');
  expect(clientUi.text).toContain('href="/client/billing" target="_blank" rel="noopener"');
  const billingUi = await request(app).get("/client/billing");
  expect(billingUi.status).toBe(200);
  expect(billingUi.text).toContain("Billing dashboard");
  expect(billingUi.text).toContain('/static/client-billing.js?v=');
  expect(billingUi.text).toContain('href="/v1/client/billing/export.csv"');
  const clientScript = await request(app).get("/static/client.js");
  expect(clientScript.status).toBe(200);
  expect(clientScript.headers["content-type"]).toMatch(/javascript/);
  expect(clientScript.text).toContain("/v1/client/auth/me");
  expect(clientScript.text).not.toContain("MAESTRO_ADMIN_TOKEN");
  const billingScript = await request(app).get("/static/client-billing.js");
  expect(billingScript.status).toBe(200);
  expect(billingScript.text).toContain("/v1/client/billing/usage");
  const clientStyles = await request(app).get("/static/client.css");
  expect(clientStyles.status).toBe(200);
  expect(clientStyles.headers["content-type"]).toMatch(/css/);
  const spec = await request(app).get("/v1/openapi.yaml");
  expect(spec.status).toBe(200);
});

test("unknown routes get a JSON 404", async () => {
  const res = await request(app).get("/nope");
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe("not_found");
});

test("operator token works on a legacy route (authorized success)", async () => {
  const res = await request(app).get("/metadata/summary").set("Authorization", `Bearer ${ADMIN}`);
  expect(res.status).toBe(200);
});

test("valid operator token can read billing data and export the billing CSV", async () => {
  const auth = { Authorization: `Bearer ${ADMIN}` };
  for (const path of [
    "/v1/billing/clients",
    "/v1/billing/plans",
    "/v1/billing/invoices",
    "/v1/billing/audit",
  ]) {
    const res = await request(app).get(path).set(auth);
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
  }

  const csv = await request(app).get("/v1/billing/export.csv?kind=invoices").set(auth);
  expect(csv.status).toBe(200);
  expect(csv.headers["content-type"]).toMatch(/text\/csv/);
  expect(csv.text).toContain("invoice_number");
});

test("operator token does not authenticate client billing endpoints", async () => {
  const auth = { Authorization: `Bearer ${ADMIN}` };
  expect((await request(app).get("/v1/client/billing/usage").set(auth)).status).toBe(401);
  expect((await request(app).get("/v1/client/billing/plans").set(auth)).status).toBe(401);
});
