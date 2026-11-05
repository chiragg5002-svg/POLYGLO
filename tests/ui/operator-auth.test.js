const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "views", "index.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
const authJs = fs.readFileSync(path.join(ROOT, "public", "auth.js"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const platformJs = fs.readFileSync(path.join(ROOT, "public", "platform.js"), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function boot({ token, validToken, operatorUnavailable = false } = {}) {
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, init = {}) => {
    const headers = new window.Headers(init.headers || {});
    const authorization = headers.get("authorization");
    const pathName = String(url);
    calls.push({ path: pathName, authorization });
    if (pathName === "/ready") {
      return { ok: true, status: 200, json: async () => ({ status: "ok", ready: true, dependencies: { controlPlane: "ok", redis: "ok" } }) };
    }
    const authorized = Boolean(validToken && authorization === `Bearer ${validToken}`);
    let status = authorized ? 200 : 401;
    let body = { success: false, message: "Operator credentials required." };
    if (operatorUnavailable && !authorized) {
      status = 503;
      body = { success: false, message: "Operator access is not configured." };
    }
    if (pathName === "/metadata/table" && authorized) body = [];
    if (pathName === "/metadata/summary" && authorized) body = {
      totalDatabases: 2, totalImports: 1, createdDatabases: 2,
      failedOperations: 0, localPlacements: 0, lastUpdated: null,
    };
    if (pathName === "/v1/projects" && authorized) body = { projects: [] };
    if (pathName === "/v1/billing/clients" && authorized) body = { clients: [{
      client_id: "client-test", display_name: "Billing client", billing_name: "Billing profile",
      email: "billing@example.test", project_count: 1, purchase_order: "PO-1",
    }] };
    if (pathName === "/v1/billing/plans" && authorized) body = { plans: [{
      plan_id: "pro", name: "Pro", active: true, pricing_configured: true,
      monthly_fee_paise: 100, storage_paise_per_gb_month: 200,
      requests_per_unit: 1000, request_unit_paise: 50, transfer_paise_per_gb: 25,
    }] };
    if (pathName === "/v1/billing/invoices" && authorized) body = { invoices: [{
      invoiceId: "invoice-test", invoiceNumber: "MST-TEST-001", clientId: "client-test",
      periodStart: "2026-10-01", periodEnd: "2026-10-31", status: "issued", amountDuePaise: "123",
    }] };
    if (pathName.startsWith("/v1/billing/audit") && authorized) body = { events: [{
      occurred_at: "2026-10-23T00:00:00.000Z", actor: "operator",
      action: "billing.plan.update", reason: "verified pricing",
    }] };
    return { ok: status < 400, status, json: async () => body };
  };
  if (token) window.sessionStorage.setItem("maestro_admin_token", token);
  window.eval(authJs);
  window.eval(appJs);
  window.eval(platformJs);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  return { dom, window, calls, $: (id) => window.document.getElementById(id) };
}

test("missing credentials show a sign-in prompt without requesting protected metadata", async () => {
  const { dom, calls, $ } = boot();
  await tick();
  expect(calls.map((call) => call.path)).toContain("/ready");
  expect(calls.some((call) => call.path.startsWith("/metadata/"))).toBe(false);
  expect(calls.some((call) => call.path === "/v1/projects")).toBe(false);
  expect($("metadata-table-body").textContent).toContain("Authenticate in Developer Platform");
  expect($("summary-status").textContent).toContain("Authenticate");
  expect($("platform-auth-status").textContent).toContain("sign-in required");
  expect($("platform-create-project").disabled).toBe(true);
  const banner = $("global-error-banner");
  expect(banner).toBeNull();
  dom.window.close();
});

test("a valid operator token loads operator metadata and billing data", async () => {
  const { dom, calls, $ } = boot({ token: "operator-test-token", validToken: "operator-test-token" });
  await tick();
  expect(calls.some((call) => call.path === "/metadata/table" && call.authorization?.startsWith("Bearer "))).toBe(true);
  expect(calls.some((call) => call.path === "/metadata/summary" && call.authorization?.startsWith("Bearer "))).toBe(true);
  expect(calls.some((call) => call.path === "/v1/projects" && call.authorization?.startsWith("Bearer "))).toBe(true);
  for (const path of ["/v1/billing/clients", "/v1/billing/plans", "/v1/billing/invoices", "/v1/billing/audit?limit=100"]) {
    expect(calls.some((call) => call.path === path && call.authorization?.startsWith("Bearer "))).toBe(true);
  }
  expect($("metadata-table-body").textContent).toContain("No metadata yet");
  expect($("billing-client-profiles").textContent).toContain("Billing client");
  expect($("billing-invoice-list").textContent).toContain("MST-TEST-001");
  expect($("billing-audit-list").textContent).toContain("billing.plan.update");
  expect($("platform-auth-status").textContent).toContain("authenticated");
  expect($("platform-create-project").disabled).toBe(false);
  expect($("query-submit").disabled).toBe(false);
  const banner = $("global-error-banner");
  expect(!banner || banner.style.display === "none").toBe(true);
  dom.window.close();
});

test("operator helper allows billing GET, POST, PUT and CSV paths only", async () => {
  const { dom, window, calls } = boot({ token: "operator-test-token", validToken: "operator-test-token" });
  await tick();
  for (const [path, method] of [
    ["/v1/billing/clients", "GET"],
    ["/v1/billing/storage-snapshots", "POST"],
    ["/v1/billing/plans/pro", "PUT"],
    ["/v1/billing/export.csv?kind=invoices", "GET"],
  ]) {
    await window.maestroOperatorFetch(path, { method });
    expect(calls[calls.length - 1]).toMatchObject({
      path,
      authorization: expect.stringMatching(/^Bearer /),
    });
  }

  const beforeRejectedRequests = calls.length;
  expect(() => window.maestroOperatorFetch("/v1/client/billing/usage")).toThrow("not an operator-only");
  expect(() => window.maestroOperatorFetch("/v1/billingish/clients")).toThrow("not an operator-only");
  expect(() => window.maestroOperatorFetch("/v1/billing/not-real")).toThrow("not an operator-only");
  expect(() => window.maestroOperatorFetch("/v1/billing/clients", { method: "POST" })).toThrow("not an operator-only");
  expect(() => window.maestroOperatorFetch("/v1/billing/invoices/id/review", { method: "GET" })).toThrow("not an operator-only");
  expect(() => window.maestroOperatorFetch("https://evil.example/v1/billing/clients")).toThrow("only be sent to this origin");
  expect(calls).toHaveLength(beforeRejectedRequests);
  dom.window.close();
});

test("billing CSV authorization failures invalidate the operator session", async () => {
  const { dom, window, $ } = boot({ token: "operator-test-token", validToken: "operator-test-token" });
  await tick();
  const fetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    if (String(url).startsWith("/v1/billing/export.csv")) {
      return { ok: false, status: 401, json: async () => ({ message: "Operator credentials required." }) };
    }
    return fetch(url, init);
  };
  $("billing-export").click();
  await tick();
  expect(window.sessionStorage.getItem("maestro_admin_token")).toBeNull();
  expect($("platform-auth-status").textContent).toMatch(/token was rejected/i);
  expect($("billing-admin-status").textContent).toContain("Operator credentials required.");
  dom.window.close();
});

test("operator credentials are never inherited by ordinary client data requests", async () => {
  const { dom, window, calls } = boot({ token: "operator-test-token", validToken: "operator-test-token" });
  await tick();
  const before = calls.length;
  await window.fetch("/v1/data/items");
  expect(calls[calls.length - 1]).toMatchObject({ path: "/v1/data/items", authorization: null });
  await window.fetch("/v1/query", { method: "POST", body: "{}" });
  expect(calls[calls.length - 1]).toMatchObject({ path: "/v1/query", authorization: null });
  await window.maestroOperatorFetch("/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(calls[calls.length - 1].authorization).toMatch(/^Bearer /);
  expect(() => window.maestroOperatorFetch("/v1/data/items")).toThrow("not an operator-only");
  expect(calls).toHaveLength(before + 3);
  dom.window.close();
});

test("entering a valid operator token loads metrics and stores it only for this tab", async () => {
  const { dom, window, calls, $ } = boot({ validToken: "new-operator-token" });
  await tick();
  $("platform-admin-token").value = "  new-operator-token  ";
  $("platform-token-save").click();
  await tick();
  expect(window.sessionStorage.getItem("maestro_admin_token")).toBe("new-operator-token");
  expect(window.localStorage.getItem("maestro_admin_token")).toBeNull();
  expect(calls.some((call) => call.path === "/metadata/table" && call.authorization?.startsWith("Bearer "))).toBe(true);
  expect($("metadata-status").textContent).toBe("");
  dom.window.close();
});

test("invalid credentials are cleared and protected actions remain disabled", async () => {
  const { dom, window, $ } = boot({ token: "bad-token", validToken: "good-token" });
  await tick();
  expect(window.sessionStorage.getItem("maestro_admin_token")).toBeNull();
  expect($("platform-admin-token").value).toBe("");
  expect($("platform-create-project").disabled).toBe(true);
  expect($("platform-refresh").disabled).toBe(true);
  expect($("platform-auth-status").textContent).toMatch(/rejected/i);
  dom.window.close();
});

test("sign-out clears visible operator results and summary metrics", async () => {
  const { dom, window, $ } = boot({ token: "operator-test-token", validToken: "operator-test-token" });
  await tick();
  $("summary-databases").textContent = "42";
  $("query-results").textContent = "private result";
  $("platform-token-clear").click();
  await tick();
  expect($("summary-databases").textContent).toBe("Authenticate to load");
  expect($("query-results").textContent).toBe("");
  expect($("metadata-table-body").textContent).toContain("Authenticate");
  expect($("platform-create-project").disabled).toBe(true);
  dom.window.close();
});

test("unconfigured operator access is distinguished from an invalid token", async () => {
  const { dom, $ } = boot({ token: "some-token", operatorUnavailable: true });
  await tick();
  expect($("platform-auth-status").textContent).toMatch(/not configured/i);
  expect($("platform-create-project").disabled).toBe(true);
  dom.window.close();
});

test("the client portal bundle never contains or sends operator credentials", () => {
  const client = fs.readFileSync(path.join(ROOT, "public", "client.js"), "utf8");
  expect(client).not.toContain("MAESTRO_ADMIN_TOKEN");
  expect(client).not.toContain("maestro_admin_token");
  expect(client).not.toContain("headers.Authorization");
});
