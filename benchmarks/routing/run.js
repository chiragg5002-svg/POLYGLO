/*
 * Routing benchmark: reproduces the numbers in BENCHMARK_REPORT.md.
 *   node benchmarks/routing/run.js            (writes benchmarks/results/routing.json)
 *
 * Compared strategies:
 *   always-postgres   baseline: everything goes to PostgreSQL
 *   shape-heuristic   3-rule baseline: nested->mongo, long text->es, else pg
 *   router(rule-only) production router with Ollama disabled (deterministic)
 *   router(hybrid)    rule-based + Ollama — only measured if Ollama is reachable
 */
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { build, CLASSES } = require("./dataset");
const { recommendStorage } = require("../../dbaas/intelligent-router");

const isObj = (v) => v && typeof v === "object";
function shapeHeuristic(rows) {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  let nested = 0; let longText = 0;
  for (const k of keys) {
    if (rows.some((r) => isObj(r[k]))) nested += 1;
    const avg = rows.reduce((a, r) => a + (typeof r[k] === "string" ? r[k].length : 0), 0) / rows.length;
    if (avg > 120) longText += 1;
  }
  return nested ? "mongodb" : longText ? "elasticsearch" : "postgresql";
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

function metrics(preds, data) {
  const correct = preds.filter((p, i) => p === data[i].label).length;
  const perClass = {};
  for (const c of CLASSES) {
    const tp = preds.filter((p, i) => p === c && data[i].label === c).length;
    const fp = preds.filter((p, i) => p === c && data[i].label !== c).length;
    const fn = preds.filter((p, i) => p !== c && data[i].label === c).length;
    perClass[c] = { precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null, support: tp + fn };
  }
  const hardIdx = data.map((d, i) => (d.hard ? i : -1)).filter((i) => i >= 0);
  const hardCorrect = hardIdx.filter((i) => preds[i] === data[i].label).length;
  return { accuracy: +(correct / data.length).toFixed(3), correct, total: data.length, hardAccuracy: +(hardCorrect / hardIdx.length).toFixed(3), hardCorrect, hardTotal: hardIdx.length, perClass };
}

async function ollamaUp() {
  try { const c = new AbortController(); setTimeout(() => c.abort(), 1000); await fetch(`http://${process.env.OLLAMA_HOST || "127.0.0.1"}:${process.env.OLLAMA_PORT || 11434}/api/tags`, { signal: c.signal }); return true; } catch (e) { return false; }
}

async function main() {
  const data = build();
  const out = { generatedAt: new Date().toISOString(), node: process.version, datasets: data.length, classCounts: Object.fromEntries(CLASSES.map((c) => [c, data.filter((d) => d.label === c).length])), hardCases: data.filter((d) => d.hard).length, strategies: {} };

  out.strategies["always-postgres"] = { ...metrics(data.map(() => "postgresql"), data), latencyMs: { p50: 0, p95: 0 }, fallbackRate: 0 };
  const shapePreds = []; const shapeLat = [];
  for (const d of data) { const t = performance.now(); shapePreds.push(shapeHeuristic(d.rows)); shapeLat.push(performance.now() - t); }
  out.strategies["shape-heuristic"] = { ...metrics(shapePreds, data), latencyMs: { p50: +pct(shapeLat, 50).toFixed(3), p95: +pct(shapeLat, 95).toFixed(3) }, fallbackRate: 0 };

  const run = async (opts) => {
    const preds = []; const lat = []; const wrong = []; let fallbacks = 0; const t0 = performance.now();
    for (const d of data) {
      const t = performance.now();
      const r = await recommendStorage(d.rows, d.name, opts);
      lat.push(performance.now() - t);
      preds.push(r.dbType);
      if (r.source === "fallback") fallbacks += 1;
      if (r.dbType !== d.label) wrong.push({ dataset: d.name, expected: d.label, got: r.dbType, source: r.source, confidence: r.confidence, hard: d.hard });
    }
    const wall = (performance.now() - t0) / 1000;
    return { ...metrics(preds, data), latencyMs: { p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), p99: +pct(lat, 99).toFixed(2) }, throughputPerSec: +(data.length / wall).toFixed(1), fallbackRate: +(fallbacks / data.length).toFixed(3), wrong };
  };
  out.strategies["router(rule-only)"] = await run({ useOllama: false });

  if (await ollamaUp()) out.strategies["router(hybrid)"] = await run({ useOllama: true });
  else out.strategies["router(hybrid)"] = { status: "NOT MEASURED: Ollama is not reachable in this environment. Run `ollama serve` + `ollama pull llama3.2:3b` and re-run this script." };

  fs.mkdirSync(path.join(__dirname, "..", "results"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "results", "routing.json"), JSON.stringify(out, null, 2));
  const row = (n, m) => (m.accuracy === undefined ? `${n.padEnd(20)} ${m.status}` : `${n.padEnd(20)} acc ${(m.accuracy * 100).toFixed(1)}% (${m.correct}/${m.total})  hard ${(m.hardAccuracy * 100).toFixed(1)}% (${m.hardCorrect}/${m.hardTotal})  p50 ${m.latencyMs.p50}ms p95 ${m.latencyMs.p95}ms  fallback ${(m.fallbackRate * 100).toFixed(1)}%`);
  console.log(`datasets: ${out.datasets}  classes: ${JSON.stringify(out.classCounts)}  hard: ${out.hardCases}`);
  for (const [n, m] of Object.entries(out.strategies)) console.log(row(n, m));
  const rb = out.strategies["router(rule-only)"];
  console.log("per-class (rule-only):", JSON.stringify(rb.perClass));
  console.log(`rule-only misrouted ${rb.wrong.length}:`); rb.wrong.forEach((w) => console.log(`  ${w.dataset}: expected ${w.expected}, got ${w.got} [${w.source}, conf ${w.confidence}]${w.hard ? " (hard)" : ""}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
