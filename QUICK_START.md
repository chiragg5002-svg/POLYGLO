# Quick Start

This walks through getting MAESTRO / POLYGLODB running locally, importing
the bundled sample datasets, querying them, and running the test suite.
Every service used here is local — nothing in this guide talks to a cloud
database or a cloud AI API.

## 1. Prerequisites

- Node.js 18+ (native `fetch` and `AbortController` are used by the test
  helpers)
- Docker + Docker Compose (for PostgreSQL, MongoDB, Elasticsearch, Redis)
- Optionally, [Ollama](https://ollama.com) installed natively for
  LLM-assisted routing recommendations — everything works without it; the
  routing engine falls back to deterministic rules automatically

## 2. Install and configure

```bash
cd maestro
npm install
cp .env.example .env   # if no .env exists yet — see below for the defaults
```

The defaults in `.env` already match the ports Docker Compose exposes, so
if you're using the bundled `docker-compose.yml` you usually don't need to
change anything. See `README.md`'s **Environment Variables** table for
what every variable does.

## 3. Start local services

```bash
docker compose up -d
docker compose ps          # wait until postgres/mongodb/elasticsearch/redis all report healthy
```

Elasticsearch is the slowest to become healthy (usually 20–40 seconds on
first start). If you want LLM-assisted routing, start Ollama separately
(it isn't in Docker Compose so it can use GPU acceleration natively):

```bash
ollama serve
ollama pull llama3.2:3b     # or whichever OLLAMA_MODEL you've configured
```

If Ollama isn't running, nothing breaks — `/routing/recommend` returns a
rule-based recommendation instead (see `API_ROUTING.md`), and the UI shows
an explicit "Ollama unavailable" notice when that happens.

## 4. Start the app

```bash
npm start
```

Open `http://localhost:3000` for the UI, or use the curl commands below
against the same server.

## 5. Sample datasets

Four ready-to-use datasets live in [`sample-data/`](./sample-data/), each
picked to exercise a different part of the pipeline:

| File | Shape | Good for demonstrating |
| --- | --- | --- |
| `sample-data/customers.csv` | Flat tabular rows (id, name, email, city, ...) | PostgreSQL routing/import/query |
| `sample-data/orders_with_items.json` | Documents with a nested `items` array, each referencing a `customer_id` | MongoDB import (nested arrays preserved) and federation (joins to `customers.csv` on `customer_id` / `id`) |
| `sample-data/product_catalog.json` | Documents with nested `specs` and `tags` | MongoDB import, routing pattern detection |
| `sample-data/application_logs.json` | Timestamped log entries with a free-text `message` field | Elasticsearch routing/import and full-text `search` queries |

## 6. Walk the pipeline with curl

### 6.1 Profile a dataset before importing anything

```bash
curl -s -X POST http://localhost:3000/profile \
  -F "datasetFile=@sample-data/customers.csv" | jq
```

Returns column types, null counts, cardinality, and a detected pattern —
see [`API_PROFILING.md`](./API_PROFILING.md).

### 6.2 Get a routing recommendation

```bash
curl -s -X POST http://localhost:3000/routing/recommend \
  -H "Content-Type: application/json" \
  -d "$(curl -s -X POST http://localhost:3000/profile -F 'datasetFile=@sample-data/application_logs.json' | jq '{rows: .sampleRows, originalName: "application_logs.json"}')" | jq
```

For `application_logs.json` this should return `"target": "elasticsearch"`
with `"source": "rules"` (timestamp + log-level fields are a strong,
deterministic signal — Ollama isn't even consulted). See
[`API_ROUTING.md`](./API_ROUTING.md) for the full rule list.

### 6.3 Preview a partition plan

```bash
curl -s -X POST http://localhost:3000/partition/preview \
  -F "datasetFile=@sample-data/product_catalog.json" | jq
```

### 6.4 Import into PostgreSQL

```bash
curl -s -X POST http://localhost:3000/database/import \
  -F "dbType=postgres" \
  -F "dbName=maestro_demo" \
  -F "collectionName=customers" \
  -F "datasetFile=@sample-data/customers.csv" | jq
```

Response includes `insertedCount`, `failedCount`, `dbType`,
`collectionName`, and `status` — see the **Features** section of
`README.md`.

### 6.5 Import into MongoDB (nested data)

```bash
curl -s -X POST http://localhost:3000/database/import \
  -F "dbType=mongodb" \
  -F "dbName=maestro_demo" \
  -F "collectionName=orders" \
  -F "datasetFile=@sample-data/orders_with_items.json" | jq
```

### 6.6 Import into Elasticsearch (searchable logs)

```bash
curl -s -X POST http://localhost:3000/database/import \
  -F "dbType=elasticsearch" \
  -F "dbName=maestro_logs" \
  -F "datasetFile=@sample-data/application_logs.json" | jq
```

### 6.7 Query what you just imported

```bash
# Filtered select against Postgres
curl -s -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{"dataset": "customers.csv", "queryType": "select", "conditions": {"city": "London"}}' | jq

# Full-text search against Elasticsearch
curl -s -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{"dataset": "application_logs.json", "queryType": "search", "conditions": {"text": "declined", "fields": ["message"]}}' | jq

# Run the exact same select again — the second response should have "source": "cache"
curl -s -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{"dataset": "customers.csv", "queryType": "select", "conditions": {"city": "London"}}' | jq '.source'
```

See [`API_QUERY.md`](./API_QUERY.md) and [`API_CACHING.md`](./API_CACHING.md).

### 6.8 Join across databases (federation prototype)

`orders_with_items.json`'s `customer_id` matches `customers.csv`'s `id` —
a ready-made join once both are imported (steps 6.4 and 6.5 above):

```bash
curl -s -X POST http://localhost:3000/v1/query/federated \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [
      {"dataset": "customers.csv", "alias": "customers", "targetDatabase": "postgres"},
      {"dataset": "orders_with_items.json", "alias": "orders", "targetDatabase": "mongodb"}
    ],
    "join": {
      "type": "inner",
      "left": {"alias": "customers", "field": "id"},
      "right": {"alias": "orders", "field": "customer_id"}
    },
    "projection": ["customers.name", "orders.items"]
  }' | jq
```

See [`API_FEDERATION.md`](./API_FEDERATION.md) — read its **Limitations**
section before relying on this for anything beyond a two-source join.

## 7. Running the tests

Three tiers, from "always works, no setup" to "needs everything running":

```bash
# Everything (unit + HTTP-integration-with-mocks + real-service tests,
# the latter auto-skipping if their service isn't reachable)
npm test

# Only the tests that need no external service at all (fastest, always
# deterministic — this is what CI should run by default)
npm run test:unit

# Only the real-service tests (tests/integration/) — each one performs a
# connectivity check first and cleanly skips with a console notice if its
# service isn't reachable, so this is safe to run even with some services
# stopped
npm run test:integration
```

To get a genuine (non-skipped) result from `npm run test:integration`,
make sure `docker compose up -d` has been run and containers report
healthy, and start Ollama if you want `tests/integration/ollama.test.js`
to exercise the real LLM path rather than soft-skip. See
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)'s "Test suite
results" section for exactly what ran and what soft-skipped the last time
this was reported.

## 8. Cleaning up

```bash
docker compose down -v   # stops the containers and deletes their data volumes
```

`data/metadata.json` on disk accumulates import records across runs
(including from the sample-data imports above and from
`npm run test:integration`) — delete it if you want a clean slate; it will
be recreated automatically on the next import.
