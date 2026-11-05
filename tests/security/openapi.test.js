/* The OpenAPI document must describe exactly the public routes that exist. */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

let registry;
beforeAll(() => { process.env.MAESTRO_CONTROL_STORE = "memory"; const app = require("../../server"); registry = require("../../dbaas/route-registry"); return app; });

const toOpenApi = (p) => p.replace(/:(\w+)/g, "{$1}");
test("every public API route is documented, and nothing undocumented/phantom is documented", () => {
  const spec = yaml.load(fs.readFileSync(path.join(__dirname, "..", "..", "openapi.yaml"), "utf8"));
  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) for (const m of Object.keys(item)) if (["get", "post", "put", "patch", "delete"].includes(m)) documented.add(`${m.toUpperCase()} ${p}`);
  const actual = new Set(registry.list().filter((r) => ["project", "ops"].includes(r.variant)).map((r) => `${r.method} ${toOpenApi(r.path)}`));
  // path params named differently in the spec (collections/{name}) are matched structurally
  const norm = (s) => s.replace(/\{[^}]+\}/g, "{}");
  const a = [...actual].map(norm).sort(); const d = [...documented].map(norm).sort();
  expect(d).toEqual(a);
});
test("spec declares security for every non-public operation", () => {
  const spec = yaml.load(fs.readFileSync(path.join(__dirname, "..", "..", "openapi.yaml"), "utf8"));
  const open = [
    "/health", "/ready", "/v1/openapi.yaml", "/v1/client/auth/register",
    "/v1/client/auth/login", "/v1/client/auth/verify-otp", "/v1/client/auth/resend-otp",
  ];
  for (const [p, item] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(m) || open.includes(p)) continue;
    expect({ p, m, secured: Array.isArray(op.security) && op.security.length > 0 }).toEqual({ p, m, secured: true });
  }
});
