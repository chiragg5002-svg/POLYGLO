/*
 * Shared helpers for storage adapters.
 *
 * Every adapter implements the same interface (all methods async):
 *
 *   plan({ projectId, collection, sample })  -> { database_name, physical_name, schema }
 *   createStorage(mapping)
 *   create(mapping, { id, data })            -> doc
 *   findOne(mapping, id)                     -> doc | null
 *   find(mapping, spec)                      -> { results: doc[], resultCount }
 *   count(mapping, spec)                     -> number
 *   update(mapping, id, data)                -> doc | null      (full replace)
 *   delete(mapping, id)                      -> boolean
 *   query(mapping, spec)                     -> { results, resultCount }  (select | search | count)
 *   storageBytes(mapping)                    -> number
 *   dropStorage(mapping)
 *   dropProjectStorage(projectId, mappings)
 *   ping()
 *   close()
 *
 * A normalised doc is always { id, data, createdAt, updatedAt }.
 * `spec` is the already-validated object from validators.validateQueryRequest.
 * Routing/business logic lives in platform.js — adapters only translate.
 */
const { DbaasError } = require("../dbaas/errors");

const SAFE_PROJECT = /^proj_[0-9a-f]{12}$/;
const SAFE_COLLECTION = /^[a-z][a-z0-9_]{0,47}$/;

// Defence in depth: adapters re-check every identifier they embed in a
// statement, even though the API layer already validated them.
function assertSafeMapping(mapping) {
  if (!mapping || !SAFE_PROJECT.test(mapping.project_id) || !SAFE_COLLECTION.test(mapping.collection)) {
    throw new Error("Refusing to use an invalid storage mapping.");
  }
  return mapping;
}

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "53300", "57014"]);
const TRANSIENT_NAMES = new Set(["MongoNetworkError", "MongoServerSelectionError", "MongoNetworkTimeoutError", "ConnectionError", "TimeoutError", "NoLivingConnectionsError"]);

// Connection failures and timeouts are worth retrying / reporting as 503;
// everything else is a genuine backend error (502).
function isTransient(error) {
  if (!error) return false;
  if (TRANSIENT_CODES.has(error.code) || TRANSIENT_NAMES.has(error.name)) return true;
  if (error.errors && Array.isArray(error.errors)) return error.errors.some(isTransient); // AggregateError (dual-stack connect)
  return /timeout|timed out|terminated|connection (refused|reset|closed)|ECONN|server selection|no living connections/i.test(String(error.message || ""));
}

function internalStoreError(label, error) {
  // Keep the original for server logs, expose nothing about the backend.
  console.error(`[maestro] ${label} failed:`, error && error.message);
  const transient = isTransient(error);
  const e = transient
    ? new DbaasError(503, "storage_unavailable", "The storage backend is temporarily unavailable. Retry shortly.")
    : new DbaasError(502, "storage_error", "The storage backend failed to process the request.");
  if (transient) e.retryAfterSeconds = 2;
  e.cause = error;
  return e;
}

/*
 * Circuit breaker: after `threshold` consecutive transient failures calls
 * fail fast (503) for `cooldownMs`, then ONE trial call is let through
 * (half-open). Non-transient errors never trip it.
 */
class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 10000, name = "backend" } = {}) {
    this.threshold = threshold; this.cooldownMs = cooldownMs; this.name = name;
    this.failures = 0; this.openUntil = 0; this.trialInFlight = false;
  }
  get state() {
    if (this.openUntil && Date.now() < this.openUntil) return "open";
    return this.openUntil ? "half-open" : "closed";
  }
  async run(fn) {
    const state = this.state;
    if (state === "open" || (state === "half-open" && this.trialInFlight)) {
      const e = new DbaasError(503, "storage_unavailable", "The storage backend is temporarily unavailable. Retry shortly.");
      e.retryAfterSeconds = Math.max(1, Math.ceil((this.openUntil - Date.now()) / 1000));
      throw e;
    }
    if (state === "half-open") this.trialInFlight = true;
    try {
      const v = await fn();
      this.failures = 0; this.openUntil = 0; this.trialInFlight = false;
      return v;
    } catch (e) {
      this.trialInFlight = false;
      if (e && e.code === "storage_unavailable") {
        this.failures += 1;
        if (this.failures >= this.threshold) this.openUntil = Date.now() + this.cooldownMs;
      }
      throw e;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Wraps an adapter's methods with the breaker (all backend calls) and
 * bounded exponential-backoff retries (read-only, idempotent calls only —
 * writes are never retried automatically because they may have applied).
 */
const READ_METHODS = ["findOne", "find", "count", "query", "storageBytes"];
const BREAKER_METHODS = ["createStorage", "create", "update", "delete", ...READ_METHODS];

function protectAdapter(adapter, { retries = 2, threshold = 5, cooldownMs = 10000, baseDelayMs = 50, maxDelayMs = 1000 } = {}) {
  const breaker = new CircuitBreaker({ threshold, cooldownMs, name: adapter.dbType });
  adapter.breaker = breaker;
  for (const name of BREAKER_METHODS) {
    if (typeof adapter[name] !== "function") continue;
    const original = adapter[name].bind(adapter);
    const retryable = READ_METHODS.includes(name);
    adapter[name] = (...args) => breaker.run(async () => {
      let attempt = 0;
      for (;;) {
        try { return await original(...args); } catch (e) {
          if (!(retryable && e && e.code === "storage_unavailable" && attempt < retries)) throw e;
          attempt += 1;
          await sleep(Math.min(maxDelayMs, baseDelayMs * 3 ** (attempt - 1)));
        }
      }
    });
  }
  return adapter;
}

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { assertSafeMapping, internalStoreError, isTransient, CircuitBreaker, protectAdapter, escapeLike, escapeRegex, SAFE_PROJECT, SAFE_COLLECTION };
