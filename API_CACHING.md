# Query Result Caching (Redis)

`POST /v1/query` results are cached in Redis so a repeated, identical query
is served without hitting PostgreSQL/MongoDB/Elasticsearch again.
Implemented in `query-cache.js` and wired into `query-engine.js`'s
`executeQuery()`.

## What gets cached

Only **successful, read-only** query results — i.e. a `/v1/query` response
with `status: "success"`. This applies to all three query types
(`select`, `search`, `count`) since none of them write data. A `status:
"error"` result (a database call that failed) is **never** cached, so a
transient outage can't get "stuck" as a cached failure — the next request
just tries the database again.

Federated queries (`/v1/query/federated`) are **not** cached in this phase.

## Cache key

The key is built deterministically from exactly the request parameters
that determine the result:

- **Dataset** (case-insensitive)
- **Query type** (`select` / `search` / `count`)
- **Filters** (the validated `conditions`)
- **Sort**
- **Limit**
- The resolved/explicit **target database**, so an auto-routed query and
  one with an explicit `targetDatabase` never collide

Object keys and filter/field ordering are normalized before hashing, so
`{ "age": {...}, "status": "active" }` and `{ "status": "active", "age":
{...} }` produce the **same** cache key — reordering a request's JSON body
is never a cache miss on its own.

The key itself looks like `maestro:query:<dataset>:<sha256 of the
canonical request>` — the dataset name prefix is what makes bulk
invalidation (below) possible without scanning the entire keyspace.

## Response: cache vs. database

Every `/v1/query` response includes a `source` field:

```json
{ "...": "...", "source": "database" }
```

or

```json
{ "...": "...", "source": "cache" }
```

`source: "cache"` means the response was read straight from Redis and no
database was queried for that request at all.

## Configurable TTL

| Env var                  | Default | Meaning                                                              |
| ------------------------- | ------- | ---------------------------------------------------------------------- |
| `QUERY_CACHE_TTL_SECONDS` | `60`    | How long a cached result stays valid. Any non-positive/non-numeric value falls back to the default. |
| `QUERY_CACHE_ENABLED`     | `true`  | Set to the string `"false"` to disable caching entirely (every request always hits the database, `source` is always `"database"`). |
| `REDIS_URL`               | *(unset)* | Redis connection string (e.g. `redis://localhost:6379`). Caching is automatically a no-op if this isn't set — no connection is even attempted. |

Once a cached entry's TTL passes, Redis expires it on its own (`EX
<seconds>` is passed on every write); the next matching request is simply
a cache miss and re-runs against the database like any other miss.

## Invalidation on data changes

After a successful `/database/import` or `/partition/import` (any status
other than `"error"` — i.e. `imported`, `partial`, or `local`), every
cached `/v1/query` entry for that dataset is deleted immediately, so a
re-import is never masked by a stale cached result. This uses Redis's
non-blocking `SCAN` (never `KEYS`), matching the `maestro:query:<dataset>:*`
prefix, so invalidation doesn't stall other Redis clients even with a large
cache.

Invalidation is best-effort: if Redis is unreachable at that moment, the
import still completes successfully (see below) and the affected cache
entries simply expire on their own TTL instead of being cleared
immediately.

## Redis unavailable

Every function in `query-cache.js` degrades gracefully:

- If `REDIS_URL` isn't set, or `QUERY_CACHE_ENABLED=false`, no connection
  is ever attempted.
- If Redis is configured but unreachable (down, wrong URL, network issue),
  a connection error is caught, logged **once** (not spammed for the
  duration of the outage), and every cache read/write/invalidation call
  simply returns as if there were no cache (`null` / `false` / `0`).
- **Queries always work whether or not Redis is up.** A `/v1/query`
  request during a Redis outage just always has `source: "database"`.
- **Imports always succeed whether or not Redis is up.** A Redis outage
  during invalidation never fails or rolls back an otherwise-successful
  import.

## Security: nothing sensitive is ever cached

Only the `/v1/query` response body is cached — never connection
configuration, credentials, or environment variables. As a deliberate
backstop on top of that (not because today's response shape contains any),
every value written to Redis passes through a redaction step that replaces
any object key matching `password`, `secret`, `token`, `api[-_]?key`,
`credential`, `connection[-_]?string`, or `auth` (case-insensitive, at any
nesting depth) with `"[REDACTED]"` before it's serialized.

## Tests

`tests/query-cache.test.js` covers, against a mocked Redis client (no real
Redis instance required):

- Cache miss
- Cache hit
- Expired cache (Redis evicts the key; the next read behaves like a miss)
- Redis unavailable (connection failure, and a failure after connecting)
  for reads, writes, and invalidation
- Cache invalidation (matching keys deleted, dataset with nothing cached,
  a `del`/`scan` failure mid-invalidation)
- Cache key stability under reordered filters/fields
- Secret redaction before a value is written

`tests/query-engine.test.js` and `tests/write-rows-to-target.test.js` stub
`query-cache.js` out entirely (always a miss / always invalidated) so
those suites stay focused on query execution and import behavior rather
than caching.
