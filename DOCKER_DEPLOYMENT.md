# Docker Deployment

This covers running the full MAESTRO / POLYGLODB stack — the API **and**
PostgreSQL, MongoDB, Elasticsearch, and Redis — entirely in Docker, for
local development or as a starting point for a real deployment.

This is in addition to, not a replacement for, the native workflow in
[`QUICK_START.md`](./QUICK_START.md) and the **Setup** section of
[`README.md`](./README.md) (`npm install` + `docker compose up -d` for just
the databases + `npm start`). Both work with the same `docker-compose.yml`;
which one you use is your choice per session — see
["Native API + Dockerized databases"](#native-api--dockerized-databases)
below.

## Files involved

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build for the API image (deps stage → slim runtime stage, non-root user, no dev dependencies). |
| `.dockerignore` | Keeps `.env`, `node_modules`, tests, and docs out of the build context/image. |
| `docker/wait-for-services.js` | Container entrypoint — blocks until Postgres/MongoDB/Elasticsearch/(Redis, if enabled) are actually reachable, then starts `server.js` as a child process. |
| `docker-compose.yml` | Local/dev stack: API + all four databases, sensible defaults, nothing hardcoded that can't be overridden. |
| `docker-compose.prod.yml` | Overlay (not standalone) that turns on real database auth, stops publishing DB ports to the host, and adds memory limits. |
| `.env.docker.example` | Template for the secrets `docker-compose.prod.yml` (and optionally the base file) read. Separate from `.env`, which is only for the native (`npm start`) workflow. |

## Quick start (API + all databases in Docker)

```bash
docker compose up -d --build
docker compose ps                    # wait until every service reports healthy
curl http://localhost:3000/health    # {"status":"ok"}
```

`elasticsearch` is the slowest to become healthy (usually 20–40s on first
start); the `api` container won't even start until every database it
depends on reports healthy, and its own entrypoint (`docker/wait-for-
services.js`) double-checks connectivity from inside the container before
handing off to `server.js` — see [Startup ordering](#startup-ordering).

Everything else in [`QUICK_START.md`](./QUICK_START.md) — profiling,
routing, importing, querying, federation — works exactly the same against
`http://localhost:3000`, whether the API is running in Docker or natively.

### Native API + Dockerized databases

If you'd rather run the API natively (for `nodemon`, debugging, etc.) and
only want the databases in Docker, start everything **except** `api`:

```bash
docker compose up -d postgres mongodb elasticsearch redis
npm start
```

Running both at once binds `:3000` twice and the second one will fail to
start — pick one or the other per session.

## Environment variables

The base `docker-compose.yml` sets sane local-dev defaults for every
variable — you don't need a `.env.docker` file for plain `docker compose up
-d`. Every value can still be overridden, either by exporting a shell
variable or by passing `--env-file`:

```bash
docker compose --env-file .env.docker up -d --build
```

See [`.env.docker.example`](./.env.docker.example) for the full list (DB
credentials, ports, query cache settings, federation limits, optional
`GEMINI_API_KEY`/Ollama settings). This is a **separate file from `.env`**
— `.env` is only read by `dotenv` inside the app for the native `npm
start` workflow (where hosts are `localhost`); `.env.docker` is only read
by the Docker CLI for compose variable substitution (where hosts are the
Compose service names `postgres`/`mongodb`/`elasticsearch`/`redis`). They
are never merged, so editing one never breaks the other. See
[`ENVIRONMENT.md`](./ENVIRONMENT.md) for what each variable actually
controls inside the app.

No password, connection string, or API key is written into `Dockerfile`,
`docker-compose.yml`, or any file that gets copied into the image —
everything reaches the container via `environment:`/`--env-file` at
container-start time.

## Health checks and startup ordering

Every service in `docker-compose.yml` has a `healthcheck:` (`docker
compose ps` shows the status of each). The `api` service additionally
declares `depends_on: <service>: condition: service_healthy` for all four
databases, so Compose won't even create the `api` container until each one
has reported healthy at least once.

That's necessary but not sufficient on its own — it only applies when a
container is first *created*, not on every restart — so
`docker/wait-for-services.js` (the API image's `ENTRYPOINT`) re-checks
connectivity itself before starting `server.js`, using the same client
libraries and env vars the app uses:

- PostgreSQL: connects and runs `SELECT 1`.
- MongoDB: connects and runs an admin `ping`.
- Elasticsearch: `GET /_cluster/health`.
- Redis: connects and `PING`s — skipped entirely if
  `QUERY_CACHE_ENABLED=false` or `REDIS_URL` is unset, mirroring
  `query-cache.js`'s own `isCachingEnabled()` check, since Redis is
  optional for the app to run at all.

Each check retries every `WAIT_INTERVAL_MS` (default 2000ms) until
`WAIT_TIMEOUT_MS` (default 60000ms) elapses, at which point the container
exits non-zero — Docker's `restart: unless-stopped` policy then retries
the whole sequence. Set `SKIP_SERVICE_WAIT=true` to bypass all of this
(e.g. for `docker compose run api sh`).

## Persistent volumes

Named volumes back every database, plus the app's own uploads and import
metadata, so `docker compose restart` / `docker compose down` (without
`-v`) never lose data:

| Volume | Mounted at | Holds |
| --- | --- | --- |
| `postgres_data` | `postgres:/var/lib/postgresql/data` | PostgreSQL data files |
| `mongo_data` | `mongodb:/data/db` | MongoDB data files |
| `elasticsearch_data` | `elasticsearch:/usr/share/elasticsearch/data` | Elasticsearch indices |
| `redis_data` | `redis:/data` | Redis's own persistence (if enabled) |
| `uploads_data` | `api:/app/uploads` | Temp files from in-flight imports |
| `metadata_data` | `api:/app/data` | `metadata.json` — the import history `GET /database/metadata` reads |

`docker compose down -v` deletes all of the above — use plain `docker
compose down` to stop containers while keeping the data.

## Production-safe configuration example

`docker-compose.prod.yml` is an **overlay**, not a standalone file — it
only makes sense merged on top of `docker-compose.yml`:

```bash
cp .env.docker.example .env.docker
# edit .env.docker: put a real, unique, random value in every
# *_PASSWORD / *_USERNAME field

docker compose --env-file .env.docker \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Relative to the base file, this:

- Turns on real authentication on MongoDB (root user), Elasticsearch (the
  built-in `elastic` user), and Redis (`requirepass`) — the base file
  intentionally runs all three open, matching what the original local-only
  `docker-compose.yml` did before the API was added.
- Stops publishing any database port to the host (`ports: []`) — only the
  `api` container can reach them, over the internal Compose network. Use
  `docker compose exec postgres psql -U ...` (etc.) for one-off access
  instead of opening a port back up.
- Sets `NODE_ENV=production`, which makes `server.js`'s `sendError()`
  suppress raw error detail in HTTP responses.
- Adds per-service memory limits and switches every `restart:` policy to
  `always`.

Review both files together before using this in a real environment —
`docker-compose.prod.yml` is a starting point (the kind of hardening a
reviewer would expect to see), not a complete production checklist. TLS
termination, network-level access control, log shipping, and backup
strategy for the volumes above are all still your responsibility and are
deliberately out of scope for a docker-compose example.

## Testing the deployed stack

```bash
# 1. Bring the stack up
docker compose up -d --build
docker compose ps                       # all five services "healthy"

# 2. API health endpoint
curl -s http://localhost:3000/health    # {"status":"ok"}

# 3. File import (PostgreSQL) — sample-data/ ships inside the image too
curl -s -X POST http://localhost:3000/database/import \
  -F "dbType=postgres" \
  -F "dbName=maestro_demo" \
  -F "collectionName=customers" \
  -F "datasetFile=@sample-data/customers.csv" | jq

# 4. Query execution against what you just imported
curl -s -X POST http://localhost:3000/v1/query \
  -H "Content-Type: application/json" \
  -d '{"dataset": "customers.csv", "queryType": "select", "conditions": {"city": "London"}}' | jq
```

See [`QUICK_START.md`](./QUICK_START.md) for the full walkthrough
(profiling, routing recommendations, MongoDB/Elasticsearch imports, the
query cache, and cross-database federation) — every command there works
unchanged against the Dockerized API.

Once the containers are up, the existing test suite can also run against
them from the host exactly as before:

```bash
npm run test:integration
```

## Updating the image after a code change

```bash
docker compose up -d --build api
```

Compose only rebuilds and recreates `api`; the databases (and their data)
are untouched.
