/*
 * ============================================================
 * MAESTRO / POLYGLODB query result cache (Redis)
 * ============================================================
 *
 * Caches successful, read-only /v1/query results so a repeated
 * identical query is served from Redis instead of re-hitting
 * PostgreSQL/MongoDB/Elasticsearch. Every function in this module is
 * safe to call whether or not Redis is configured or reachable:
 *
 *   - If REDIS_URL isn't set, or QUERY_CACHE_ENABLED=false, caching
 *     is a no-op from the start — no connection is even attempted.
 *   - If Redis is configured but unreachable (down, wrong URL,
 *     network partition), every read/write here catches the error,
 *     logs it once (not on every call — that would spam the log for
 *     as long as Redis stays down), and returns as if there were no
 *     cache. The caller (query-engine.js) always falls through to
 *     the real database in that case — a query never fails or
 *     changes behavior because Redis is unavailable.
 *
 * See API_CACHING.md for the full behavior writeup and the
 * configuration variables.
 */

const crypto = require("crypto");
const { createClient } = require("redis");

const KEY_PREFIX = "maestro:query:";

// Anything shaped like a secret is stripped before a value is ever
// written to Redis, regardless of where it came from.
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|credential|connection[-_]?string|auth)/i;

const REDACTED = "[REDACTED]";

function isCachingEnabled() {
  return (
    process.env.QUERY_CACHE_ENABLED !== "false" &&
    Boolean(process.env.REDIS_URL)
  );
}

function getTtlSeconds() {
  const configured = Number(process.env.QUERY_CACHE_TTL_SECONDS);

  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 60;
}

// ------------------------------------------------------------
// Lazy, singleton Redis client with graceful degradation
// ------------------------------------------------------------

let client = null;
let connecting = null;
let warnedUnavailable = false;

function logUnavailableOnce(action, error) {
  // Logged once per outage, not once per call, so a down Redis
  // doesn't flood stdout for the duration of the outage.
  if (warnedUnavailable) return;

  warnedUnavailable = true;

  console.error(
    `Redis cache ${action} — falling back to direct database queries: ${error.message}`,
  );
}

async function getClient() {
  if (!isCachingEnabled()) return null;

  if (client) {
    // node-redis v4/v5 exposes isReady/isOpen on the client.
    // Treat anything else as "not usable" and reconnect below.
    if (client.isReady) return client;

    client = null;
  }

  if (!connecting) {
    connecting = (async () => {
      // Fail fast instead of queueing: when Redis is down every request must
      // fall back to the database immediately, not wait on reconnect backoff.
      // A dropped client is simply replaced on the next call (isReady check).
      const newClient = createClient({
        url: process.env.REDIS_URL,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
        disableOfflineQueue: true,
      });

      // node-redis emits "error" on connection hiccups.
      // An EventEmitter "error" with no listener can crash the process,
      // so this listener is mandatory.
      newClient.on("error", (error) => {
        logUnavailableOnce("connection error", error);
      });

      try {
        await newClient.connect();

        warnedUnavailable = false;
        client = newClient;

        return newClient;
      } catch (error) {
        logUnavailableOnce("is unreachable", error);

        client = null;

        return null;
      }
    })();
  }

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

// Exposed only for tests, so each test can start from a clean
// "never connected" state instead of sharing module-level singleton
// state across test cases.
// Graceful shutdown: close the shared connection.
async function closeClient() {
  const c = client;
  client = null;
  connecting = null;
  if (c) { try { await c.quit(); } catch (e) { try { c.destroy(); } catch (e2) { /* already closed */ } } }
}

function _resetForTests() {
  client = null;
  connecting = null;
  warnedUnavailable = false;
}

// ------------------------------------------------------------
// Redaction
// ------------------------------------------------------------

function sanitizeForCache(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeForCache);
  }

  if (value && typeof value === "object") {
    const out = {};

    Object.entries(value).forEach(([key, val]) => {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : sanitizeForCache(val);
    });

    return out;
  }

  return value;
}

// ------------------------------------------------------------
// Stable cache key
// ------------------------------------------------------------

// Deterministic stringification: object keys are sorted so two
// logically-identical requests with differently-ordered JSON bodies
// hash to the same key.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();

    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

// The validated `conditions` a select/count query carries is an
// array of { field, operator, value } clauses in the order the
// client's JSON object happened to have its keys — sort it so
// filter order never changes the cache key.
//
// A search query's conditions is { text, fields } — sort `fields`
// for the same reason (an OR-list's order never changes what it
// matches).
function normalizeConditionsForKey(conditions) {
  if (Array.isArray(conditions)) {
    return [...conditions].sort((a, b) =>
      `${a.field}|${a.operator}`.localeCompare(`${b.field}|${b.operator}`),
    );
  }

  if (
    conditions &&
    typeof conditions === "object" &&
    Array.isArray(conditions.fields)
  ) {
    return {
      ...conditions,
      fields: [...conditions.fields].sort(),
    };
  }

  return conditions;
}

// Builds the stable cache key described in requirement 2:
// dataset, query type, filters (conditions), sort, and limit.
// The resolved target database is folded in too.
function buildCacheKey({
  dataset,
  queryType,
  conditions,
  sort,
  limit,
  targetDatabase,
}) {
  const datasetKey = String(dataset || "")
    .trim()
    .toLowerCase();

  const canonical = {
    dataset: datasetKey,
    queryType,
    targetDatabase: targetDatabase || null,
    conditions: normalizeConditionsForKey(conditions),
    sort: sort || null,
    limit,
  };

  const hash = crypto
    .createHash("sha256")
    .update(stableStringify(canonical))
    .digest("hex");

  return `${KEY_PREFIX}${datasetKey}:${hash}`;
}

// ------------------------------------------------------------
// Cache read/write
// ------------------------------------------------------------

// Returns the cached value, or null on a miss OR if the cache is
// unavailable for any reason.
async function getCachedQueryResult(cacheKey) {
  const redisClient = await getClient();

  if (!redisClient) return null;

  try {
    const raw = await redisClient.get(cacheKey);

    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logUnavailableOnce("read failed", error);

    return null;
  }
}

// Caches `value` for `ttlSeconds`.
async function setCachedQueryResult(
  cacheKey,
  value,
  ttlSeconds = getTtlSeconds(),
) {
  const redisClient = await getClient();

  if (!redisClient) return false;

  try {
    const sanitized = sanitizeForCache(value);

    await redisClient.set(cacheKey, JSON.stringify(sanitized), {
      EX: ttlSeconds,
    });

    return true;
  } catch (error) {
    logUnavailableOnce("write failed", error);

    return false;
  }
}

// ------------------------------------------------------------
// Invalidation
// ------------------------------------------------------------

// Deletes every cached query result for one dataset.
//
// Uses SCAN via node-redis's async scanIterator rather than the
// blocking KEYS command.
//
// node-redis returns scanIterator results as batches/arrays in the
// installed version. Redis DEL is therefore called once per
// individual key so the existing Jest mocks and test contract
// remain satisfied.
async function invalidateDataset(datasetName) {
  if (!datasetName) return 0;

  const redisClient = await getClient();

  if (!redisClient) return 0;

  const prefix = `${KEY_PREFIX}${String(datasetName).trim().toLowerCase()}:`;

  let removed = 0;

  try {
    for await (const scanned of redisClient.scanIterator({
      MATCH: `${prefix}*`,
      COUNT: 100,
    })) {
      const keys = Array.isArray(scanned) ? scanned : [scanned];

      for (const key of keys) {
        if (typeof key === "string" && key.length > 0) {
          await redisClient.del(key);
          removed += 1;
        }
      }
    }
  } catch (error) {
    // A failed invalidation must never fail the import it's cleaning
    // up after. Worst case, a cached entry stays around until its
    // TTL naturally expires.
    logUnavailableOnce("invalidation failed", error);
  }

  return removed;
}

// Exposed for the project-scoped DBaaS cache (dbaas/cache.js), which
// shares this module's single, gracefully-degrading Redis connection.
module.exports = {
  getClient,
  isCachingEnabled,
  getTtlSeconds,
  buildCacheKey,
  getCachedQueryResult,
  setCachedQueryResult,
  invalidateDataset,
  sanitizeForCache,
  closeClient,
  _resetForTests,
};
