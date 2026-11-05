# MAESTRO UI and Data Import

This folder provides a simple Express-based UI for creating databases and importing CSV/JSON data files into PostgreSQL, MongoDB, Elasticsearch, or a local JSON placeholder.

**New: MAESTRO as a DBaaS** — projects, API keys, `/v1/data`, intelligent routing, JS SDK: see [`DBaaS.md`](./DBaaS.md).

**Documentation index:** this file (features + frontend) ·
[`QUICK_START.md`](./QUICK_START.md) (step-by-step walkthrough with curl) ·
[`DOCKER_DEPLOYMENT.md`](./DOCKER_DEPLOYMENT.md) (running the API itself in
Docker alongside the databases, health checks, production-safe config) ·
[`ARCHITECTURE.md`](./ARCHITECTURE.md) (module map + data flow) ·
[`ENVIRONMENT.md`](./ENVIRONMENT.md) (every env var) ·
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) (implemented /
experimental / future work + exact test results) ·
[`API_PROFILING.md`](./API_PROFILING.md) ·
[`API_ROUTING.md`](./API_ROUTING.md) ·
[`API_QUERY.md`](./API_QUERY.md) ·
[`API_CACHING.md`](./API_CACHING.md) ·
[`API_FEDERATION.md`](./API_FEDERATION.md).


> **Security note (1.0):** every internal/legacy route and the control plane now require the operator token (`MAESTRO_ADMIN_TOKEN`);
> API keys carry scopes. In development `npm start` prints an ephemeral operator token (paste it into the dashboard's *Developer Platform* panel).
> Read [SECURITY.md](SECURITY.md) before exposing the service.

**Documentation:** [DBaaS.md](DBaaS.md) · [openapi.yaml](openapi.yaml) · [SECURITY.md](SECURITY.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [BACKUP_RESTORE.md](BACKUP_RESTORE.md) ·
[ARCHITECTURE.md](ARCHITECTURE.md) · [TEST_REPORT.md](TEST_REPORT.md) · [BENCHMARK_REPORT.md](BENCHMARK_REPORT.md) · [IMPLEMENTATION_AUDIT.md](IMPLEMENTATION_AUDIT.md) ·
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [CHANGELOG.md](CHANGELOG.md)

**Quick commands:** `npm ci` · `npm test` · `npm run test:live` (real services) · `npm run bench:routing` · `npm run bench:load` · `npm run test:resilience` ·
`npm run test:backup` · `npm run scan:secrets` · demo: `MAESTRO_ADMIN_TOKEN=… ./scripts/demo.sh`

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the local database services with Docker Compose:
```bash
docker compose up -d
```

3. Create a `.env` file (or copy `.env.example`) to configure connections —
   see [`ENVIRONMENT.md`](./ENVIRONMENT.md) for what every variable does
   and its default:
```bash
cp .env.example .env
```
```text
PORT=3000
NODE_ENV=development
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=postgres
PG_DATABASE=postgres
MONGO_URI=mongodb://localhost:27017
ELASTICSEARCH_URL=http://localhost:9200
REDIS_URL=redis://localhost:6379
QUERY_CACHE_ENABLED=true
QUERY_CACHE_TTL_SECONDS=60
OLLAMA_HOST=127.0.0.1
OLLAMA_PORT=11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_TIMEOUT_MS=30000
FEDERATION_MAX_SOURCE_ROWS=2000
FEDERATION_DEFAULT_RESULT_ROWS=200
FEDERATION_MAX_RESULT_ROWS=1000
FEDERATION_TIMEOUT_MS=10000
```

4. Start the server:
```bash
npm start
```

5. Open the UI in your browser:
`http://localhost:3000`

For a full walkthrough with sample datasets and curl commands for every
endpoint, see [`QUICK_START.md`](./QUICK_START.md).

### Docker services
- PostgreSQL: `localhost:5432`
- MongoDB: `localhost:27017`
- Elasticsearch: `localhost:9200`
- Redis: `localhost:6379`

Ollama (optional, for LLM-assisted routing) is not in Docker Compose — see
[`QUICK_START.md`](./QUICK_START.md) for running it natively. Nothing in
this project requires it or any other cloud service to run; see
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md).

The steps above run the databases in Docker and the API natively (`npm
start`) — the setup this README and `QUICK_START.md` assume throughout.
`docker-compose.yml` also includes an `api` service, so the whole stack
(API included) can run in Docker instead — `docker compose up -d --build`
with no `npm install`/`npm start` needed at all. See
[`DOCKER_DEPLOYMENT.md`](./DOCKER_DEPLOYMENT.md) for that workflow, health
checks, environment configuration, and a production-safe `docker-compose`
example; nothing about the native workflow above changes if you don't use
it.

## Sample data

[`sample-data/`](./sample-data/) has four ready-to-use datasets picked to
exercise different parts of the pipeline (flat tabular, nested documents,
log-style text) — see the table in [`QUICK_START.md`](./QUICK_START.md#5-sample-datasets)
for which is which and full curl examples for profiling, routing,
importing, querying, and federating them.

## Testing

```bash
npm test               # everything: unit + mocked-HTTP-integration + real-service (auto-skip)
npm run test:unit      # only tests needing no external service — fast, always deterministic
npm run test:integration  # only tests/integration/ — real local services, soft-skips what's not running
```

Three tiers: pure unit tests (profiling, routing, partitioning, metadata,
query validation, cache-key generation, all mocked), HTTP-level tests via
`supertest` with drivers mocked at the boundary (the full upload → query →
cache workflow, plus negative/error cases), and real-service tests that
talk to actual local Docker Postgres/Mongo/Elasticsearch/Redis and local
Ollama when they're running, cleanly skipping with a console notice when
they're not. See [`ARCHITECTURE.md`](./ARCHITECTURE.md#testing-shape) for
how these are structured and
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#test-suite-results)
for the exact, most recently reported pass/fail/skip counts — including an
explicit note about which of those numbers reflect real-service runs
versus soft-skips, so the count is never misread as more coverage than it
is.

## Features

- Create a new PostgreSQL database, MongoDB database, or Elasticsearch index.
- Upload a CSV or JSON file and import it into your target database.
- Store a local JSON file if you do not have a database service available.
- Profile a CSV/TSV/JSON dataset (types, nulls, cardinality, nested JSON
  structure, and a detected data pattern) at `/profile` — see
  [`API_PROFILING.md`](./API_PROFILING.md) for the full response schema.
- Get a hybrid (rules-first, Ollama-second) database recommendation at
  `/routing/recommend` — see [`API_ROUTING.md`](./API_ROUTING.md) for the
  full response schema and the deterministic rules.
- Query an already-imported dataset without knowing which database it
  landed in at `/v1/query` (select/search/count, routed automatically from
  metadata, results cached in Redis) — see [`API_QUERY.md`](./API_QUERY.md)
  for the full schema and curl examples, and
  [`API_CACHING.md`](./API_CACHING.md) for the caching behavior and
  configuration variables.
- Join two datasets that live in different databases at
  `/v1/query/federated` — a safe **experimental** prototype (two sources,
  inner/left join only) built on top of `/v1/query` — see
  [`API_FEDERATION.md`](./API_FEDERATION.md) for the full schema, curl
  examples, and its documented limitations, and
  [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for how this
  fits alongside what's fully implemented vs. future work.
- View import/create metadata at `/metadata`.

## Frontend

The UI (`views/index.html` + `public/app.js`) walks the same pipeline the
API exposes:

1. **Profile** — dropping/choosing a file immediately profiles it and shows
   column types, nulls, and detected pattern, before anything is imported.
2. **Routing recommendation** — recommended database, confidence, reason,
   and source (`rules` / `ollama` / `fallback`); an explicit warning banner
   appears if Ollama was unreachable and the rule-based fallback was used
   instead.
3. **Partition preview** — shown automatically when a dataset needs to be
   split across databases.
4. **Import progress + final status** — a two-phase progress indicator
   (in progress / done) followed by a structured summary: records imported,
   failed records, selected database, and the resulting table/collection/
   index name.
5. **Query interface** (`#query-card`) — a form for `/v1/query` (dataset,
   query type, JSON filters, sort, limit, optional target database) with
   client-side validation, a loading state, a results table, a `source:
   database | cache` badge, and a collapsible query-plan viewer.
6. **Clear errors** — every error surface (profile, routing, partition,
   import, query) is run through a small classifier that labels it as one
   of *Invalid file*, *Database unavailable*, *Ollama unavailable*,
   *Import failed*, *Invalid query*, or a generic *Error*, so the same kind
   of failure always reads the same way regardless of which endpoint
   produced it.

**No credentials in the UI:** every server-provided error/status message
passes through a redaction step (`redactSensitive()`, duplicated safely on
both client and server) that strips anything shaped like `user:pass@host`
or a `password=`/`secret=`/`token=`-style assignment before it's ever
rendered — this is on top of the server never including raw connection
strings in a response in the first place. The same `redactSensitive()`
logic lives in `redact.js` and is applied at the source in
`database-service.js`, `query-engine.js`, and `federation-engine.js`
wherever a raw driver error message becomes part of a response, and again
in `server.js`'s `sendError()` as an independent second layer.

`tests/workflow.integration.test.js` exercises the complete workflow —
upload → profile → partition preview → import → query → cache hit →
re-import invalidates the cache — over real HTTP via `supertest`, plus the
required error scenarios (invalid file, database unavailable, import
failure, invalid query, Ollama unavailable) and two assertions that no
response ever contains embedded credentials.
