/*
 * Failure-injection test against the REAL server process.
 *   node scripts/resilience-test.js
 * Service control commands are configurable (defaults suit a bare-metal/sandbox
 * install; for docker-compose use e.g. RESILIENCE_STOP_REDIS="docker compose stop redis").
 */
const { startServer, waitReady, admin, keyed, sh, ADMIN } = require("./_harness");

const C = {
  stopRedis: process.env.RESILIENCE_STOP_REDIS || "redis-cli shutdown nosave",
  startRedis: process.env.RESILIENCE_START_REDIS || 'redis-server --daemonize yes --save "" --appendonly no --dir /tmp',
  stopPg: process.env.RESILIENCE_STOP_PG || "pg_ctlcluster 16 main stop -m fast",
  startPg: process.env.RESILIENCE_START_PG || "pg_ctlcluster 16 main start",
};
const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

async function waitFor(fn, ms = 20000, every = 300) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(every); } return false; }

async function main() {
  let server = startServer(PORT, { MAESTRO_BREAKER_COOLDOWN_MS: "2000", MAESTRO_BACKEND_RETRIES: "1", MAESTRO_DB_TIMEOUT_MS: "3000", MAESTRO_AUTH_CACHE_TTL_MS: "0" });
  try {
    await waitReady(BASE);
    const A = admin(BASE);
    const proj = (await A("POST", "/v1/projects", { name: "Resilience" })).body;
    const api = keyed(BASE, proj.apiKey);
    for (let i = 0; i < 5; i += 1) await api("POST", "/v1/data", { collection: "items", data: { n: i, name: `item${i}` } });
    const q = { collection: "items", filters: { n: 2 } };

    check("baseline: query works and second identical query is a cache hit", (await api("POST", "/v1/query", q)).body.cached === false && (await api("POST", "/v1/query", q)).body.cached === true);
    let ready = await (await fetch(`${BASE}/ready`)).json();
    check("baseline: /ready is ready (optional backends may be absent)", ready.ready === true, JSON.stringify(ready.dependencies));

    // ---- Redis down ----
    sh(C.stopRedis); await sleep(800);
    let t = Date.now(); const r1 = await api("POST", "/v1/query", q);
    check("Redis down: reads still succeed from the database (cached=false)", r1.status === 200 && r1.body.cached === false && r1.body.resultCount === 1, `${Date.now() - t}ms`);
    const w = await api("POST", "/v1/data", { collection: "items", data: { n: 99, name: "while-redis-down" } });
    check("Redis down: writes still succeed", w.status === 201);
    ready = await (await fetch(`${BASE}/ready`)).json();
    check("Redis down: /ready reports degraded but stays ready (200)", ready.ready === true && ready.status === "degraded" && ready.dependencies.redis === "unavailable");
    const staleProbe = await api("POST", "/v1/query", { collection: "items", filters: { n: 99 } });
    check("Redis down: no stale data (the new row is visible)", staleProbe.body.resultCount === 1);
    sh(C.startRedis);
    check("Redis back: caching resumes without a restart", await waitFor(async () => { await api("POST", "/v1/query", q); return (await api("POST", "/v1/query", q)).body.cached === true; }, 15000));
    // a write made while Redis was down must not be shadowed by an old cached entry after Redis returns
    const post = await api("POST", "/v1/query", { collection: "items", filters: { n: 99 } });
    check("Redis back: data written during the outage is served correctly", post.body.resultCount === 1);

    // ---- PostgreSQL down ----
    sh(C.stopPg); await sleep(1500);
    t = Date.now(); const d1 = await api("POST", "/v1/query", { collection: "items", filters: { n: 3 } });
    const dt = Date.now() - t;
    // The auth lookup itself needs the control-plane DB, so the failure surfaces as a clean 5xx.
    check("PostgreSQL down: request fails fast with 503 storage_unavailable (no hang, no stack)", d1.status === 503 && d1.body.error.code === "storage_unavailable" && !!d1.headers.get("retry-after") && !!(d1.body && d1.body.error && d1.body.error.requestId) && dt < 8000 && !JSON.stringify(d1.body).match(/ECONN|at .*\.js|postgres:/), `status ${d1.status} in ${dt}ms`);
    const h = await fetch(`${BASE}/health`); check("PostgreSQL down: /health (liveness) stays 200", h.status === 200);
    const rd = await fetch(`${BASE}/ready`); check("PostgreSQL down: /ready returns 503", rd.status === 503);
    const burst = await Promise.all(Array.from({ length: 20 }, () => api("POST", "/v1/query", q)));
    check("PostgreSQL down: a burst of 20 requests all fail cleanly (none hang or crash the process)", burst.every((b) => b.status >= 500 || b.status === 401) && server.exitCode === null);
    sh(C.startPg);
    check("PostgreSQL back: service recovers without a restart", await waitFor(async () => (await api("POST", "/v1/query", { collection: "items", filters: { n: 3 } })).status === 200, 30000, 500));
    const all = await api("POST", "/v1/query", { collection: "items", limit: 100 });
    check("PostgreSQL back: no data was lost (6 documents)", all.body.resultCount === 6, `count ${all.body.resultCount}`);

    // ---- kill -9 in the middle of an import ----
    const rows = ["id,name,v", ...Array.from({ length: 40000 }, (_, i) => `${i},row${i},${i % 97}`)].join("\n");
    const form = new FormData(); form.append("collection", "big"); form.append("idField", "id"); form.append("onDuplicate", "skip"); form.append("file", new Blob([rows]), "big.csv");
    const imp = fetch(`${BASE}/v1/import`, { method: "POST", headers: { Authorization: `Bearer ${proj.apiKey}` }, body: form }).catch(() => null);
    await sleep(1200); server.kill("SIGKILL"); await imp;
    await sleep(500);
    server = startServer(PORT, { MAESTRO_AUTH_CACHE_TTL_MS: "0" }); await waitReady(BASE);
    const cnt = (await keyed(BASE, proj.apiKey)("POST", "/v1/query", { collection: "big", queryType: "count" }));
    const partial = cnt.body && cnt.body.resultCount;
    check("kill -9 mid-import: server restarts, collection is usable, rows imported so far are intact", cnt.status === 200 && partial >= 0 && partial < 40000, `${partial}/40000 rows present`);
    const retry = new FormData(); retry.append("collection", "big"); retry.append("idField", "id"); retry.append("onDuplicate", "skip"); retry.append("file", new Blob([rows]), "big.csv");
    const rr = await (await fetch(`${BASE}/v1/import`, { method: "POST", headers: { Authorization: `Bearer ${proj.apiKey}` }, body: retry })).json();
    const total = (await keyed(BASE, proj.apiKey)("POST", "/v1/query", { collection: "big", queryType: "count" })).body.resultCount;
    check("kill -9 mid-import: re-running the SAME file (idField+skip) completes with exactly 40000 rows, no duplicates", total === 40000 && rr.status === "success", `inserted ${rr.summary && rr.summary.inserted}, skipped ${rr.summary && rr.summary.skipped}, total ${total}`);

    // ---- graceful shutdown ----
    // a deliberately slow request (large result) so it is genuinely in flight when SIGTERM arrives
    const inflight = keyed(BASE, proj.apiKey)("POST", "/v1/query", { collection: "big", queryType: "search", text: "row1", fields: ["name"], limit: 1000 });
    await sleep(8);
    server.kill("SIGTERM");
    const res = await inflight;
    check("SIGTERM: an in-flight request still completes", res.status === 200);
    const exited = await waitFor(async () => server.exitCode !== null, 10000, 100);
    check("SIGTERM: process exits cleanly (code 0)", exited && server.exitCode === 0, `exit code ${server.exitCode}`);
    check("SIGTERM: no secrets in server logs", !server.logs().includes(proj.apiKey) && !server.logs().includes(ADMIN));
    server = startServer(PORT, {}); await waitReady(BASE);
    await admin(BASE)("DELETE", `/v1/projects/${proj.projectId}?purge=true`);
  } finally {
    try { server.kill("SIGKILL"); } catch (e) { /* ignore */ }
    sh(C.startPg); sh(C.startRedis);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} resilience checks passed`);
  require("fs").writeFileSync(require("path").join(__dirname, "..", "benchmarks", "results", "resilience.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); sh(C.startPg); sh(C.startRedis); process.exit(1); });
