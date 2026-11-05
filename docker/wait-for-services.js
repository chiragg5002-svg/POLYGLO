#!/usr/bin/env node
/*
 * ============================================================
 * MAESTRO / POLYGLODB — container entrypoint
 * ============================================================
 *
 * docker-compose's `depends_on: condition: service_healthy` already
 * delays the *creation* of the api container until each database
 * container's own healthcheck passes once. That's necessary but not
 * sufficient:
 *
 *   - A container can report healthy for its own process (e.g.
 *     Elasticsearch's HTTP port is up) a moment before it's actually
 *     ready to serve the specific database/user this app connects
 *     as, especially on first-ever startup with a cold volume.
 *   - `docker compose restart api` (or the container restarting on
 *     its own after a crash) does not re-run the other services'
 *     healthchecks or re-block on `depends_on` at all — Compose only
 *     enforces that ordering when a container is *created*.
 *
 * So this script re-checks connectivity from inside the api
 * container itself, using the exact same client libraries and env
 * vars the app uses (database-service.js / query-engine.js /
 * query-cache.js), before handing off to the real server. If a
 * dependency never becomes reachable within WAIT_TIMEOUT_MS, the
 * container exits non-zero instead of starting the API in a broken
 * state — Docker's restart policy then retries the whole sequence.
 *
 * Set SKIP_SERVICE_WAIT=true to bypass this entirely (e.g. for a
 * `docker compose run` shell, or local image debugging).
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS || 60000);
const INTERVAL_MS = Number(process.env.WAIT_INTERVAL_MS || 2000);
const APP_ROOT = path.join(__dirname, '..');

function log(msg) {
  console.log(`[wait-for-services] ${msg}`);
}

async function waitFor(name, checkFn) {
  const start = Date.now();
  let lastErr;
  for (;;) {
    try {
      await checkFn();
      log(`${name} is ready.`);
      return;
    } catch (err) {
      lastErr = err;
      if (Date.now() - start >= TIMEOUT_MS) {
        throw new Error(
          `timed out after ${TIMEOUT_MS}ms waiting for ${name}: ${lastErr.message}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  }
}

async function checkPostgres() {
  const { Client } = require('pg');
  const client = new Client({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DATABASE || 'postgres',
    connectionTimeoutMillis: 3000,
  });
  await client.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

async function checkMongo() {
  const { MongoClient } = require('mongodb');
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db().admin().ping();
  } finally {
    await client.close();
  }
}

async function checkElasticsearch() {
  const url = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
  const res = await fetch(`${url}/_cluster/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`Elasticsearch health endpoint returned HTTP ${res.status}`);
  }
}

async function checkRedis() {
  const { createClient } = require('redis');
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    // reconnectStrategy: false is required here — with its default
    // (retry-forever-with-backoff) strategy, client.connect() never
    // rejects on a refused/unreachable connection, it just retries
    // internally forever, which would make this whole check hang
    // instead of timing out and being retried by waitFor() above.
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  });
  // redis v4 clients emit on connection errors even when we also
  // catch the rejected promise below; swallow here so a transient
  // refusal during polling doesn't print an unhandled 'error' trace.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
  } finally {
    await client.quit().catch(() => {});
  }
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  let shuttingDown = false;
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill(signal);
    });
  });

  child.on('exit', (code, signal) => {
    process.exit(code !== null ? code : signal ? 1 : 0);
  });
}

async function main() {
  if (process.env.SKIP_SERVICE_WAIT === 'true') {
    log('SKIP_SERVICE_WAIT=true — skipping dependency checks.');
    startServer();
    return;
  }

  log('Waiting for dependent services to become available...');
  await waitFor('PostgreSQL', checkPostgres);
  await waitFor('MongoDB', checkMongo);
  await waitFor('Elasticsearch', checkElasticsearch);

  // Mirrors query-cache.js's own isCachingEnabled() check: Redis is
  // optional, so only block startup on it when the app would
  // actually try to use it.
  const cachingEnabled =
    process.env.QUERY_CACHE_ENABLED !== 'false' && Boolean(process.env.REDIS_URL);
  if (cachingEnabled) {
    await waitFor('Redis', checkRedis);
  } else {
    log('Redis caching disabled (QUERY_CACHE_ENABLED=false or REDIS_URL unset) — skipping.');
  }

  log('All dependent services are ready. Starting API...');
  startServer();
}

main().catch((err) => {
  console.error(`[wait-for-services] Startup aborted: ${err.message}`);
  process.exit(1);
});
