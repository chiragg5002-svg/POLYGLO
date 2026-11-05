# Deployment & operations runbook

> **Honesty note:** the Docker/Compose files were reviewed and linted (YAML parses; `!reset`/`!override` semantics checked against the Compose spec)
> but **could not be executed** in the environment this release was built in (no Docker daemon). Run `docker compose config` first on your host.
> Everything else in this document was exercised against real PostgreSQL + Redis (see `TEST_REPORT.md`).

## 1. Required configuration (production)
Generate secrets: `openssl rand -base64 48`.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV=production` | yes | enables fail-closed validation, hides error detail |
| `MAESTRO_ADMIN_TOKEN` | **yes**, ≥ 32 chars | operator credential |
| `MAESTRO_KEY_PEPPER` | **yes**, ≥ 32 chars | keyed hash for API keys. **Changing it invalidates every API key.** |
| `MAESTRO_OTP_PEPPER` | **yes**, ≥ 32 bytes | HMAC key for OTP verifiers; keep stable across instances/restarts |
| `SMTP_HOST`, `SMTP_FROM` | **yes for client sign-in** | SMTP delivery for client email OTP; configure TLS/auth as required |
| `PG_HOST/PG_PORT/PG_USER/PG_PASSWORD` | yes (password not a default) | PostgreSQL (control plane + data) |
| `MONGO_URI`, `ELASTICSEARCH_URL`, `REDIS_URL` | optional per feature | stores/cache; Redis outage degrades to "no cache", never errors |
| `MAESTRO_CORS_ORIGINS` | optional | comma-separated **exact** origins (no `*`) |
| `MAESTRO_TRUST_PROXY` | behind a proxy | number of proxy hops (e.g. `1`) |
| `MAESTRO_AUTH_CACHE_TTL_MS` | 5000 | `0` = strict revocation, more control-plane load |
| `MAESTRO_USAGE_FLUSH_MS` | 1000 | usage counters are batched; a hard crash loses ≤ this interval |
| `MAESTRO_QUOTA_*`, `MAESTRO_MAX_COLLECTIONS_PER_PROJECT` | see `ENVIRONMENT.md` | default per-project quotas (override per project via API) |
| `MAESTRO_IP_RATE_LIMIT_PER_MINUTE`, `MAESTRO_RATE_LIMIT_PER_MINUTE`, `MAESTRO_MAX_INFLIGHT`, `MAESTRO_REQUEST_TIMEOUT_MS` | 1200 / 600 / 200 / 30000 | rate limits, load shedding, request timeout |
| `MAESTRO_DB_TIMEOUT_MS`, `MAESTRO_BACKEND_RETRIES`, `MAESTRO_BREAKER_THRESHOLD`, `MAESTRO_BREAKER_COOLDOWN_MS` | 10000 / 2 / 5 / 10000 | backend timeouts, read retries, circuit breaker |
| `MAESTRO_MAX_IMPORT_BYTES` | 10 MiB | upload cap |
| `MAESTRO_LOG_LEVEL` | info | `debug|info|warn|error|silent` |
| `MAESTRO_INSECURE_DEV` | never in prod | development-only unauthenticated mode (refused in production) |

## 2. Docker Compose
```bash
cp .env.docker.example .env.docker      # fill every secret
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml config   # validate first
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
The prod overlay removes published DB ports (`!reset`, Compose ≥ 2.24), binds the API to `127.0.0.1` (put a TLS proxy in front), drops capabilities,
sets `stop_grace_period: 25s`, and refuses to start without the required secrets.
Verify: `curl -s localhost:3000/ready` → `{"status":"ok"|"degraded",...}`; `docker compose ps` shows healthy.

## 3. Probes
* **Liveness** `GET /health` — process is up (no dependency checks).
* **Readiness** `GET /ready` — 200 when the control plane DB is reachable; Redis/MongoDB/Elasticsearch problems show as `"degraded"` (still 200); 503 when the control plane is down or the process is draining. Route traffic on `/ready`.
* **Metrics** `GET /metrics` (operator token) — Prometheus text: request counts/latency histogram, in-flight, auth failures, rate-limit/quota/backpressure rejections, cache hits/misses, PostgreSQL pool connections/waiting, circuit-breaker state, RSS/heap.
Suggested alerts: `maestro_circuit_breaker_open > 0`, readiness failing > 1 min, 5xx ratio, `maestro_pg_pool{kind="waiting"} > 0` sustained, `maestro_auth_failures_total` spike.

## 4. Graceful shutdown
`SIGTERM`/`SIGINT`: `/ready` turns 503 immediately, in-flight requests finish, usage counters flush, pools and Redis close, exit 0 (forced exit after `MAESTRO_SHUTDOWN_TIMEOUT_MS`, default 15 s). Verified by `scripts/resilience-test.js`.

## 5. Upgrading an existing installation
Migrations are versioned (`schema_migrations`), transactional, serialised by an advisory lock, and **additive only** — nothing is dropped or rewritten.
On first DBaaS request the control plane upgrades itself through the latest migration (currently v1–v6). Migrations 5 and 6 add OTP/rate-limit and usage/billing/invoice tables; existing project data and keys are preserved. The new migrations have not been run against a reachable PostgreSQL service in this development environment, so test on a staging copy before production. **Take and verify a control-plane backup first** (`BACKUP_RESTORE.md`), for example:
```bash
pg_dump --format=custom --file=maestro-control-before-otp-billing.dump "$MAESTRO_CONTROL_DB"
```

After deploying, verify migration versions in `schema_migrations`, complete a test client login through SMTP, and exercise the billing capture/reconciliation APIs before issuing invoices. `MAESTRO_OTP_PEPPER`, `SMTP_HOST`, and `SMTP_FROM` must be configured for client login in production; otherwise login fails closed.

Manual rollback (only if you must go back to the old release; the old code ignores the new columns, so rollback is usually just redeploying the old image). To remove the additions:
```sql
-- v3
DROP TABLE IF EXISTS import_jobs;
-- v2
DROP TABLE IF EXISTS audit_events;
ALTER TABLE storage_mappings DROP CONSTRAINT IF EXISTS storage_mappings_type_chk;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_status_chk, DROP COLUMN IF EXISTS scopes, DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS rotated_from;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_chk, DROP COLUMN IF EXISTS quotas, DROP COLUMN IF EXISTS idempotency_hash;
DROP INDEX IF EXISTS projects_idempotency_idx, api_keys_project_status_idx, audit_events_project_idx, import_jobs_project_idx;
DELETE FROM schema_migrations WHERE id IN (2,3);
```
Dropping `scopes` turns all keys back into full-access keys.

Only if intentionally rolling back the OTP/billing schema as well as the
application (after taking a verified backup), remove migrations 6 and 5 in
reverse order. Preserve migration 4 and earlier:
```sql
BEGIN;
DROP TABLE IF EXISTS invoice_payments, invoice_items, billing_audit_log, invoices;
DROP SEQUENCE IF EXISTS maestro_invoice_number_seq;
DROP TABLE IF EXISTS client_billing_profiles, storage_snapshots, daily_usage, usage_events, billing_plans;
DELETE FROM schema_migrations WHERE id = 6;
DROP TABLE IF EXISTS client_otp_challenges, client_auth_rate_limits;
DELETE FROM schema_migrations WHERE id = 5;
COMMIT;
```
This removes billing history and OTP challenges; do not run it as a routine
application rollback.

### Daily usage capture

`npm run billing:daily` snapshots current project storage and reconciles the
previous UTC day. Schedule it once per day with the service environment and
working directory configured (for example, a systemd timer or Windows Task
Scheduler); the application does not install a scheduler. Ensure the task
reports nonzero exits and alert on missed runs. Repeat runs are idempotent.
Invoices should only be generated after the period's daily captures and usage
reconciliation are complete. Incomplete storage/transfer measurements block
draft creation rather than being treated as zero.

## 6. Scaling notes
Instances are stateless except: the in-memory rate limiters (per instance — behind N instances the effective limit is N×), the auth cache (≤ TTL staleness), the mapping cache (10 s) and the usage buffer (≤ 1 s). Use a shared limiter at your proxy for strict global limits.
The cache is correct across instances (versions live in Redis).

## 7. Operating checklist
1. Secrets set, `NODE_ENV=production`, TLS proxy in front, DB ports closed. 2. `/ready` green. 3. Backups scheduled and a restore rehearsed (`npm run test:backup`).
4. Dependency audit actioned (`SECURITY.md`). 5. Alerts on §3 metrics. 6. Retention policy for `audit_events` (contains IPs).
