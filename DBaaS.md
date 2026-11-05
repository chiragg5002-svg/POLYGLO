# MAESTRO as an Intelligent Database-as-a-Service

Developers build their own frontend/backend. MAESTRO is their database: they
talk to **one HTTPS + API-key API**; MAESTRO decides whether each collection
lives in PostgreSQL, MongoDB or Elasticsearch, and caches reads in Redis.

```
Developer backend ──HTTPS + "Authorization: Bearer pk_…"──▶ MAESTRO API
   Authentication ─▶ projectId (server-side) ─▶ logical collection
   ─▶ storage mapping ─▶ adapter ─▶ PostgreSQL | MongoDB | Elasticsearch   (+ Redis)
```

Everything here is **additive**: the original dashboard, `/database/*`, `/profile`,
`/routing/*`, `/partition/*`, `/v1/query` (internal engine), `/v1/query/federated`
etc. work exactly as before. Code lives in `dbaas/`, `adapters/`, `sdk/`.

## Control plane vs data plane

| | Control plane | Data plane |
|---|---|---|
| Auth | `MAESTRO_ADMIN_TOKEN` | project API key (`pk_…`) |
| Endpoints | `/v1/projects…` | `/v1/collections`, `/v1/data`, `/v1/query`, `/v1/usage`, `/v1/project` |
| Stores | metadata in PostgreSQL database `maestro_control` | the project's own data |

Control-plane tables (`maestro_control`): `projects`, `api_keys` (SHA-256/HMAC hash
only), `collections`, `storage_mappings`, `usage`, `client_accounts`, and
`client_sessions`, OTP challenges/rate limits, and billing/usage/invoice records.
Project ownership is nullable for backward compatibility. Created with
`CREATE … IF NOT EXISTS`; migrations only add structures.

## Client Portal

Open `/client` from the MAESTRO frontend to register or sign in. Client
accounts are independent of the operator token. Passwords are stored as
`scrypt` hashes; browser sessions use random opaque tokens in `HttpOnly`,
`SameSite=Strict` cookies, while only token hashes are persisted. Registration
creates an account but does not authenticate it. Password login currently
issues the session immediately after the existing password check; it does not
send or require an email OTP. Login still applies IP and account rate limits,
and existing session-cookie protections and expiration remain in force. OTP
challenge storage and verification/resend routes are retained for future
re-enablement but are not part of the normal login flow.

After signing in at `/client`, use the **Billing** navigation item for the
dedicated dashboard at `/client/billing` (the portal link opens it in a new
tab). It shows the assigned plan, billing period, measured usage, explicitly
estimated charges, invoices, and outstanding payment status. The **Download
billing CSV** action exports only that signed-in client's plan, estimates,
invoices, and recorded payment entries. Issued invoices also have individual
PDF downloads. Both downloads require the authenticated client session.
New accounts start on Free. Existing clients retain their legacy demonstration
plan. Pro and Enterprise are listed but unavailable for selection until an
operator configures their prices. A client plan change is scheduled for the
next billing period, so it does not retroactively change the current period.

The portal creates active projects owned by the signed-in account and issues
the initial project key once. Additional keys default to `data:read`; choose
only the scopes the application needs (`data:read`, `data:write`,
`collections:manage`, `import`, `usage:read`). The operator-only project
deletion, quota changes, and provisioning routes are not exposed to clients.
Client project lists, details, key operations, and usage are checked against
the authenticated owner on every request. Existing projects remain
operator-owned and are not automatically assigned to any client.

The global metadata catalog and legacy database tools are operator-only. Use
the dashboard's Developer Platform token prompt for those actions; a client
account session or project API key does not grant access. Client applications
use only their project API key and its scopes on the data-plane endpoints.

Migrations 4–7 add account ownership, OTP, billing structures, and client plan
subscriptions; they run automatically on the next DBaaS request, preserving
existing project data and keys. Password-only client login does not require
SMTP or `MAESTRO_OTP_PEPPER`. To re-enable OTP login later, restore the OTP
challenge creation and email-delivery step in `POST /v1/client/auth/login`,
then restore the Client Portal verification/resend UI and its tests. The OTP
routes, storage, and configuration remain available. See
[ENVIRONMENT.md](./ENVIRONMENT.md) for SMTP options. Default quotas come from
the existing `MAESTRO_QUOTA_*` settings. As in the existing DBaaS flow,
project metadata and its first API key are created at onboarding, while
physical collection storage is provisioned when the first collection is
created or written.

### Client authentication and billing

| Method & path | Purpose |
|---|---|
| `POST /v1/client/auth/register` `{displayName,email,password}` | create an account; no session is issued |
| `POST /v1/client/auth/login` `{email,password}` | verify password and immediately issue a client session cookie |
| `POST /v1/client/auth/verify-otp` `{challengeId,otp}` | retained OTP challenge endpoint; normal login does not create a challenge |
| `POST /v1/client/auth/resend-otp` `{challengeId}` | retained OTP resend endpoint; normal login does not create a challenge |
| `GET /v1/client/billing/plans` | list available plans and configured prices |
| `PUT /v1/client/billing/subscription` `{planId}` | schedule a plan change for the next billing period |
| `GET /v1/client/billing/usage` | current UTC-month-to-date usage and incomplete/complete estimate |
| `GET /v1/client/billing/invoices` / `…/:invoiceId` | owned invoice history/details |
| `GET /v1/client/billing/invoices/:invoiceId/pdf` | download PDF for an owned invoice |
| `GET /v1/client/billing/payments` | manual payment records |
| `GET /v1/client/billing/export.csv` | download this client's billing summary and history |
| `PUT /v1/client/billing/profile` | update billing name/address/contact/reference |
| `GET /v1/billing/usage?clientId=…&start=YYYY-MM-DD&end=YYYY-MM-DD` | operator usage and measurement status |
| `POST /v1/billing/storage-snapshots` `{date?}` | capture project storage for the UTC date |
| `POST /v1/billing/reconcile` `{start,end,projectId?}` | idempotently aggregate daily request/transfer events |
| `POST /v1/billing/invoices/drafts` `{clientId,periodStart,periodEnd}` | generate a period-unique invoice draft |
| `POST /v1/billing/invoices/:invoiceId/review` `{reason}` | record the review transition |
| `POST /v1/billing/invoices/:invoiceId/issue` `{reason,dueDate?}` | issue a reviewed invoice and freeze its PDF snapshot |
| `POST /v1/billing/invoices/:invoiceId/void` `{reason}` | void an unpaid invoice with an audit entry |
| `POST /v1/billing/payments` `{invoiceId,amountPaise,reference}` | record an authorized manual payment; does not move money |
| `GET /v1/billing/plans` / `PUT /v1/billing/plans/:planId` | list and configure monthly and usage rates for each operator-managed plan |
| `GET /v1/billing/audit`, `GET /v1/billing/export.csv` | operator audit history and CSV export |

The legacy `demo-inr-v1` INR plan is explicitly demonstrative: ₹20 per
allocated GB-month, ₹5 per 100,000 authenticated API requests, and ₹10 per
decimal GB of measured outbound transfer. It remains assigned to existing
accounts during upgrade. New accounts use the zero-priced Free plan. Pro and
Enterprise pricing is intentionally unconfigured until an operator enters and
reviews the actual prices; the portal will not let a client select a plan with
unconfigured pricing. Configure the plan ID (`free`, `pro`, or `enterprise`),
monthly fee and usage rates in the operator billing panel. Existing invoices
retain their immutable pricing snapshot. Calculations use integer paise.
Subscriptions are per client; a scheduled change takes effect at the next
monthly UTC boundary. Estimated amounts are not invoices or completed charges.
Storage is engine-reported allocated size for each project collection/index,
not logical document bytes: PostgreSQL uses `pg_total_relation_size` (table,
indexes and TOAST), MongoDB sums `storageStats.storageSize` and
`storageStats.totalIndexSize`, and Elasticsearch uses index stats' total store
size (which reflects the engine's primary and replica shard totals). These
measures are not directly comparable across engines and may include
engine/shard overhead. Storage is sampled daily
and charged as calendar-day-weighted GB-month using decimal GB (1,000,000,000
bytes). Missing storage or transfer measurements block draft generation; a
failed storage measurement is never treated as zero.

API requests authenticated with a project key are metered per request,
including failed API responses; retries count separately. Outbound transfer is
measured from response `Content-Length`; responses without a measurable length
are marked unavailable rather than assigned a fabricated quantity. Health,
operator, and client portal routes are not metered. Reconciliation and daily
snapshots are idempotent, but usage counters are best-effort and can be lost
within the existing usage flush interval after a hard process crash.

Invoices are marked **DEMO — NOT A TAX INVOICE**. No GST, tax registration,
tax/discount/credit adjustments, real payment processing, or provider identity
is asserted. The lifecycle is draft → reviewed → issued → partially/fully
paid (overdue is derived from the due date); unpaid invoices may be voided.
Payment rows are explicitly operator-recorded bookkeeping entries; they do
not claim to process or verify a transfer. No payment provider or card data is
collected or stored.
Issued invoice data is frozen for PDF generation. Schedule `npm run
billing:daily` once per day in UTC to capture storage and reconcile the prior
day; without a scheduler, operators must run those actions manually. Take a
control-plane PostgreSQL backup before applying migrations 5–7 and verify the
migrations in staging before production. These migrations are additive and run
through the same PostgreSQL control-plane initialization used by Docker
deployments; no data is deleted or reset.

The portal's API examples derive their base URL from the active browser
origin. For application servers, configure the deployed MAESTRO origin in the
application's environment (for example, via its own `MAESTRO_API_BASE_URL`
setting) and keep the project key in a server-side secret store:

```bash
curl -H "Authorization: Bearer $MAESTRO_API_KEY" \
     "$MAESTRO_API_BASE_URL/v1/collections"

curl -X POST "$MAESTRO_API_BASE_URL/v1/data" \
     -H "Authorization: Bearer $MAESTRO_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"collection":"items","data":{"name":"Example"}}'
```

## Quick start

```bash
docker compose up -d                       # existing stack, no new services
# optional: export MAESTRO_ADMIN_TOKEN=…   (required when NODE_ENV=production)

curl -X POST localhost:3000/v1/projects -H 'Content-Type: application/json' \
     -d '{"name":"Shopping App"}'
# → { "projectId": "proj_3fa9…", "apiKey": "pk_…" }   ← shown ONCE

curl -X POST localhost:3000/v1/data -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"collection":"products","data":{"name":"Laptop","price":75000,"category":"electronics"}}'

curl -X POST localhost:3000/v1/query -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"collection":"products","queryType":"select","filters":{"category":"electronics"},"limit":10}'
```

Or with the SDK (`sdk/`, Node 18+):

```js
const { Maestro } = require("./sdk");
const maestro = new Maestro({ apiKey: process.env.MAESTRO_API_KEY, baseUrl: "https://maestro.example.com" });
await maestro.collection("products").insert({ name: "Laptop", price: 75000, category: "electronics" });
const products = await maestro.collection("products").find({ category: "electronics" });
```

## API reference

### Client Portal (`/v1/client`)

The browser portal at `/client` uses same-origin `HttpOnly` session cookies.
Portal routes never accept the operator token. The database browse endpoint
also requires a project API key; it verifies that the signed-in client owns
the selected project, that the key belongs to that same project, and that
the key has `data:read`.

| Method & path | Purpose |
|---|---|
| `POST /v1/client/auth/register` `{displayName,email,password}` | create account; registration does not issue a session |
| `POST /v1/client/auth/login` `{email,password}` | verify password and issue the client session immediately |
| `POST /v1/client/auth/verify-otp` `{challengeId,otp}` | retained OTP challenge endpoint, not used by normal login |
| `POST /v1/client/auth/resend-otp` `{challengeId}` | retained OTP resend endpoint, not used by normal login |
| `POST /v1/client/auth/logout` | revoke the current session |
| `GET /v1/client/auth/me` | return the signed-in account |
| `GET /v1/client/projects` | list only projects owned by the account |
| `POST /v1/client/projects` `{name,scopes?}` | create an owned project and first key |
| `GET /v1/client/projects/:projectId` | owned project details, collections, and quotas |
| `GET /v1/client/projects/:projectId/usage` | owned project usage |
| `GET /v1/client/projects/:projectId/keys` | key metadata (never key secrets) |
| `POST /v1/client/projects/:projectId/keys` `{label,scopes?}` | issue an owned project key |
| `DELETE /v1/client/projects/:projectId/keys/:keyId` | revoke an owned project key |
| `GET /v1/client/projects/:projectId/browse/:collection?limit=50&offset=0` | read an owned collection page; requires the client session and matching project key with `data:read` |

Browse pages are server-side (maximum 50 records per request); `offset` is
bounded to 0-1,000,000. The portal's text search filters only the currently
loaded page, so use Previous/Next to inspect other pages. The UI explicitly
indicates that further records may exist.

Registration requires a 12-128 character password. Sessions last seven days;
the stored session credential is a hash and expired sessions are rejected.
Project and key creation accepts only supported scopes. An additional key
defaults to `data:read`; project creation defaults to read, write, collection
management, and usage scopes. Secret keys are returned only once.

All responses are JSON. Success: `{ "success": true, … }`.
Errors: `{ "success": false, "message": "…", "error": { "code": "…", "message": "…" } }`
with codes `invalid_request` (400), `unauthorized` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `payload_too_large` (413), `rate_limited` (429, with
`Retry-After`), `storage_error` (502), `service_unavailable` (503), `internal_error` (500).

### Control plane (`Authorization: Bearer <MAESTRO_ADMIN_TOKEN>`)
| Method & path | |
|---|---|
| `POST /v1/projects` `{name}` | create project + first API key (key returned once) |
| `GET /v1/projects` | list |
| `GET /v1/projects/:projectId` | details: keys (prefix only), collections + storage, usage |
| `DELETE /v1/projects/:projectId[?purge=true]` | revoke keys and retire the project; `purge=true` also drops its physical data |
| `POST /v1/projects/:projectId/keys` `{label}` | issue another key |
| `DELETE /v1/projects/:projectId/keys/:keyId` | revoke a key |
| `GET /v1/projects/:projectId/usage` | usage + per-collection size |

The control plane **fails closed** in production when `MAESTRO_ADMIN_TOKEN` is unset. In development, a random
process-scoped operator token is generated but never printed; set `MAESTRO_ADMIN_TOKEN` in `.env` before starting
the API to sign in reliably. Unauthenticated operator access exists only with the explicit development flag
`MAESTRO_INSECURE_DEV=true`, which production refuses. See [SECURITY.md](SECURITY.md).

Additional control-plane endpoints: `POST …/keys/:keyId/rotate {graceSeconds}`, `GET|PUT …/quotas`, `GET …/imports`,
`GET /v1/audit`. Keys accept `scopes` (`data:read`, `data:write`, `collections:manage`, `import`, `usage:read`) and
`expiresInDays`/`expiresAt`. `POST /v1/projects` honours an `Idempotency-Key` header (a replay returns the project without a key).

### Data plane (`Authorization: Bearer pk_…`)
| | |
|---|---|
| `POST /v1/collections` `{name, sampleData?, storageHint?}` | create + route a collection → `{collection, storage:{dbType,routingReason}}` |
| `GET /v1/collections`, `GET /v1/collections/:name`, `DELETE /v1/collections/:name` | list / details (+ document count) / drop |
| `POST /v1/data` `{collection, data}` | insert (auto-creates the collection when missing, unless `MAESTRO_AUTO_CREATE_COLLECTIONS=false`) |
| `GET /v1/data/:collection?filters=<json>&sort=&limit=&offset=` | list |
| `GET /v1/data/:collection/:id` | read one |
| `PUT /v1/data/:collection/:id` `{data}` | replace |
| `PATCH /v1/data/:collection/:id` `{data}` | merge top-level fields |
| `DELETE /v1/data/:collection/:id` | delete |
| `POST /v1/query` | `{collection, queryType: select\|search\|count, filters, text, fields, sort, limit, offset}` |
| `GET /v1/usage`, `GET /v1/project` | this project's usage / identity |

Usage responses include a `warnings` array when counters or collection metrics cannot be refreshed. Unavailable document counts and storage sizes are returned as `null`, not `0`; aggregate `usage.storageBytes` is `null` when any collection's storage size cannot be measured.

Documents are returned as `{ id, data, createdAt, updatedAt }` regardless of engine.

**Filters**: `{ "category": "electronics" }` (equality) or operator objects
`{ "price": { "gte": 10, "lt": 100 }, "tag": { "in": ["a","b"] } }` with
`eq ne gt gte lt lte in`; nested paths `"address.city"`. Also accepted:
`[{field, operator, value}]`. **Sort**: `"price"`, `"-price"`, `"price:desc"` or `{field, direction}`.
Limits: `limit` ≤ 1000 (default 50), 20 filters, 8 nesting levels, 256 KB/document.

`POST /v1/query` is shared with the original internal query engine: a request with
`Bearer pk_…` is project-scoped; a request without it goes to the original engine untouched.

## Multi-tenant isolation (enforced server-side)

1. The API key is hashed and looked up by its key-id; the resulting `projectId` is the
   **only** project identity used. `req.maestro = { projectId, apiKeyId }`.
2. A client that sends a `projectId` (body, query string, or `X-Project-Id`) that differs from
   its key's project gets **403**. Nothing client-supplied can pick a database, table, index or store;
   such fields are ignored.
3. Every operation resolves `projectId + collection → storage mapping`; a collection that
   isn't mapped to *your* project is a 404.
4. Physical separation: PostgreSQL database `maestro_<projectId>`; MongoDB database
   `maestro_<projectId>`; Elasticsearch index `<projectId>_<collection>`; adapters re-verify
   that the mapping's physical names match the project before every call.
5. Redis keys always start with the project id: `<projectId>:<collection>:<id>` and
   `<projectId>:query:<collection>:<hash>`. Key builders throw without a valid project id.
6. The unauthenticated legacy import/create routes cannot target project-owned names
   (`maestro_proj_*`, `maestro_control*`, `proj_<12hex>_*`).

## Intelligent routing

New collections reuse the existing pipeline unchanged (profiling → rule-based scoring →
optional local Ollama → 60/40 hybrid). The platform adds a safety layer: Ollama only
contributes scores (it never runs anything), the answer is validated against
`{postgresql, mongodb, elasticsearch}`, confidence below `MAESTRO_ROUTING_MIN_CONFIDENCE`
or any failure/timeout falls back to PostgreSQL, and the decision + reason are stored in the
mapping. `storageHint` lets the owner of a collection force an engine at creation time.
Examples: `{order_id, customer_id, …}` → PostgreSQL; nested/array student document →
MongoDB; long-text article → Elasticsearch.

Storage details: **PostgreSQL** collections get typed columns inferred from the sample
(numbers → `double precision`, booleans, text, objects/arrays → `jsonb`); fields not in the
sample go into a `_extra jsonb` column; type mismatches are rejected with a 400; `null` and
absent are equivalent. **MongoDB** stores `{_id, data, createdAt, updatedAt}`. **Elasticsearch**
uses dynamic mapping under `data.*`; `offset + limit` must be ≤ 10000.

## Usage tracking

Per project: requests, queries, inserts, updates, deletes, errors, last activity (counters are
flushed asynchronously after each response — best effort), and storage bytes (computed when
usage is requested). Billing usage events separately meter authenticated API requests and
measurable response bytes; see [Client authentication and billing](#client-authentication-and-billing).

## Security summary

API-key auth with hashed storage (optional `MAESTRO_KEY_PEPPER`); keys are 256-bit random;
constant-time comparison; revocation; per-key rate limit and per-IP failed-auth throttling;
strict validation of collection names, field names, ids, bodies, filters; parameterised SQL;
fixed-vocabulary MongoDB/Elasticsearch query construction (no client operators, scripts or
`query_string`); no raw SQL endpoints; generic 500s with no stack/credentials; all secrets
from environment variables.

## Testing

```bash
npm run test:unit    # everything that needs no services (incl. tests/dbaas, tests/sdk)
npm run test:dbaas   # DBaaS unit/API suites only
npm run test:live    # real PostgreSQL + Redis (+ MongoDB + Elasticsearch when reachable)
```
`test:live` soft-skips (and says so) for any service that isn't reachable. The MongoDB and
Elasticsearch adapters are additionally covered offline by fake drivers that interpret the
queries the adapters generate — useful for regressions, but **only the live suites prove
behaviour against the real engines**.

## Known limitations

* Isolation is logical (shared servers, per-project database/index/key prefix), not
  per-tenant database credentials.
* The original internal routes (`/database/*`, `/profile`, legacy `/v1/query`, federated query, …) now require the
  **operator token**. They are global (not tenant-scoped); never give the operator token to tenants.
* TLS is not terminated by the app — put it behind an HTTPS reverse proxy.
* Rate limiting is in-process (single instance).
* PostgreSQL schemas are fixed at collection creation (new fields go to `_extra`); there are no
  migrations or cross-collection joins in the public API.

## Bulk import — `POST /v1/import` (scopes `import` + `data:write`)
`multipart/form-data`: `file` (.csv/.tsv/.json/.ndjson ≤ `MAESTRO_MAX_IMPORT_BYTES`), `collection`, optional `dryRun=true`,
`idField`, `onDuplicate=skip|error|replace`, `storageHint`.
* **Dry run** validates, profiles (types, null rates, cardinality, sensitive-field warnings with values withheld) and shows which
  store the router would pick — writing nothing.
* Status codes: **200** dry run · **201** success · **207 partial** (some rows failed; the report lists row numbers — never reported as success) ·
  **422** nothing imported · **413** over the file/row quota.
* Retries: with `idField` + `onDuplicate=skip` re-uploading the same file is idempotent (verified after `kill -9` mid-import).
  Without `idField`, a re-upload inserts the rows again.
* CSV headers are normalised to snake_case (mapping returned); `"007"` stays a string; malformed rows and unterminated quotes are row errors.

## Quotas (per project, overridable via `PUT /v1/projects/:id/quotas`)
`maxCollections`, `maxDocuments`, `maxStorageBytes`, `maxImportRows`, `requestsPerMinute`. At a limit, **writes** get 403 `quota_exceeded`
(details name the quota), reads and deletes keep working. Document/storage counts are refreshed every ~10 s (soft limit).

## Caching
Redis keys: `<projectId>:<collection>:v<version>:(doc|q):…`. A write bumps the collection version atomically; readers read the version
before the database, so a pre-write result can never be served after the write. If Redis is down requests go straight to the database.

## Query semantics by backend (what is and is not the same)
| | PostgreSQL | MongoDB | Elasticsearch |
|---|---|---|---|
| `eq/ne/gt/gte/lt/lte/in` | SQL with bound parameters on typed columns (+ `_extra jsonb`) | typed filter documents on `data.*` | `term`/`range` DSL on `data.*` |
| string comparison / sort | collation of the database | binary | `.keyword` sub-field |
| field-scoped `search` (`fields: [...]`) | case-insensitive substring (`ILIKE`, wildcards escaped) | case-insensitive escaped regex | case-insensitive wildcard |
| unscoped `search` | substring across text columns | **`$text`: whole-word, stemmed** (needs wildcard text index; *unverified on real MongoDB*) | analysed full-text |
| read-after-write | immediate | immediate | **near-real-time** (refresh interval) — *unverified on a real cluster* |
| pagination | `LIMIT/OFFSET` | `skip/limit` | `from/size`, `offset+limit ≤ 10 000` |
| type safety | wrong type for an inferred column → 400 | schemaless | mapping-dependent |

Result shape is identical everywhere (`{results:[{id,data,createdAt,updatedAt}], resultCount}`); limits (default 50, max 1000), offsets (≤ 1 000 000), filter operators and
identifiers are validated before any backend is touched (`tests/dbaas/query-safety.test.js`, `tests/conformance`).
