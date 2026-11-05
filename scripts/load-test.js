/*
 * Load test against the REAL server process + real PostgreSQL/Redis.
 *   node scripts/load-test.js            (writes benchmarks/results/load.json)
 * Client and server share one machine, so absolute numbers are indicative only.
 */
const fs = require("fs");
const path = require("path");
const { startServer, waitReady, admin, keyed, pct } = require("./_harness");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 32);
const SECONDS = Number(process.env.LOAD_SECONDS || 8);

async function runPhase(name, makeOp) {
  const lat = []; const statuses = {}; const end = Date.now() + SECONDS * 1000; const started = Date.now();
  const worker = async (w) => {
    let i = 0;
    while (Date.now() < end) {
      const t = process.hrtime.bigint();
      let status = 0;
      try { status = await makeOp(w, i++); } catch (e) { status = "exc"; }
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      statuses[status] = (statuses[status] || 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  const secs = (Date.now() - started) / 1000;
  const ok = Object.entries(statuses).filter(([s]) => String(s).startsWith("2")).reduce((a, [, n]) => a + n, 0);
  return { phase: name, requests: lat.length, rps: +(lat.length / secs).toFixed(1), errorRate: +(1 - ok / lat.length).toFixed(4), statuses,
    latencyMs: { p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1), max: +Math.max(...lat).toFixed(1) } };
}

async function main() {
  const server = startServer(PORT, { MAESTRO_RATE_LIMIT_PER_MINUTE: "100000000", MAESTRO_IP_RATE_LIMIT_PER_MINUTE: "100000000", MAESTRO_QUOTA_REQUESTS_PER_MINUTE: "100000000", MAESTRO_MAX_INFLIGHT: "1000", MAESTRO_QUOTA_MAX_DOCUMENTS: "100000000" });
  try {
    await waitReady(BASE);
    const A = admin(BASE);
    const p = (await A("POST", "/v1/projects", { name: "LoadTest" })).body;
    const api = keyed(BASE, p.apiKey);
    const results = { generatedAt: new Date().toISOString(), node: process.version, cpus: require("os").cpus().length, concurrency: CONCURRENCY, secondsPerPhase: SECONDS, phases: [] };

    // seed via bulk import (also measures import throughput)
    const N = 5000;
    const csv = ["id,name,category,price", ...Array.from({ length: N }, (_, i) => `${i},item${i},cat${i % 20},${(i % 500) + 0.5}`)].join("\n");
    const form = new FormData(); form.append("collection", "items"); form.append("idField", "id"); form.append("file", new Blob([csv]), "items.csv");
    const t0 = Date.now();
    const imp = await (await fetch(`${BASE}/v1/import`, { method: "POST", headers: { Authorization: `Bearer ${p.apiKey}` }, body: form })).json();
    results.import = { rows: N, seconds: +((Date.now() - t0) / 1000).toFixed(2), rowsPerSec: Math.round(N / ((Date.now() - t0) / 1000)), status: imp.status, inserted: imp.summary && imp.summary.inserted };

    const warm = { collection: "items", queryType: "select", filters: { category: "cat7" }, limit: 20 };
    await api("POST", "/v1/query", warm);
    results.phases.push(await runPhase("read: cached query (same query)", async () => (await api("POST", "/v1/query", warm)).status));
    results.phases.push(await runPhase("read: uncached query (unique filter)", async (w, i) => (await api("POST", "/v1/query", { collection: "items", filters: { price: { gte: (w * 7 + i) % 490 } }, limit: 20 })).status));
    results.phases.push(await runPhase("read: get by id", async (w, i) => (await api("GET", `/v1/data/items/${encodeURIComponent(String((w * 13 + i) % N))}`)).status));
    results.phases.push(await runPhase("write: insert", async (w, i) => (await api("POST", "/v1/data", { collection: "items", data: { id: 100000 + w * 100000 + i, name: "load", category: "cat1", price: 1.5 } })).status));
    results.phases.push(await runPhase("mixed 70% read / 20% insert / 10% update", async (w, i) => {
      const r = (w * 31 + i) % 10;
      if (r < 7) return (await api("POST", "/v1/query", { collection: "items", filters: { category: `cat${(w + i) % 20}` }, limit: 10 })).status;
      if (r < 9) return (await api("POST", "/v1/data", { collection: "items", data: { id: 900000000 + w * 1000000 + i, name: "mix", category: "cat2", price: 2.5 } })).status;
      return (await api("PUT", `/v1/data/items/${(w + i) % N}`, { data: { id: (w + i) % N, name: "upd", category: "cat3", price: 3.5 } })).status;
    }));

    const metrics = await (await fetch(`${BASE}/metrics`, { headers: { Authorization: `Bearer ${require("./_harness").ADMIN}` } })).text();
    const g = (re) => { const m = metrics.match(re); return m ? Number(m[1]) : null; };
    results.server = { rssMB: Math.round(g(/maestro_process_resident_memory_bytes (\d+)/) / 1048576), heapMB: Math.round(g(/maestro_process_heap_used_bytes (\d+)/) / 1048576),
      cacheHits: g(/maestro_cache_hits_total (\d+)/), cacheMisses: g(/maestro_cache_misses_total (\d+)/), pgPoolMaxConnections: g(/maestro_pg_pool\{kind="connections"\} (\d+)/), pgPoolWaiting: g(/maestro_pg_pool\{kind="waiting"\} (\d+)/) };
    results.server.cacheHitRate = +(results.server.cacheHits / (results.server.cacheHits + results.server.cacheMisses)).toFixed(3);
    fs.mkdirSync(path.join(__dirname, "..", "benchmarks", "results"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "..", "benchmarks", "results", "load.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    // cleanup
    await A("DELETE", `/v1/projects/${p.projectId}?purge=true`);
  } finally {
    server.kill("SIGTERM");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
