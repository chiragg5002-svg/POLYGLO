/**
 * DOM-level tests of the operator dashboard (jsdom). Layout/CSS is not
 * covered here.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "views", "index.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
const authJs = fs.readFileSync(path.join(ROOT, "public", "auth.js"), "utf8");
const platformJs = fs.readFileSync(path.join(ROOT, "public", "platform.js"), "utf8");

function boot(routes, { token, validToken = token } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:3000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.confirm = () => true;
  window.fetch = async (url, init = {}) => {
    const headers = new window.Headers(init.headers || {});
    const authorization = headers.get("authorization");
    const path = String(url);
    calls.push({ url: path, method: init.method || "GET", auth: authorization });
    const authorized = Boolean(validToken && authorization === `Bearer ${validToken}`);
    const result = routes(path, init.method || "GET", authorized);
    const status = result.status ?? (token ? (authorized ? 200 : 401) : 200);
    return { ok: status < 400, status, json: async () => result.body || {}, headers: { get: () => null } };
  };
  if (token) window.sessionStorage.setItem("maestro_admin_token", token);
  window.eval(authJs);
  window.eval(platformJs);
  return { window, calls, $: (id) => window.document.getElementById(id), dom };
}
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("operator credentials are attached only by the allowlisted helper", async () => {
  const { window, calls } = boot(() => ({ status: 200, body: { projects: [] } }), { token: "op-token-123" });
  await tick();
  expect(calls.find((call) => call.url === "/v1/projects").auth).toMatch(/^Bearer /);
  await window.fetch("https://evil.example/steal");
  expect(calls[calls.length - 1].auth).toBeNull();
  await window.fetch("/metadata/summary");
  expect(calls[calls.length - 1].auth).toBeNull();
  await window.maestroOperatorFetch("/metadata/summary");
  expect(calls[calls.length - 1].auth).toMatch(/^Bearer /);
  expect(() => window.maestroOperatorFetch("https://evil.example/metadata")).toThrow(/only be sent to this origin/);
});

test("no token means no project request and protected actions remain disabled", async () => {
  const { $, calls } = boot(() => ({ status: 401, body: { message: "Operator credentials required." } }));
  await tick();
  expect(calls).toHaveLength(0);
  expect($("platform-create-project").disabled).toBe(true);
  expect($("platform-refresh").disabled).toBe(true);
  expect($("platform-auth-status").textContent).toMatch(/sign-in required/i);
});

test("saving and verifying a token enables protected platform actions", async () => {
  const { window, $, calls } = boot((url) => ({ status: 200, body: url === "/v1/projects" ? { projects: [] } : {} }), { validToken: "new-token" });
  $("platform-admin-token").value = "  new-token  ";
  $("platform-token-save").click();
  await tick();
  expect(window.sessionStorage.getItem("maestro_admin_token")).toBe("new-token");
  expect(window.localStorage.getItem("maestro_admin_token")).toBeNull();
  expect(calls.find((call) => call.url === "/v1/projects").auth).toMatch(/^Bearer /);
  expect($("platform-create-project").disabled).toBe(false);
  expect($("platform-refresh").disabled).toBe(false);
  expect($("platform-auth-status").textContent).toMatch(/authenticated/i);
});

test("server-provided strings are escaped before rendering project details", async () => {
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const { window, $ } = boot((url) => {
    if (url === "/v1/projects") return { status: 200, body: { projects: [{ projectId: "proj_aaaaaaaaaaaa", name: evil, status: "active" }] } };
    if (url.endsWith("/usage")) return { status: 200, body: { usage: { requests: 1 }, collections: [{ name: evil, documents: 1, storageBytes: 1 }] } };
    if (url.endsWith("/imports")) return { status: 200, body: { imports: [] } };
    if (url.startsWith("/v1/audit")) return { status: 200, body: { events: [] } };
    return { status: 200, body: { projectId: "proj_aaaaaaaaaaaa", name: evil, collections: [{ collection: evil, dbType: evil, routingReason: evil }],
      apiKeys: [{ keyId: "k1", prefix: evil, label: evil, status: "active", scopes: [evil], expiresAt: null }] } };
  }, { token: "op-token" });
  await tick();
  window.document.querySelector(".project-item").click();
  await tick(60);
  expect(window.__xss).toBeUndefined();
  expect($("platform-project-list").querySelector("img, script")).toBeNull();
  expect($("platform-project-detail").querySelector("img, script")).toBeNull();
  expect($("platform-project-detail").textContent).toContain("<img");
});

test("unavailable storage metrics are not displayed as zero", async () => {
  const { window, $ } = boot((url) => {
    if (url === "/v1/projects") return { status: 200, body: { projects: [{ projectId: "proj_aaaaaaaaaaaa", name: "Project", status: "active" }] } };
    if (url.endsWith("/usage")) return { status: 200, body: {
      usage: { storageBytes: null }, collections: [{ name: "items", dbType: "postgresql", storageBytes: null, documents: null }],
      warnings: ["Storage size unavailable for one or more collections."],
    } };
    if (url.endsWith("/imports")) return { status: 200, body: { imports: [] } };
    if (url.startsWith("/v1/audit")) return { status: 200, body: { events: [] } };
    return { status: 200, body: { projectId: "proj_aaaaaaaaaaaa", name: "Project",
      collections: [{ collection: "items", dbType: "postgresql", databaseName: "catalog", physicalName: "items" }], apiKeys: [] } };
  }, { token: "op-token" });
  await tick();
  window.document.querySelector(".project-item").click();
  await tick(60);
  const detail = $("platform-project-detail").textContent;
  expect(detail).toContain("Unavailable");
  expect(detail).toContain("Storage size unavailable");
  expect(detail).not.toContain("0 B");
});

test("new project API key is shown once and can be hidden without persistence", async () => {
  const KEY = "pk_aaaaaaaaaaaa_" + "Z".repeat(43);
  const { window, $ } = boot((url, method) => {
    if (method === "POST" && url === "/v1/projects") return { status: 201, body: { projectId: "proj_bbbbbbbbbbbb", name: "New", apiKey: KEY } };
    if (url === "/v1/projects") return { status: 200, body: { projects: [] } };
    if (url.endsWith("/usage")) return { status: 200, body: { usage: {}, collections: [] } };
    if (url.endsWith("/imports")) return { status: 200, body: { imports: [] } };
    if (url.startsWith("/v1/audit")) return { status: 200, body: { events: [] } };
    return { status: 200, body: { projectId: "proj_bbbbbbbbbbbb", name: "New", collections: [], apiKeys: [] } };
  }, { token: "op-token" });
  await tick();
  $("platform-project-name").value = "New";
  $("platform-create-project").click();
  await tick(60);
  expect($("platform-secret").textContent).toContain(KEY);
  $("platform-hide-key").click();
  expect($("platform-secret").textContent).toBe("");
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(KEY);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(KEY);
});

test("invalid project name is rejected before a create request", async () => {
  const { $, calls } = boot((url) => ({ status: 200, body: url === "/v1/projects" ? { projects: [] } : {} }), { token: "op-token" });
  await tick();
  const before = calls.filter((call) => call.method === "POST" && call.url === "/v1/projects").length;
  $("platform-project-name").value = "   ";
  $("platform-create-project").click();
  await tick();
  expect(calls.filter((call) => call.method === "POST" && call.url === "/v1/projects")).toHaveLength(before);
  expect($("platform-status").textContent).toMatch(/Enter a project name/);
});

test("clearing credentials signs out and disables operator actions", async () => {
  const { window, $ } = boot((url) => ({ status: 200, body: url === "/v1/projects" ? { projects: [] } : {} }), { token: "op-token" });
  await tick();
  expect($("platform-create-project").disabled).toBe(false);
  $("platform-token-clear").click();
  expect(window.sessionStorage.getItem("maestro_admin_token")).toBeNull();
  expect($("platform-admin-token").value).toBe("");
  expect($("platform-create-project").disabled).toBe(true);
  expect($("platform-refresh").disabled).toBe(true);
  expect($("platform-auth-status").textContent).toMatch(/signed out/i);
});

test("index.html has no inline scripts or event-handler attributes (strict CSP compatible)", () => {
  const raw = fs.readFileSync(path.join(ROOT, "views", "index.html"), "utf8");
  expect(raw).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(raw).not.toMatch(/\son[a-z]+\s*=/i);
});
