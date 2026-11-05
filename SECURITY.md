# Security model

## Trust boundaries

The `/client` portal is a separate client-account surface; registration and sign-in are public credential-exchange routes, while account, project, key, and usage operations require a client session.

| Actor | Credential | Can do |
|---|---|---|
| **Operator** | `MAESTRO_ADMIN_TOKEN` (≥ 32 chars in production) | Control plane (projects, keys, quotas, audit, purge), `/metrics`, and the *internal* legacy tools (global metadata, arbitrary database import, federated query). The legacy tools are **not tenant-scoped**, so they are operator-only by design. |
| **Project key** | `Authorization: Bearer pk_<id>_<secret>` | Only its own project's collections/data, limited to the key's **scopes** |
| Anonymous | none | `/health`, `/ready`, UI shell, OpenAPI document |

A client can never choose its project: the project id is derived from the key. A `projectId` in a body, query string or
`X-Project-Id` header that differs from the key's is rejected with 403.

## Authentication
* Client passwords are stored as scrypt hashes. Portal sessions use random opaque tokens in `HttpOnly`, `SameSite=Strict` cookies; only SHA-256 token hashes are persisted, and sessions expire after seven days.
* Client authentication endpoints are rate limited per IP by `MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE`; state-changing portal requests enforce same-origin checks.
* API keys are random 256-bit secrets, stored only as a keyed hash (HMAC with `MAESTRO_KEY_PEPPER`), compared in constant time, shown once.
* Operator token compared in constant time. Failed attempts are rate limited per IP (`MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE`, default 30) → 429.
* Scopes: `data:read`, `data:write`, `collections:manage`, `import`, `usage:read` (default for new keys: all). Missing scope → 403 `insufficient_scope`.
* Expiry (`expiresInDays`/`expiresAt`), revocation, and **rotation** with an optional grace period (≤ 7 days).
* An in-process auth cache (`MAESTRO_AUTH_CACHE_TTL_MS`, default 5000 ms) avoids two DB queries per request. Revoke/rotate/delete performed on an instance
  take effect there **immediately**; **other instances may honour a revoked key for up to the TTL**. Set it to `0` for strict revocation.

## Fail-closed startup (production)
The process refuses to start when: admin token missing/short/weak; `MAESTRO_KEY_PEPPER` missing/short; `PG_PASSWORD` empty or a well-known value;
`MAESTRO_INSECURE_DEV=true`; `MAESTRO_CONTROL_STORE=memory`; or `MAESTRO_CORS_ORIGINS` contains `*`.
In development with no token, a random ephemeral operator token is generated and printed once; `MAESTRO_INSECURE_DEV=true` is the only way to run unauthenticated.

## Input handling
Collection/field names are allow-listed (`^[a-z][a-z0-9_]{0,47}$`, no `$`, no `__proto__`); operators are allow-listed; values are always bound parameters
(PostgreSQL) / typed filter documents (MongoDB) / structured DSL (Elasticsearch) — never concatenated. LIKE wildcards are escaped.
JSON bodies ≤ 2 MB (streaming limit), `application/json` required (415 otherwise). Uploads: allow-listed extensions, size cap, random temp names, deleted after the request.
Errors never include stack traces, connection strings or keys; every error carries a `requestId`.

## Transport/browser
Security headers on every response (`nosniff`, `X-Frame-Options: DENY`, strict CSP with no inline script, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API paths, HSTS in production/HTTPS).
CORS is an exact-origin allow-list (`MAESTRO_CORS_ORIGINS`), no wildcard, no credentials. **Terminate TLS at a reverse proxy**; set `MAESTRO_TRUST_PROXY=<hops>`.
The dashboard keeps the operator token in `sessionStorage` only and adds it only
to explicitly requested, allow-listed operator routes. It is never attached
globally to client data requests; all server-provided strings are HTML-escaped.

## Multi-tenancy
Client account routes verify the requested project's `owner_client_id` against the authenticated session before reading project details, keys, or usage. Existing operator-created projects remain unowned by clients.

Chain for every operation: `key → projectId → collection → storage mapping (looked up by projectId+collection) → adapter → physical store`.
Adapters re-validate that identifiers match the mapping's project. Redis keys start with the projectId. Physical names are derived from the projectId.
Proven on real PostgreSQL + Redis (`tests/live/*`, 12 concurrent workers across two tenants using the same collection name) and by the adapter conformance suite.

## Audit & logging
Administrative actions (project/key/quota/collection/import) are recorded in `audit_events` with actor, request id and IP — never secrets.
Logs are JSON, one line per request (no query strings, no bodies), with secret-looking fields/values redacted.
IP addresses are personal data under some regimes: they are stored in `audit_events` — apply your retention policy.

## Known vulnerable dependencies (`npm audit --omit=dev`, 2026-10-11) — owner action required
`npm audit fix` was **not** run (project rule). All findings have semver-compatible fixes; update deliberately and re-run `npm test`:

| Package | Severity | Via | Relevance here |
|---|---|---|---|
| `proxy-addr` | **critical** (IP spoofing via IPv4-mapped IPv6 trust subnet) | express | Only matters when `MAESTRO_TRUST_PROXY` is set (rate limits/audit IP). Prefer a proxy that overwrites `X-Forwarded-For`. |
| `multer` (direct) | high (DoS: crafted field names; fd leak on abort) | direct | Upload routes require authentication and a size cap first. |
| `path-to-regexp` | high (ReDoS) | express | Routes are static patterns; low practical exposure. |
| `undici` | high | mongodb/elasticsearch client chain | Outbound client only. |
| `body-parser` | low, `qs` moderate | express | JSON body limit enforced. |

## Reporting
Open a private issue with reproduction steps. Rotate `MAESTRO_ADMIN_TOKEN` and `MAESTRO_KEY_PEPPER` after any suspected exposure
(rotating the pepper invalidates all existing API keys — re-issue them).
