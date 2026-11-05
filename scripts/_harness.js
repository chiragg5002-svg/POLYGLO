/* Shared helpers for scripts/load-test.js and scripts/resilience-test.js: spawn the real server. */
const { spawn, execSync } = require("child_process");
const path = require("path");
require("dotenv").config({ quiet: true });

const ADMIN = "harness-admin-token-0123456789abcdefghij";
const ROOT = path.join(__dirname, "..");

function startServer(port, extraEnv = {}) {
  const env = {
    ...process.env, PORT: String(port), NODE_ENV: "development", MAESTRO_ADMIN_TOKEN: ADMIN, MAESTRO_INSECURE_DEV: "false",
    MAESTRO_LOG_LEVEL: "warn", QUERY_CACHE_ENABLED: "true", MAESTRO_ROUTING_USE_OLLAMA: "false",
    MAESTRO_CONTROL_DB: process.env.MAESTRO_CONTROL_DB || "maestro_control_harness",
    MAESTRO_DATA_DIR: require("os").tmpdir() + "/maestro-harness-data", MAESTRO_UPLOAD_DIR: require("os").tmpdir() + "/maestro-harness-up",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.logs = () => out;
  return child;
}

async function waitReady(base, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy");
}

const admin = (base) => async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const keyed = (base, key) => async (method, p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
const sh = (cmd) => { try { execSync(cmd, { stdio: "pipe" }); return true; } catch (e) { return false; } };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

module.exports = { startServer, waitReady, admin, keyed, sh, pct, ADMIN };
