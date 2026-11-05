# Cross-Database Query Federation API (Prototype)

`POST /v1/query/federated` — join two datasets that live in different
databases (any combination of PostgreSQL, MongoDB, Elasticsearch) by
fetching each independently and joining them in the application layer.
Implemented in `federation-engine.js`, built on top of the single-database
query engine (`query-engine.js` — see [`API_QUERY.md`](./API_QUERY.md)).

> **This is a safe prototype, not production-grade federation.** It exists
> to prove out safe two-stage execution (fetch independently, join in
> memory) for reliable single-join cases. See **Limitations** below before
> relying on it for anything beyond that.

## Prerequisite

Both datasets must already be queryable individually via `POST /v1/query`
— i.e. already imported (via `/database/import` or `/partition/import`)
and resolvable in `/metadata`.

## Request

```json
{
  "sources": [
    { "dataset": "orders.csv", "alias": "orders", "targetDatabase": "postgres", "conditions": { "status": "active" } },
    { "dataset": "customers.json", "alias": "customers", "targetDatabase": "mongodb" }
  ],
  "join": {
    "type": "inner",
    "left": { "alias": "orders", "field": "customer_id" },
    "right": { "alias": "customers", "field": "id" }
  },
  "projection": ["orders.id", "orders.total", "customers.name"],
  "limit": 100,
  "timeoutMs": 10000
}
```

| Field        | Required | Description                                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `sources`    | yes      | Exactly **two** entries (see Limitations). Each: `dataset`, `alias` (unique), optional `targetDatabase`, `conditions`, `limit`. |
| `join`       | yes      | `{ type, left: { alias, field }, right: { alias, field } }`. Fields are **never inferred** — both must be given explicitly. |
| `projection` | no       | Array of `"alias.field"` strings. Omit to get full nested rows (`{ orders: {...}, customers: {...} }`). |
| `limit`      | no       | Final joined-result row cap. Default `200`, hard ceiling `1000` (configurable, see below).        |
| `timeoutMs`  | no       | Overall wall-clock budget for stage 1 (fetching both sources). Default `10000`, clamped to `1000`–`60000`. |

Each source's `conditions` use the same shape as `/v1/query`: a field →
value map, or field → `{ operator: value }` with `eq/ne/gt/gte/lt/lte/in`.

### Preventing uncontrolled full-database scans

Every source fetch is **always** capped, regardless of what (if anything)
the client requests:

- `sources[i].limit`, if given, is still clamped to `FEDERATION_MAX_SOURCE_ROWS`.
- If no `limit` is given, a default (`500`, or less if the max is lower) is
  used — there is no "unlimited" option.
- These are configurable via environment variables, each with its own
  absolute ceiling that env vars cannot exceed:

| Env var                          | Default | Absolute ceiling |
| --------------------------------- | ------- | ----------------- |
| `FEDERATION_MAX_SOURCE_ROWS`       | 2000    | 10000              |
| `FEDERATION_DEFAULT_RESULT_ROWS`   | 200     | 5000               |
| `FEDERATION_MAX_RESULT_ROWS`       | 1000    | 5000               |
| `FEDERATION_TIMEOUT_MS`            | 10000   | 60000              |

## Response

```json
{
  "success": true,
  "queryPlan": {
    "sources": [
      { "alias": "orders", "dataset": "orders.csv", "dbType": "postgres", "dbName": "shop", "resolvedName": "orders", "conditions": [...], "limit": 500 },
      { "alias": "customers", "dataset": "customers.json", "dbType": "mongodb", "dbName": "shop", "resolvedName": "customers", "conditions": [], "limit": 500 }
    ],
    "join": { "type": "inner", "left": { "alias": "orders", "field": "customer_id" }, "right": { "alias": "customers", "field": "id" } },
    "projection": ["orders.id", "orders.total", "customers.name"],
    "limit": 100,
    "timeoutMs": 10000
  },
  "databasesUsed": ["postgres", "mongodb"],
  "rowsRead": { "orders": 3, "customers": 2 },
  "joinField": { "left": "orders.customer_id", "right": "customers.id" },
  "results": [
    { "orders.id": 1, "orders.total": 49.99, "customers.name": "Ada Lovelace" }
  ],
  "resultCount": 1,
  "status": "success",
  "errors": []
}
```

- **`status: "success"`** — both sources were fetched and the join ran.
- **`status: "error"`** — either source failed (connection error, missing
  table/collection, etc.) or the overall `timeoutMs` was exceeded. No join
  is attempted if either side is missing; `errors` names which source
  failed and why, `results` is `[]`.
- A **`400`** response means the request itself was rejected before any
  database was touched: wrong number of sources, unsupported join type,
  unsupported source `queryType`, a missing/unknown join field, an
  unresolvable dataset, or an ambiguous alias.

## Examples

### Inner join — Postgres orders + Mongo customers

```bash
curl -X POST http://localhost:3000/v1/query/federated \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [
      { "dataset": "orders.csv", "alias": "orders", "targetDatabase": "postgres", "conditions": { "status": "active" } },
      { "dataset": "customers.json", "alias": "customers", "targetDatabase": "mongodb" }
    ],
    "join": {
      "type": "inner",
      "left": { "alias": "orders", "field": "customer_id" },
      "right": { "alias": "customers", "field": "id" }
    },
    "projection": ["orders.id", "orders.total", "customers.name"],
    "limit": 50
  }'
```

### Left join — keep orders with no matching customer

```bash
curl -X POST http://localhost:3000/v1/query/federated \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [
      { "dataset": "orders.csv", "alias": "orders", "targetDatabase": "postgres" },
      { "dataset": "customers.json", "alias": "customers", "targetDatabase": "mongodb" }
    ],
    "join": {
      "type": "left",
      "left": { "alias": "orders", "field": "customer_id" },
      "right": { "alias": "customers", "field": "id" }
    }
  }'
```

A row with no match comes back as `{ "orders": {...}, "customers": null }`.

### Error case — unsupported join type

```bash
curl -X POST http://localhost:3000/v1/query/federated \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [{ "dataset": "orders.csv", "alias": "orders" }, { "dataset": "customers.json", "alias": "customers" }],
    "join": { "type": "right", "left": { "alias": "orders", "field": "customer_id" }, "right": { "alias": "customers", "field": "id" } }
  }'
```

```json
{
  "success": false,
  "message": "Federated query error: Unsupported join type \"right\". Supported: inner, left (right/full/cross joins are not implemented in this prototype)."
}
```

### Error case — join field not given explicitly

```bash
curl -X POST http://localhost:3000/v1/query/federated \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [{ "dataset": "orders.csv", "alias": "orders" }, { "dataset": "customers.json", "alias": "customers" }],
    "join": { "type": "inner", "left": { "alias": "orders" }, "right": { "alias": "customers", "field": "id" } }
  }'
```

```json
{
  "success": false,
  "message": "Federated query error: \"join.left.field\" is required — join fields must be given explicitly, they are never inferred."
}
```

## Limitations

This is a first, safe pass at federation — not a query planner. Concretely:

1. **Exactly two sources, one join.** N-way joins across three or more
   datasets are not implemented. `sources` must have exactly two entries.
2. **Only `inner` and `left` joins.** No `right`, `full`, or `cross` joins.
3. **The join is a plain in-memory hash join over whatever rows were
   fetched in stage 1** — it is not a database-level join and has no
   query planner. If a matching row exists on the "many" side but fell
   outside that source's row cap (see above), it will silently not appear
   in the result. This matters most for a large "many" side with a small
   `limit`/default cap — narrow it with `conditions` if you need
   completeness.
4. **No fields are ever inferred.** `join.left.field` / `join.right.field`
   are required in every request. Metadata is only used to (a) resolve a
   dataset name to its actual database/table/collection, the same as
   `/v1/query` does, and (b) confirm — when a schema is on record — that
   the given field actually exists on that dataset. It never guesses which
   fields are "related".
5. **Filtering only happens per-source, before the join.** There is no
   post-join filter/`HAVING`-equivalent step yet.
6. **MongoDB identifier remap edge case.** If a Mongo dataset's identifier
   column was detected and remapped to `_id` at import time (see
   `database-service.js`), that field is no longer present under its
   original name on returned documents. The join falls back to reading
   `_id` when the named join field is absent — a best-effort shim, not a
   guarantee that the semantics exactly match the original column.
7. **No query planner / no cost-based source ordering.** Both sources are
   always fetched fully (up to their cap) in parallel; there's no attempt
   to push the join key from one source into the other's filter to reduce
   what's fetched.
8. **No streaming.** Both result sets are held in memory for the join, so
   the row caps above are also a memory-safety measure, not just an
   API nicety.

If your use case needs more than this (three+ sources, right/full joins,
post-join filtering, or completeness guarantees on large "many" sides),
this endpoint is not the right tool yet — it's intended for exploring
small-to-moderate, well-understood joins across two known datasets.
