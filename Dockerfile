# ============================================================
# MAESTRO / POLYGLODB — API image
# ============================================================
# Multi-stage build: dependencies are installed once in a throwaway
# stage so devDependencies (jest, nodemon, supertest) and npm's cache
# never end up in the final image. Nothing here bakes in credentials
# — every connection string/password/API key is supplied at
# container-start time via environment variables (see
# docker-compose.yml / .env.docker.example), never COPY'd in.

# ---- deps: install production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: the actual API image ----
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Run as an unprivileged user rather than root.
RUN addgroup -S maestro && adduser -S maestro -G maestro

COPY --from=deps --chown=maestro:maestro /app/node_modules ./node_modules
COPY --chown=maestro:maestro . .

# uploads/ and data/ are also declared as volumes in
# docker-compose.yml so their contents persist across container
# recreation; creating them here just ensures they exist (with the
# right owner) even if the image is run without those volumes
# mounted, e.g. `docker run` for a one-off check.
RUN mkdir -p uploads data && chown maestro:maestro uploads data

USER maestro

EXPOSE 3000

# Liveness/readiness probe used both by `docker compose ps` and by
# other services' `depends_on: condition: service_healthy`. Hits the
# same /health route documented in README.md / QUICK_START.md.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider "http://localhost:${PORT}/health" || exit 1
# Orchestrators should route traffic on /ready (dependency-aware); /health is liveness only.

# docker/wait-for-services.js blocks until Postgres/MongoDB/
# Elasticsearch/Redis are actually reachable (not just "container
# started"), then execs the real server as a child process. See
# that file for why this is needed in addition to depends_on.
ENTRYPOINT ["node", "docker/wait-for-services.js"]
