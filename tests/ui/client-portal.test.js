const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "views", "client.html"), "utf8");
const script = fs.readFileSync(path.join(ROOT, "public", "client.js"), "utf8");
const billingHtml = fs.readFileSync(path.join(ROOT, "views", "client-billing.html"), "utf8");
const billingScript = fs.readFileSync(path.join(ROOT, "public", "client-billing.js"), "utf8");

test("client portal provides account, project, key, and connection workflows", () => {
  for (const id of [
    "login-form", "register-form", "project-form", "project-list", "project-detail",
    "connection-guide", "guide-project-id", "read-example", "sign-out", "secret-dialog",
    "browse-database", "browse-project", "browse-collection", "browse-api-key",
    "browse-refresh", "browse-search", "browse-previous", "browse-next", "browse-body",
    "nav-projects", "nav-billing",
  ]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('href="/client/billing" target="_blank" rel="noopener"');
  expect(script).toContain('id="new-key-form"');
  expect(script).toContain('"/v1/client/auth/register"');
  expect(script).toContain('"/v1/client/auth/login"');
  expect(script).toContain('"/v1/client/projects"');
  expect(script).not.toContain("/v1/client/auth/verify-otp");
  expect(script).not.toContain("/v1/client/auth/resend-otp");
  expect(script).toContain("credentials: \"same-origin\"");
  expect(script).not.toContain("MAESTRO_ADMIN_TOKEN");
  expect(script).not.toMatch(/localStorage|sessionStorage/);
});

test("billing dashboard is a separate page with private data and download controls", () => {
  for (const id of [
    "billing-page", "billing-auth-required", "billing-account", "billing-current-plan",
    "billing-plan-catalog", "billing-usage", "billing-payment-summary", "billing-invoices",
    "billing-payments", "billing-refresh",
  ]) expect(billingHtml).toContain(`id="${id}"`);
  expect(billingHtml).toContain('href="/v1/client/billing/export.csv"');
  expect(billingScript).toContain("/v1/client/billing/invoices/");
  expect(billingScript).toContain('"/v1/client/auth/me"');
  expect(billingScript).toContain('"/v1/client/billing/usage"');
  expect(billingScript).toContain('"/v1/client/billing/subscription"');
  expect(billingScript).toContain("credentials: \"same-origin\"");
  expect(billingScript).not.toContain("MAESTRO_ADMIN_TOKEN");
});

async function completePasswordLogin(window, tick) {
  window.document.getElementById("login-password").value = "correct horse battery";
  window.document.getElementById("login-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  expect(window.document.getElementById("dashboard").hidden).toBe(false);
}

test("client portal has no inline scripts or inline event handlers", () => {
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
});

test("client script initializes, registers, creates a project, and calls the matching client APIs", async () => {
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/client",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  const calls = [];
  let projectCreated = false;
  window.fetch = async (url, init = {}) => {
    const pathname = String(url);
    calls.push({ pathname, init });
    let status = 200;
    let body = {};
    if (pathname === "/v1/client/auth/me") {
      status = 401;
      body = { message: "Sign in to access the client portal." };
    } else if (pathname === "/v1/client/auth/register") {
      status = 201;
      body = { account: { clientId: "client_1", displayName: "Test Client", email: "test@example.test" } };
    } else if (pathname === "/v1/client/auth/login") {
      body = { account: { clientId: "client_1", displayName: "Test Client", email: "test@example.test" } };
    } else if (pathname === "/v1/client/projects" && init.method === "POST") {
      status = 201;
      projectCreated = true;
      body = {
        projectId: "proj_aaaaaaaaaaaa", name: "Test project",
        apiKey: `pk_${"a".repeat(12)}_${"B".repeat(43)}`,
      };
    } else if (pathname === "/v1/client/projects") {
      body = { projects: projectCreated ? [{ projectId: "proj_aaaaaaaaaaaa", name: "Test project", status: "active" }] : [] };
    } else if (pathname === "/v1/client/projects/proj_aaaaaaaaaaaa") {
      body = { projectId: "proj_aaaaaaaaaaaa", name: "Test project", status: "active", createdAt: new Date(0).toISOString(), collections: [] };
    } else if (pathname.endsWith("/usage")) {
      body = { usage: { requests: 0, queries: 0, inserts: 0, updates: 0, deletes: 0, errors: 0, storageBytes: 0 }, quotas: {} };
    } else if (pathname.endsWith("/keys")) {
      body = { keys: [] };
    }
    return { ok: status < 400, status, json: async () => body };
  };

  window.eval(script.replace('"/v1/client/auth/login"', '"/v1/v1/client/auth/login"'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls[0].pathname).toBe("/v1/client/auth/me");
  expect(window.document.getElementById("auth-view").hidden).toBe(false);

  window.document.getElementById("show-register").click();
  window.document.getElementById("register-name").value = "Test Client";
  window.document.getElementById("register-email").value = "test@example.test";
  window.document.getElementById("register-password").value = "correct horse battery";
  window.document.getElementById("register-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.find((call) => call.pathname === "/v1/client/auth/register").init.credentials).toBe("same-origin");
  expect(JSON.parse(calls.find((call) => call.pathname === "/v1/client/auth/register").init.body)).toEqual({
    displayName: "Test Client", email: "test@example.test", password: "correct horse battery",
  });
  expect(window.document.getElementById("dashboard").hidden).toBe(true);
  window.document.getElementById("login-password").value = "correct horse battery";
  window.document.getElementById("login-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(window.document.getElementById("dashboard").hidden).toBe(false);
  expect(calls.some((call) => call.pathname.endsWith("/verify-otp") || call.pathname.endsWith("/resend-otp"))).toBe(false);
  expect(calls.every((call) => !/^\/v1\/v1(?:\/|$)/.test(call.pathname))).toBe(true);

  window.document.getElementById("project-name").value = "Test project";
  const projectForm = window.document.getElementById("project-form");
  const submitProject = () => projectForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  submitProject();
  expect(projectForm.querySelector('button[type="submit"]').disabled).toBe(true);
  submitProject();
  expect(calls.filter((call) => call.pathname === "/v1/client/projects" && call.init.method === "POST")).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const createCall = calls.find((call) => call.pathname === "/v1/client/projects" && call.init.method === "POST");
  expect(JSON.parse(createCall.init.body)).toMatchObject({ name: "Test project", scopes: ["data:read", "data:write", "collections:manage", "usage:read"] });
  expect(createCall.init.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(calls.some((call) => call.pathname.endsWith("/usage"))).toBe(true);
  expect(calls.some((call) => call.pathname.endsWith("/keys"))).toBe(true);
  expect(calls.every((call) => !Object.keys(call.init.headers || {}).some((header) => header.toLowerCase() === "authorization"))).toBe(true);
  expect(script).not.toContain("MAESTRO_ADMIN_TOKEN");
  expect(window.document.getElementById("secret-value").textContent).toMatch(/^pk_/);
  dom.window.close();
});

test("client portal opens immediately after password login without requesting OTP", async () => {
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/client",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, init = {}) => {
    const pathname = String(url);
    calls.push({ pathname, init });
    if (pathname === "/v1/client/auth/me") {
      return { ok: false, status: 401, json: async () => ({ message: "Sign in to access the client portal." }) };
    }
    if (pathname === "/v1/client/auth/login") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ account: { clientId: "client_1", displayName: "Test Client", email: "client@example.test" } }),
      };
    }
    if (pathname === "/v1/client/projects") {
      return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    };
  };
  window.eval(script);
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.document.getElementById("login-email").value = "client@example.test";
  window.document.getElementById("login-password").value = "correct horse battery";
  window.document.getElementById("login-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.map((call) => call.pathname)).toContain("/v1/client/auth/login");
  expect(calls.every((call) => !/^\/v1\/v1(?:\/|$)/.test(call.pathname))).toBe(true);
  expect(window.document.getElementById("dashboard").hidden).toBe(false);
  expect(calls.some((call) => call.pathname.endsWith("/verify-otp") || call.pathname.endsWith("/resend-otp"))).toBe(false);
  dom.window.close();
});

test("client portal handles an idempotent project replay without inventing a lost API key", async () => {
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/client",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  let replayed = false;
  window.fetch = async (url, init = {}) => {
    const pathname = String(url);
    let status = 200;
    let body = {};
    if (pathname === "/v1/client/auth/me") {
      status = 401;
      body = { message: "Sign in to access the client portal." };
    } else if (pathname === "/v1/client/auth/register") {
      body = { account: { clientId: "client_1", displayName: "Test Client", email: "test@example.test" } };
    } else if (pathname === "/v1/client/auth/login") {
      body = { account: { clientId: "client_1", displayName: "Test Client", email: "test@example.test" } };
    } else if (pathname === "/v1/client/projects" && init.method === "POST") {
      replayed = true;
      body = { replayed: true, projectId: "proj_aaaaaaaaaaaa", name: "Test project", note: "The original API key cannot be recovered." };
    } else if (pathname === "/v1/client/projects") {
      body = { projects: replayed ? [{ projectId: "proj_aaaaaaaaaaaa", name: "Test project", status: "active" }] : [] };
    } else if (pathname.includes("/usage")) {
      body = { usage: { requests: 0, queries: 0, inserts: 0, updates: 0, deletes: 0, errors: 0, storageBytes: 0 }, quotas: {} };
    } else if (pathname.endsWith("/keys")) {
      body = { keys: [] };
    } else if (pathname === "/v1/client/projects/proj_aaaaaaaaaaaa") {
      body = { projectId: "proj_aaaaaaaaaaaa", name: "Test project", status: "active", createdAt: new Date(0).toISOString(), collections: [] };
    }
    return { ok: status < 400, status, json: async () => body };
  };
  window.eval(script);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  window.document.getElementById("show-register").click();
  window.document.getElementById("register-name").value = "Test Client";
  window.document.getElementById("register-email").value = "test@example.test";
  window.document.getElementById("register-password").value = "correct horse battery";
  window.document.getElementById("register-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  await completePasswordLogin(window, tick);
  window.document.getElementById("project-name").value = "Test project";
  window.document.getElementById("project-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  expect(window.document.getElementById("secret-value").textContent).toBe("");
  expect(window.document.getElementById("portal-status").textContent).toContain("cannot be recovered");
  dom.window.close();
});

test("Browse Database uses a transient project key, renders nested data, filters the loaded page, and paginates", async () => {
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/client",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const projectId = "proj_aaaaaaaaaaaa";
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: `record-${index}`,
    data: index === 0
      ? { name: "Test Item", details: { color: "blue" } }
      : { name: `Item ${index}` },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  }));
  window.fetch = async (url, init = {}) => {
    const pathname = String(url);
    calls.push({ pathname, init });
    let body = {};
    if (pathname === "/v1/client/auth/me") {
      body = { account: { clientId: "client_1", displayName: "Test", email: "test@example.test" } };
    } else if (pathname === "/v1/client/projects") {
      body = { projects: [{ projectId, name: "Inventory", status: "active" }] };
    } else if (pathname === `/v1/client/projects/${projectId}`) {
      body = {
        projectId, name: "Inventory", status: "active", createdAt: new Date(0).toISOString(),
        collections: [{ collection: "items", dbType: "postgresql" }],
      };
    } else if (pathname.endsWith("/usage")) {
      body = { usage: { requests: 0, queries: 0, inserts: 0, updates: 0, deletes: 0, errors: 0, storageBytes: 0 }, quotas: {} };
    } else if (pathname.endsWith("/keys")) {
      body = { keys: [] };
    } else if (pathname.includes("/browse/items?")) {
      body = { results: new URL(`http://localhost${pathname}`).searchParams.get("offset") === "50" ? [] : rows };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  window.eval(script);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  window.document.querySelector(`[data-id="${projectId}"]`).click();
  await tick();
  await tick();
  const keyInput = window.document.getElementById("browse-api-key");
  keyInput.value = "pk_transient_read_key";
  const collectionSelect = window.document.getElementById("browse-collection");
  collectionSelect.value = "items";
  collectionSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  window.document.getElementById("browse-refresh").click();
  await tick();

  const browseCall = calls.find((call) => call.pathname.includes("/browse/items?"));
  expect(browseCall.init.headers.Authorization).toBe("Bearer pk_transient_read_key");
  expect(browseCall.pathname).toContain("limit=50");
  expect(window.document.getElementById("browse-body").textContent).toContain("Test Item");
  expect(window.document.getElementById("browse-body").textContent).toContain('"color": "blue"');
  expect(window.document.querySelector("#browse-body time[datetime='2026-01-01T00:00:00.000Z']")).not.toBeNull();
  expect(window.document.querySelector("#browse-body time[datetime='2026-01-02T00:00:00.000Z']")).not.toBeNull();
  expect(window.document.getElementById("browse-collection-info").textContent).toContain("postgresql");
  expect(window.document.getElementById("browse-count").textContent).toContain("Further records may exist");
  expect(window.sessionStorage.length).toBe(0);
  expect(window.localStorage.length).toBe(0);

  const search = window.document.getElementById("browse-search");
  search.value = "Test Item";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  expect(window.document.querySelectorAll("#browse-body tr")).toHaveLength(1);

  window.document.getElementById("browse-next").click();
  await tick();
  expect(calls.some((call) => call.pathname.includes("offset=50"))).toBe(true);
  expect(window.document.getElementById("browse-empty").hidden).toBe(false);
  dom.window.close();
});
