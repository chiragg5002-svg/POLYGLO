# Unified Query API

`POST /v1/query` — query a previously-imported dataset without needing to
know which database it landed in. Given a dataset name, this endpoint looks
up where that dataset was imported (using the metadata recorded by
`/database/import` and `/partition/import` — i.e. the destination the
routing engine already chose), and runs a safe `select` / `search` / `count`
query against exactly that one database. Implemented in `query-engine.js`.

Cross-database joins are **not** implemented yet. If a dataset was
partitioned across more than one database (via `/partition/import`) and you
don't say which one to query, the endpoint returns a `400` explaining that
and asking you to pass `targetDatabase`.

## Request

```
POST /v1/query
Content-Type: application/json
```

```json
{
  "dataset": "orders.csv",
  "queryType": "select",
  "conditions": { "status": "active", "age": { "gte": 21 } },
  "sort": { "field": "age", "direction": "desc" },
  "limit": 25,
  "targetDatabase": "postgres"
}
```

| Field            | Required | Description                                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `dataset`        | yes      | The dataset name as it was imported (matches `dataset`/`originalName` in `/metadata`).           |
| `queryType`      | yes      | One of `select`, `search`, `count`.                                                               |
| `conditions`     | no       | See below — shape depends on `queryType`. Defaults to `{}` (no filter) for `select`/`count`.       |
| `sort`           | no       | `{ "field": "...", "direction": "asc" \| "desc" }`. Ignored for `count`.                          |
| `limit`          | no       | Positive integer, max `500`. Default `50`. Ignored for `count`.                                   |
| `targetDatabase` | no       | One of `postgres`, `mongodb`, `elasticsearch`. Required only when the dataset spans more than one. |

### `conditions` for `select` / `count`

A map of field → value (implicit equality) or field → `{ operator: value }`.
Allowed operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` (value must be
an array).

```json
{ "status": "active", "age": { "gte": 21, "lte": 65 }, "region": { "in": ["us", "eu"] } }
```

### `conditions` for `search`

```json
{ "text": "wireless headphones", "fields": ["title", "description"] }
```

`fields` is optional — if omitted, the engine searches whatever columns
were profiled as text when the dataset was imported. If none are known,
you'll get a `400` asking you to specify `fields`.

## Response

The shape is the same regardless of which database served the query:

```json
{
  "success": true,
  "selectedDatabase": "postgres",
  "queryPlan": {
    "dataset": "orders.csv",
    "dbType": "postgres",
    "dbName": "shop",
    "resolvedName": "orders",
    "queryType": "select",
    "conditions": [{ "field": "status", "operator": "eq", "value": "active" }],
    "sort": { "field": "age", "direction": "desc" },
    "limit": 25,
    "executedQuery": { "sql": "SELECT * FROM \"orders\" WHERE \"status\" = $1 ORDER BY \"age\" DESC LIMIT $2", "values": ["active", 25] }
  },
  "status": "success",
  "results": [{ "id": 1, "status": "active", "age": 34 }],
  "resultCount": 1,
  "error": null,
  "source": "database"
}
```

- **`status: "success"`** — the query ran; `results`/`resultCount` are populated.
- **`status: "error"`** — the dataset/target were resolved fine, but the
  database call itself failed (connection refused, table dropped, etc.);
  `error.message` has the details and `results` is `[]`. This still comes
  back as HTTP `200` — the request itself was valid.
- **`source`** — `"database"` if this query actually ran against
  PostgreSQL/MongoDB/Elasticsearch, or `"cache"` if it was served from
  Redis without touching any database at all. See
  [`API_CACHING.md`](./API_CACHING.md) for the full caching behavior and
  configuration variables — in short: successful results are cached for a
  configurable TTL, keyed off dataset + query type + filters + sort +
  limit, and the cache is invalidated automatically whenever that dataset
  is re-imported.
- A **`400`** response (`{ "success": false, "message": "..." }`) means the
  request was invalid before any database (or the cache) was touched: bad
  `queryType`, an unknown operator, a dataset that doesn't exist, an
  unknown column, or an ambiguous multi-database dataset with no
  `targetDatabase`.

`executedQuery` shows exactly what ran: the parameterized SQL + bound values
for Postgres, the filter object for MongoDB, or the Query DSL body for
Elasticsearch — useful for debugging without re-deriving the query yourself.
Note this is only present when `source` is `"database"` — a cache hit
returns the same `executedQuery` that was recorded when the result was
first computed.

## Examples

### PostgreSQL — filter, sort, limit

```bash
curl -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{
    "dataset": "orders.csv",
    "queryType": "select",
    "conditions": { "status": "active", "age": { "gte": 21 } },
    "sort": { "field": "age", "direction": "desc" },
    "limit": 10,
    "targetDatabase": "postgres"
  }'
```

### MongoDB — search across text fields

```bash
curl -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{
    "dataset": "articles.json",
    "queryType": "search",
    "conditions": { "text": "unified query engine", "fields": ["title", "body"] },
    "targetDatabase": "mongodb"
  }'
```

### Elasticsearch — count matching documents

```bash
curl -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{
    "dataset": "logs.json",
    "queryType": "count",
    "conditions": { "level": { "in": ["error", "fatal"] } },
    "targetDatabase": "elasticsearch"
  }'
```

### Letting the engine pick the database automatically

Omit `targetDatabase` when the dataset was only ever imported into one
database — it's resolved from `/metadata` automatically:

```bash
curl -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{ "dataset": "orders.csv", "queryType": "count" }'
```

### Error case — ambiguous dataset (no joins yet)

```bash
curl -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{ "dataset": "mixed_dataset.json", "queryType": "select" }'
```

```json
{
  "success": false,
  "message": "Query error: Dataset \"mixed_dataset.json\" is split across multiple databases (postgres, mongodb). Cross-database joins are not supported yet — pass \"targetDatabase\" to query one of them directly."
}
```

### Error case — invalid operator

```bash
curl -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{ "dataset": "orders.csv", "queryType": "select", "conditions": { "age": { "between": 30 } } }'
```

```json
{
  "success": false,
  "message": "Query error: Invalid operator \"between\" for field \"age\". Expected one of: eq, ne, gt, gte, lt, lte, in."
}
```
