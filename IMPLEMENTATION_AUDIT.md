# Implementation audit (baseline before the hardening pass)

Audited from the delivered `MAESTRO-DBaaS-Final.zip`, by reading the code and **running** it
(PostgreSQL 16 and Redis 7 were started locally; MongoDB/Elasticsearch/Ollama were not available at baseline).

## Baseline test run
| | Result |
|---|---|
| `npx jest` with no services | 459 passed, **1 failed** (`workflow.integration` "cache hit" needs a live Redis but did not skip) |
| `npx jest` with real PostgreSQL + Redis | 460/460 passed; but `integration/postgres` and `integration/redis` **never exited** (leaked handles) |
| MongoDB / Elasticsearch / Ollama suites | "passed" by silently returning early — **not exercised**, and Jest reported them as green |

## What existed and worked
Project/API-key control plane (hashed keys), logical collections, adapters for PostgreSQL/MongoDB/Elasticsearch,
project-scoped `/v1/data` + `/v1/query`, rule-based + optional-Ollama routing, Redis cache with project-prefixed keys,
usage counters, dashboard panel, JS SDK, 460 unit/integration tests.

## Defects and gaps found (severity as assessed for a *deployed* service)
| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Every legacy route was unauthenticated** — `POST /database/create`, `/database/import`, `/metadata`, `/profile`, `/analysis/store`, `/v1/query/federated`, legacy `POST /v1/query`, `/connections/status` … Anyone able to reach the port could create databases, import data and read global metadata. | **Critical** | Fixed: all are operator-only (`MAESTRO_ADMIN_TOKEN`) |
| 2 | Operator routes **failed open**: with no `MAESTRO_ADMIN_TOKEN` and `NODE_ENV!=production` the control plane (create/delete projects, mint keys) was open | High | Fixed: fail closed; explicit `MAESTRO_INSECURE_DEV=true` needed; ephemeral token generated for dev |
| 3 | Production could start with no/weak admin token, no key pepper, default `postgres` password | High | Fixed: startup refuses (see `SECURITY.md`) |
| 4 | API keys had no scopes, expiry or rotation | Medium | Fixed |
| 5 | No security headers, CORS policy, request ids, structured logs, metrics, readiness probe, graceful shutdown, backpressure or request timeouts | Medium | Fixed |
| 6 | Cache invalidation was *scan-and-delete* after a write: a read that started before a write could re-populate the cache with pre-write data (stale-after-write race) | Medium | Fixed: atomic per-collection version counter; race proven by test |
| 7 | `docker-compose.prod.yml` used `ports: []`, which Compose **merges** with the base file, so database ports stayed published | High | Fixed: `ports: !reset []` (Compose ≥ 2.24) — *config reviewed, not run (no Docker here)* |
| 8 | Prod compose allowed `POSTGRES_PASSWORD` to default to `postgres` | High | Fixed: `${…:?}` required |
| 9 | Dockerfile on Node 20 (end-of-life) and `chown -R` duplicating the whole app layer | Low | Fixed: Node 22, `COPY --chown` |
| 10 | Project purge aborted at the first failing store, leaving earlier stores purged and the project half-deleted without saying so | Medium | Fixed: per-store outcomes, project kept on failure, idempotent retry |
| 11 | No bulk import with validation, dry run, duplicate handling or per-row error reporting | Medium (feature) | Added `POST /v1/import` |
| 12 | Collection limit returned HTTP 400 rather than a quota error; no document/storage/rate quotas | Low | Fixed: per-project quotas, 403 `quota_exceeded` |
| 13 | Shipped ZIP contained test pollution (`data/metadata.json` with `maestro_real_test_*` entries, `dump.rdb`, `uploads/*`) | Low | Fixed: excluded; tests now use a temp data dir and drop their databases |
| 14 | Idempotent retries of project creation impossible; duplicate create under concurrency possible | Low | Fixed: `Idempotency-Key` + unique index |
| 15 | Router: long free-text datasets (articles, reviews, tickets) were routed to PostgreSQL — rule engine underweighted paragraph-sized text (79 % benchmark accuracy) | Medium | Fixed: documented long-text signal (100 % on the benchmark — see caveats in `BENCHMARK_REPORT.md`) |
| 16 | Router warnings could embed backend error text (hostnames) that reached API responses | Low | Fixed |
| 17 | No circuit breaker/retry/timeouts on storage backends; connection loss surfaced as 502/500 | Medium | Fixed: breaker, bounded read retries, timeouts, 503 + `Retry-After` |
| 18 | Control-plane pool starvation deadlock found *during this work* in the new idempotent create (a second pooled connection requested while holding the first) | High (new code) | Found by a live concurrency test, fixed |

## Route inventory (all classified; enforced by `tests/security/route-inventory.test.js`)
Public: `GET /`, `/health`, `/ready`, `/v1/openapi.yaml`.
Operator token: `/metrics`, `/v1/projects…`, `/v1/audit`, and every legacy route (`/database/*`, `/profile`, `/partition/*`,
`/analysis/store`, `/metadata*`, `/routing/recommend`, `/connections/status`, `/v1/query` without a project key, `/v1/query/federated`).
Project key (+scope): `/v1/project`, `/v1/collections*`, `/v1/data*`, `/v1/query`, `/v1/import`, `/v1/imports`, `/v1/usage`.

## Not verifiable at baseline (and still not, see TEST_REPORT.md)
Real MongoDB, real Elasticsearch, real Ollama, Docker/Compose, a real browser, GitHub Actions.
