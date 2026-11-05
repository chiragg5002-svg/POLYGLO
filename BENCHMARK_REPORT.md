# Benchmark report

Reproduce: `npm run bench:routing`, `npm run bench:load`, `npm run test:resilience`. Raw output: `benchmarks/results/*.json`.
**Environment (all numbers below):** one sandbox VM, **1 vCPU**, Node 22, PostgreSQL 16 + Redis 7 on the same host, load generator on the same host.
Absolute throughput is therefore *indicative only* (client, API, PostgreSQL and Redis compete for one core). Relative before/after comparisons use the same machine.

## 1. Routing quality (`benchmarks/routing`)
77 synthetic labeled datasets (28 relational → PostgreSQL, 25 nested/semi-structured → MongoDB, 24 free-text/log → Elasticsearch) including **11 "hard" cases**
(misleading file names like `logs.csv` that is purely relational, flat JSON, tabular data with no semantic column names, data containing prompt-injection text).

| Strategy | Accuracy | Hard-case accuracy | p50 / p95 latency |
|---|---|---|---|
| always PostgreSQL | 36.4 % (28/77) | 54.5 % (6/11) | – |
| naive 3-rule shape heuristic | 98.7 % (76/77) | 90.9 % (10/11) | 0.03 / 0.13 ms |
| **production router, rule-only (Ollama off)** — *before* fix | **79.2 %** | – | 0.5 / 3 ms |
| **production router, rule-only — after long-text fix** | **100 %** (77/77); precision = recall = 1.0 for all three stores | 100 % (11/11) | 0.51 / 4.05 ms (≈ 900 decisions/s) |
| router + Ollama (hybrid) | **NOT MEASURED** — no Ollama in the build environment. Run `ollama serve`, `ollama pull llama3.2:3b`, then `npm run bench:routing`. | | |

**How to read this honestly**
* The baseline run exposed a real defect: the rule engine under-weighted paragraph-sized text, so all 24 free-text datasets were misrouted (79.2 % overall). A documented signal was added (`store-analysis-engine.js`, "long free-text values").
* **Circularity / overfitting risk:** labels and datasets were written by the same author, and the fix was tuned *after seeing* these results. 100 % means "agrees with my labels on my synthetic data", not "optimal in production". Re-running with other generator seeds (11, 4242) gives the same 77/77, but they are the same distribution.
* The trivial 3-rule heuristic scores 98.7 %: on clearly-shaped data the extra machinery adds little; its value is in mixed signals, explanations/confidence, and the optional LLM — which is **unmeasured**.
* LLM *safety* (not accuracy) is tested: malformed/hostile/hung model output never escapes the store allow-list and never changes the deterministic fallback (`tests/dbaas/routing-safety.test.js`).

## 2. Throughput & latency (`scripts/load-test.js`, real server process, real PostgreSQL + Redis)
32 concurrent clients, 6 s per phase, 5 000-row collection, all HTTP 2xx (error rate 0 in every phase).

| Phase | **Before** req/s (p95) | **After** req/s (p50 / p95 / p99 ms) |
|---|---|---|
| read: same query (Redis hit) | 343 (129 ms) | **624** (45 / 93 / 123) |
| read: unique filter (cache miss → PG) | 392 (114 ms) | **849** (32 / 73 / 116) |
| read: get by id | 501 (96 ms) | **1 446** (19 / 41 / 57) |
| write: insert | 423 (103 ms) | **660** (45 / 71 / 86) |
| mixed 70 % read / 20 % insert / 10 % update | 337 (121 ms) | **601** (50 / 82 / 103) |

"Before" = after the security hardening but *before* the auth cache and batched usage writes: every request did 2 control-plane SELECTs + 1 UPDATE. The 1.5–2.9× gain comes from removing them (trade-off: ≤ 5 s revocation lag across instances, ≤ 1 s usage-counter loss on a hard crash — both configurable).
Bulk import: **5 000 rows in 2.5 s ≈ 2 000 rows/s** (per-row inserts, concurrency 8). Server RSS 153 MB, heap 39 MB; PostgreSQL pool 4 connections, 0 waiting; cache hit rate 78 % over the run.

**Surprising result, reported as-is:** the *cached* query (624 req/s) was **slower** than the *uncached* one (849 req/s). With a tiny table on a local PostgreSQL sharing one core, a Redis round trip (version GET + value GET) costs as much as the SQL query. Caching pays off when queries are expensive or the database is remote — not demonstrated by this benchmark. We did not benchmark that case.
Not measured: sustained soak (hours), memory growth, multi-instance scaling, MongoDB/Elasticsearch throughput, large-file imports (> 10 MB cap), p99.9.

## 3. Failure injection (`scripts/resilience-test.js`) — 19/19 passed against the real server
| Scenario | Observed |
|---|---|
| Redis stopped | reads served from PostgreSQL (`cached:false`, 9 ms), writes succeed, `/ready` = degraded but 200, no stale data; caching resumes automatically after Redis returns |
| PostgreSQL stopped | requests fail in ~5 ms with **503 `storage_unavailable` + `Retry-After`** (no hang, no stack/host leak), `/health` 200, `/ready` 503, 20-request burst: all clean failures, process alive; service **recovers without restart**; **no data lost** |
| `kill -9` during a 40 000-row import | restart OK, 2 088 rows present (partial), collection usable; re-running the **same file** with `idField` + `onDuplicate=skip` finishes with exactly 40 000 rows, 0 duplicates |
| `SIGTERM` with a request in flight | request completes, exit code 0, no secrets in logs |

Not exercised: MongoDB/Elasticsearch outage (not available), network partitions/latency injection, disk-full, Redis `maxmemory` eviction.
