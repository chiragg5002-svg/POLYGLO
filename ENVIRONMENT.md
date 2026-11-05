# Environment Variables

Full reference for every environment variable MAESTRO / POLYGLODB reads.
Copy [`.env.example`](./.env.example) to `.env` to get sensible local
defaults that match [`docker-compose.yml`](./docker-compose.yml) — most
setups need no changes at all.

Nothing in this table is a cloud API key or a cloud connection string —
every service this project talks to (Postgres, MongoDB, Elasticsearch,
Redis, Ollama) is expected to be local. See
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)'s "Future work"
section for the explicit statement that cloud equivalents are untested.

## Server

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PORT` | `3000` | `server.js` | Port the Express app listens on when run directly (`npm start`). Not used when the app is `require()`d as a module (e.g. by tests) — see the `require.main === module` guard in `server.js`. |
| `NODE_ENV` | *(unset)* | `server.js` | Set to `production` to suppress raw error detail in HTTP error responses (`sendError()` returns only a generic fallback message instead of `fallbackMessage: <error.message>`). Any other value (including unset) behaves as development. |

## PostgreSQL

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PG_HOST` | `localhost` | `database-service.js`, `query-engine.js` | Also used by `/connections/status` to decide whether Postgres shows as "ready" vs "pending" (presence check only, not a live ping). |
| `PG_PORT` | `5432` | same | |
| `PG_USER` | `postgres` | same | |
| `PG_PASSWORD` | `postgres` | same | Never returned in any API response or logged; see `redact.js`. |
| `PG_DATABASE` | `postgres` | `database-service.js`'s `createDatabase()` | The administrative database connected to in order to run `CREATE DATABASE`. Imports/queries connect directly to the target database name instead. |

## MongoDB

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `MONGO_URI` | `mongodb://localhost:27017` | `database-service.js`, `query-engine.js` | Full connection string. If it embeds credentials (`mongodb://user:pass@host`), they are never echoed back — see `redact.js` and `API_CACHING.md`'s security section. |

## Elasticsearch

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | `database-service.js`, `query-engine.js` | No authentication is configured against this URL anywhere in the app; the bundled `docker-compose.yml` runs Elasticsearch with `xpack.security.enabled=false` for local development only. |

## Redis (query result cache)

See [`API_CACHING.md`](./API_CACHING.md) for full caching behavior.

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `REDIS_URL` | *(unset)* | `query-cache.js` | If unset, caching is a no-op from the start — no connection is ever attempted, and every `/v1/query` response has `"source": "database"`. Example: `redis://localhost:6379`. |
| `QUERY_CACHE_ENABLED` | `true` | `query-cache.js` | Set the literal string `"false"` to disable caching entirely even with `REDIS_URL` set. Any other value (including unset) means enabled. |
| `QUERY_CACHE_TTL_SECONDS` | `60` | `query-cache.js` | How long a cached result stays valid. Non-numeric or non-positive values silently fall back to the default. |

## Local Ollama (LLM-assisted routing)

See [`API_ROUTING.md`](./API_ROUTING.md) for the full rules-first/
Ollama-second/fallback behavior. **Not a cloud API** — `gemini-service.js`,
despite its filename, only ever calls a local Ollama instance over plain
HTTP; it has no code path to any cloud LLM provider.

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `OLLAMA_HOST` | `127.0.0.1` | `gemini-service.js` | |
| `OLLAMA_PORT` | `11434` | `gemini-service.js` | |
| `OLLAMA_MODEL` | `llama3.2:3b` | `gemini-service.js` | Must already be pulled locally (`ollama pull <model>`) or the call fails and routing falls back to rules. |
| `OLLAMA_TIMEOUT_MS` | `30000` | `gemini-service.js` | If Ollama takes longer than this to respond (e.g. a cold model load), the request is aborted and routing falls back to rules — this is a guard against a hung connection, not a tuning knob for expected response time. |

If Ollama is unreachable at all (nothing listening on `OLLAMA_HOST:OLLAMA_PORT`),
routing falls back to the deterministic rules immediately — this is normal,
expected behavior, not an error condition. The UI shows an explicit
"Ollama unavailable" banner when this happens (see `README.md` → Frontend).

## Cross-database query federation (prototype)

See [`API_FEDERATION.md`](./API_FEDERATION.md) for what these limits
protect against ("prevent uncontrolled full-database scans").

| Variable | Default | Absolute ceiling | Read by | Notes |
| --- | --- | --- | --- | --- |
| `FEDERATION_MAX_SOURCE_ROWS` | `2000` | `10000` | `federation-engine.js` | Hard cap on rows fetched from **each** side of a join, regardless of what a client requests. The ceiling applies even if this env var is set higher. |
| `FEDERATION_DEFAULT_RESULT_ROWS` | `200` | `5000` | `federation-engine.js` | Final joined-result row limit used when a client doesn't specify one. |
| `FEDERATION_MAX_RESULT_ROWS` | `1000` | `5000` | `federation-engine.js` | Maximum final joined-result row limit a client can request. |
| `FEDERATION_TIMEOUT_MS` | `10000` | `60000` (floor `1000`) | `federation-engine.js` | Overall wall-clock budget for fetching both sources of a federated query; a client-supplied `timeoutMs` is clamped into `[1000, 60000]` regardless of this default. |

## DBaaS platform (projects, API keys, `/v1/data`)

See [DBaaS.md](DBaaS.md). The operator token is mandatory in production;
client email sign-in additionally requires `MAESTRO_OTP_PEPPER`, `SMTP_HOST`,
and `SMTP_FROM`.

| Variable | Default | Purpose |
|---|---|---|
| `MAESTRO_ADMIN_TOKEN` | _(empty)_ | Operator credential: `/v1/projects*`, `/v1/audit`, `/metrics` and **all legacy routes**. ≥ 32 chars and mandatory in production (startup refuses otherwise). |
| `MAESTRO_INSECURE_DEV` | `false` | Development-only: run operator routes without credentials. Refused in production. |
| `MAESTRO_KEY_PEPPER` | _(empty)_ | HMAC secret for API-key hashes. **Mandatory in production** (≥ 32 chars). Set once, before issuing keys; changing it invalidates all keys. |
| `MAESTRO_CONTROL_DB` | `maestro_control` | PostgreSQL database holding projects/keys/mappings/usage. |
| `MAESTRO_RATE_LIMIT_PER_MINUTE` | `600` | Requests per API key per minute. |
| `MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE` | `30` | Failed authentications per IP per minute before 429. |
| `MAESTRO_OTP_PEPPER` | _(empty)_ | HMAC key for client login OTP verifiers. Required in production; use at least 32 random bytes and keep it stable across instances/restarts. In non-production, a process-only random key is generated, so pending challenges stop working after restart. |
| `MAESTRO_OTP_ACCOUNT_RATE_LIMIT_PER_MINUTE` | `5` | Client login/resend requests per account per minute (in addition to source-IP limits). |
| `SMTP_HOST` | _(empty)_ | SMTP hostname used to deliver client login verification codes. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | Set `true` for implicit TLS (commonly port 465); STARTTLS is used by the SMTP server on submission ports when available. |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | _(empty)_ | SMTP authentication credentials. Gmail requires the full account address and a Google App Password; do not use the normal Google account password. |
| `SMTP_FROM` | _(empty)_ | Configured sender address. For Gmail, use the authenticated account or a verified send-as alias. No OTP is returned by the API or written to logs. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Reject invalid SMTP TLS certificates; do not disable in production. |
| `MAESTRO_AUTO_CREATE_COLLECTIONS` | `true` | Create a collection on first `POST /v1/data`. |
| `MAESTRO_MAX_COLLECTIONS_PER_PROJECT` | `50` | |
| `MAESTRO_MAX_DOCUMENT_BYTES` | `262144` | |
| `MAESTRO_MAX_QUERY_LIMIT` / `MAESTRO_DEFAULT_QUERY_LIMIT` | `1000` / `50` | |
| `MAESTRO_ROUTING_USE_OLLAMA` | `true` | Use local Ollama when routing new collections (falls back to rule-based). |

For Gmail, use `SMTP_HOST=smtp.gmail.com` with either port `587` and
`SMTP_SECURE=false` (STARTTLS is required) or port `465` and
`SMTP_SECURE=true` (implicit TLS). Google App Passwords are commonly displayed
with grouping spaces; enter the password without those spaces. Delivery failure
logs contain only a request ID, a coarse failure category, an allowlisted SMTP
error code, and a numeric SMTP response code; they never include the message,
recipient, OTP, or SMTP credentials.
| `MAESTRO_ROUTING_TIMEOUT_MS` | `8000` | Abandon a slow Ollama call. |
| `MAESTRO_ROUTING_MIN_CONFIDENCE` | `30` | Below this the router defaults to PostgreSQL. |
| `MAESTRO_CONTROL_STORE` | _(unset)_ | `memory` = throw-away in-memory control plane for demos (refused in production). |

## Variables that exist in older `.env` files but are not used

If you're working from an older `.env` in this repository, you may see:

| Variable | Status |
| --- | --- |
| `GEMINI_API_KEY` | **Not read anywhere in the codebase.** `gemini-service.js`'s name is historical — it only calls local Ollama (see above), never Google's Gemini API or any other cloud LLM. Safe to remove; kept out of `.env.example` for this reason. |

## Precedence and validation notes

- All numeric env vars are parsed with `Number(...)`; a non-numeric or
  empty value falls back to the documented default rather than producing
  `NaN` behavior — each module does its own `Number.isFinite`/
  `Number.isInteger` check before trusting the parsed value.
- None of these variables are validated at server startup — an invalid
  `PG_HOST`, for example, only surfaces as a connection error the next
  time something tries to use it (reported through the normal
  `status: "error"` response shape, not a crash).
- `.env` is loaded once, at process start, via `dotenv` in
  `database-service.js`. Changing `.env` requires restarting the server.

### Added in 1.0 (see DEPLOYMENT.md for the full table)
| Variable | Default | Purpose |
|---|---|---|
| `MAESTRO_CORS_ORIGINS` | _(none)_ | Exact allowed browser origins (comma-separated; `*` is ignored/refused). |
| `MAESTRO_TRUST_PROXY` | _(off)_ | Reverse-proxy hop count for real client IPs. |
| `MAESTRO_IP_RATE_LIMIT_PER_MINUTE` | `1200` | Per-IP request limit. |
| `MAESTRO_MAX_INFLIGHT` / `MAESTRO_REQUEST_TIMEOUT_MS` / `MAESTRO_SHUTDOWN_TIMEOUT_MS` | `200` / `30000` / `15000` | Load shedding, request timeout, drain time. |
| `MAESTRO_DB_TIMEOUT_MS` / `MAESTRO_BACKEND_RETRIES` / `MAESTRO_BREAKER_THRESHOLD` / `MAESTRO_BREAKER_COOLDOWN_MS` | `10000` / `2` / `5` / `10000` | Backend timeouts, read retries, circuit breaker. |
| `MAESTRO_AUTH_CACHE_TTL_MS` / `MAESTRO_USAGE_FLUSH_MS` | `5000` / `1000` | Auth cache TTL (0 = strict revocation); usage batching. |
| `MAESTRO_QUOTA_MAX_DOCUMENTS` / `…_MAX_STORAGE_BYTES` / `…_MAX_IMPORT_ROWS` / `…_REQUESTS_PER_MINUTE` | `1000000` / `1 GiB` / `50000` / `600` | Default per-project quotas. |
| `MAESTRO_MAX_IMPORT_BYTES` | `10485760` | Upload cap for `/v1/import`. |
| `MAESTRO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `MAESTRO_DATA_DIR` / `MAESTRO_UPLOAD_DIR` / `MAESTRO_IMPORT_TMP` | repo dirs / tmp | Runtime directories (tests point them at a temp dir). |
