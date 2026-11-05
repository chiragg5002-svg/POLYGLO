# Changelog

## 1.0.0 — hardening & completion release
**Security** — operator auth on all legacy routes (fail closed); scopes, expiry, rotation; brute-force limiting; security headers, CORS allow-list, CSP; production startup validation; request ids; secret-safe structured logs; audit trail; dashboard sends operator token (sessionStorage).
**Data plane** — `POST /v1/import` (CSV/TSV/JSON/NDJSON, dry run, per-row errors, duplicates policy, 207 partial); per-project quotas; idempotent project creation; atomic version-based cache invalidation; typed `duplicate_id`.
**Reliability** — circuit breaker + bounded read retries + timeouts; 503/`Retry-After`; readiness vs liveness; graceful shutdown; backpressure; request timeouts; per-store purge outcomes; fixed pool-starvation deadlock.
**Operations** — versioned migrations; `/metrics`; backup/restore scripts (tested); load, resilience and routing benchmarks; CI workflow; secret scanner; hardened Dockerfile/compose.
**Performance** — auth cache + batched usage writes (1.5–2.9× throughput on the benchmark box).
**Routing** — long free-text signal; router warnings sanitised.
**SDK** — typed errors, safe retries, `importFile`, key never printed/serialised.
**Tests** — 460 → 727 tests (702 pass, 25 skipped for unavailable services) (incl. route inventory, live concurrency/isolation, adapter conformance, migrations upgrade, failure injection).
