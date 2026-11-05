# Test report

## Environment (where these results were produced)
Linux 6.18 (1 vCPU sandbox) · Node v22.22.2 / npm 10.9.7 · **PostgreSQL 16.15 (real)** · **Redis 7.0.15 (real)** ·
**FerretDB 1.24.0 as a MongoDB-wire-compatible server over PostgreSQL — NOT real MongoDB** · Elasticsearch: **not available** · Ollama: **not available** ·
Docker: **not available** · real browser: **not available**.
Jest probes services once before the run (`tests/global-setup.js`) and prints e.g.
`[live-services] pg=UP redis=UP mongo=UP es=down ollama=down [mongo kind: compat-only (FerretDB)]`; suites for missing services are **SKIPPED** (visible in the summary), never silently green.

## Final full-suite run (after the last code change)
Command: `npx jest --runInBand --forceExit --coverage` (also `npm test`). Run **three times consecutively** plus a JSON-reporter run: identical results each time.

| | Count |
|---|---|
| Test suites | 33 passed, 2 skipped (all tests inside them skipped), 0 failed — 35 total |
| **Tests** | **702 passed, 0 failed, 25 skipped — 727 total** |

| Area | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|
| legacy/root suites (profiling, routing, federation, caching, workflow…) | 280 | 0 | 0 | existing 460-test baseline, preserved |
| `tests/dbaas` (platform, units, import, resilience, routing safety, query safety) | 223 | 0 | 0 | fake drivers + in-memory control plane |
| `tests/security` (route inventory, auth/scopes/quotas, OpenAPI sync, secret scan) | 61 | 0 | 0 | |
| `tests/sdk` | 24 | 0 | 0 | |
| `tests/ui` (jsdom) | 7 | 0 | 0 | DOM only, no layout |
| `tests/conformance` (adapter contract) | 72 | 0 | 19 | PostgreSQL (real), Mongo-compatible (real wire), Mongo/ES adapters over fakes |
| `tests/live` (real PostgreSQL + Redis) | 19 | 0 | 1 | 1 = Elasticsearch live flow |
| `tests/integration` (legacy real-service suites) | 16 | 0 | 5 | |

**Skipped (25) and why — all "service unavailable":** Elasticsearch live conformance 18 + live DBaaS flow 1 + legacy ES integration 3 = **22 need a real Elasticsearch**;
Ollama integration 2 **need Ollama**; 1 **unscoped `$text` search** conformance case is skipped because the Mongo server here is FerretDB (it requires real MongoDB's wildcard text index). 22 + 2 + 1 = 25.
**These paths are UNVERIFIED against real services.**

**Coverage (meaningful paths, thresholds enforced in `package.json`: stmts 80 / branches 65 / funcs 80 / lines 80):**
All measured files: **89.4 % statements, 80.0 % branches, 85.7 % functions, 92.7 % lines** (`dbaas/`, `adapters/`, `sdk/`, `query-cache.js`). Weak spots: `logger.js` ~40 %, `metrics.js` ~57 % (rendering), `ops.js` branches, `postgres-store.js` ~65 % (also exercised by out-of-process scripts, which Jest cannot count).

## What was verified against REAL services (not mocks)
* PostgreSQL + Redis: whole DBaaS data plane (`tests/live/dbaas-live`), 40 concurrent project creations, two tenants × 12 workers hammering the same collection name with read-your-writes/cross-tenant/stale-cache checks (run 3× in a row, 0 violations), migrations (fresh + **upgrade from the original schema preserving data**), idempotent creation under 25-way concurrency (this found and fixed a pool deadlock), CHECK constraints, audit/import tables, adapter conformance (full contract incl. injection payloads, isolation, 200 KB docs, unicode, pagination).
* MongoDB wire protocol (FerretDB): full conformance except unscoped `$text`; live DBaaS flow; legacy Mongo integration suite.
* Real server process: load test, failure injection (19/19), backup/restore loop, curl demo (`scripts/demo.sh`).

## Out-of-Jest scripts (exact commands and results)
| Command | Result |
|---|---|
| `node scripts/resilience-test.js` | **19/19 PASS** (Redis down/up, PostgreSQL down/up, `kill -9` mid-import + idempotent re-run, SIGTERM drain, no secrets in logs) |
| `node scripts/backup-restore-test.js` | **6/6 PASS** (backup+checksums, refuses without `--yes`, refuses corrupt backup, same key works after restore, 25/25 documents, writes work) |
| `node scripts/load-test.js` | measured — see `BENCHMARK_REPORT.md` (0 % errors in all phases) |
| `node benchmarks/routing/run.js` | measured — see `BENCHMARK_REPORT.md` (Ollama hybrid: NOT MEASURED) |
| `bash scripts/demo.sh` (against a live server) | PASS — all 7 steps behaved as documented |
| `node scripts/secret-scan.js` | clean on the release tree (the scanner itself is tested to detect keys/private keys/URL credentials/`.env`) |
| `npm audit --omit=dev` | **6 vulnerabilities reported (1 critical, 3 high, 1 moderate, 1 low), NOT fixed** — see `SECURITY.md` |

## NOT RUN / BLOCKED — exact commands for you
| Item | Why | Run locally |
|---|---|---|
| `docker compose up -d` and the prod overlay | no Docker daemon here | `docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml config && docker compose up -d --build` |
| Real MongoDB + Elasticsearch live tests | services unavailable | `docker compose up -d mongodb elasticsearch redis postgres && npm run test:live` (expect 0 skipped except Ollama) |
| Ollama hybrid routing benchmark | Ollama unavailable | `ollama serve & ollama pull llama3.2:3b && npm run bench:routing` |
| Real-browser dashboard check | no browser | `npm start`, open `http://localhost:3000`, paste the printed operator token in *Developer Platform* |
| GitHub Actions | no runner | push; `.github/workflows/ci.yml` |
| Soak / multi-instance / MongoDB+ES load | out of scope here | `LOAD_SECONDS=300 npm run bench:load` against your stack |
| Lint/format | none configured in the project | – |

## Known test-suite caveats
Jest needs `--forceExit` (an unidentified open handle when the legacy integration group runs together; each file exits cleanly alone). The legacy business-logic suites run with `MAESTRO_INSECURE_DEV=true` (set in `tests/setup-env.js`) — authentication is proven by `tests/security/*` with that flag off.
During this work three assertions were found to be flaky (random secret substring) and fixed; the suite was then run repeatedly with no failures.

## Clean-extract validation of the final ZIP (Phase 11/12)
The archive was extracted into an empty directory and exercised with only documented commands (PostgreSQL/Redis/FerretDB running locally; no Elasticsearch/Ollama/Docker):

| Step | Command | Actual result |
|---|---|---|
| Install | `npm ci` | 490 packages, OK (no `.env` in the archive) |
| A. Minimal env (no `.env`, no `REDIS_URL`) | `PG_HOST=localhost PG_PASSWORD=… npm test` | exit 0 — **684 passed, 0 failed, 43 skipped** (Redis-dependent and ES/Ollama tests show as skipped: `[live-services] pg=UP redis=down mongo=UP es=down`) |
| B. Documented setup | `cp .env.example .env && npm test` | exit 0 — **702 passed, 0 failed, 25 skipped** (`redis=UP`; skips = Elasticsearch/Ollama/FerretDB-`$text`) |
| Production fail-closed | `NODE_ENV=production node server.js` with no secrets | exit 1: "Refusing to start with unsafe configuration" (admin token, key pepper) |
| Start | `npm start` | prints ephemeral operator token; `/health` ok; `/ready` ready+degraded (Elasticsearch absent); unauthenticated `POST /database/create` → 401; with token `GET /metadata/summary` → 200 |
| Demo | `MAESTRO_ADMIN_TOKEN=… ./scripts/demo.sh` | all 7 steps as documented (dry-run, import, idempotent re-import, cache miss→hit, `insufficient_scope`, usage/audit, rotation + purge) |
| Secret scan of the extracted tree | `node scripts/secret-scan.js` | clean |
| Archive content check | `unzip -l` | no `.env`, `node_modules`, `dump.rdb`, `metadata.json`, uploads, `state.json`, logs, coverage |

(This section was added after the validation run. The archive differs from the validated one only in `TEST_REPORT.md` and `CHANGELOG.md`; verified by a file-by-file comparison.)
