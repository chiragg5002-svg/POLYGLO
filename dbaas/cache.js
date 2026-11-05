/*
 * Project-scoped Redis cache for the DBaaS data plane.
 *
 * ISOLATION: every key is built by the helpers below, which throw unless
 * a valid projectId is supplied; the projectId is always the first
 * segment:
 *     <projectId>:ver:<collection>                       collection version
 *     <projectId>:<collection>:v<ver>:doc:<id>           single documents
 *     <projectId>:<collection>:v<ver>:q:<hash>           query results
 * so project A can never read, write or invalidate project B's entries.
 *
 * INVALIDATION BY VERSION: instead of scanning and deleting keys after a
 * write, a write atomically INCRs the collection's version. Readers read
 * the version BEFORE touching the database and embed it in the key, so a
 * result computed from pre-write data can only ever be stored under an
 * old version that no later read looks at. That removes the classic
 * read/invalidate race and needs no SCAN.
 *
 * If Redis is unavailable the cache is a no-op. If a version bump itself
 * fails (Redis faulted mid-write) the collection is put in a local
 * "bypass" window for one TTL so stale entries cannot be served.
 *
 * Redis DEL fix: DEL is only ever called with a non-empty array.
 */
const crypto = require("crypto");
const queryCache = require("../query-cache");
const { PROJECT_ID, COLLECTION_NAME } = require("./validators");
const { metrics } = require("./metrics");

const VERSION_TTL_SECONDS = 86400;

const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
};

function assertScope(projectId, collection) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new Error("Cache key requires a valid projectId.");
  if (collection !== undefined && !COLLECTION_NAME.test(collection)) throw new Error("Cache key requires a valid collection.");
}

const versionKey = (projectId, collection) => { assertScope(projectId, collection); return `${projectId}:ver:${collection}`; };
const keyForDoc = (projectId, collection, id, ver = "0") => { assertScope(projectId, collection); return `${projectId}:${collection}:v${ver}:doc:${id}`; };
const keyForQuery = (projectId, collection, spec, ver = "0") => {
  assertScope(projectId, collection);
  const canonical = stable({ queryType: spec.queryType, filters: spec.filters, text: spec.text, fields: spec.fields, sort: spec.sort, limit: spec.limit, offset: spec.offset });
  return `${projectId}:${collection}:v${ver}:q:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
};

class ProjectCache {
  constructor({ getClient = queryCache.getClient, isEnabled = queryCache.isCachingEnabled, ttlSeconds } = {}) {
    this._getClient = getClient;
    this._isEnabled = isEnabled;
    this._ttl = ttlSeconds;
    this._bypass = new Map();
    this.stats = { hits: 0, misses: 0, errors: 0, bypassed: 0 };
  }

  _ttlSeconds() { return this._ttl || queryCache.getTtlSeconds(); }

  async _client() {
    if (!this._isEnabled()) return null;
    try { return await this._getClient(); } catch (e) { this.stats.errors += 1; return null; }
  }

  _bypassed(projectId, collection) {
    const k = `${projectId}:${collection}`;
    const until = this._bypass.get(k);
    if (!until) return false;
    if (Date.now() < until) return true;
    this._bypass.delete(k);
    return false;
  }

  // Current version of a collection ("" means: do not use the cache).
  async version(projectId, collection) {
    if (this._bypassed(projectId, collection)) { this.stats.bypassed += 1; return ""; }
    const c = await this._client();
    if (!c) return "";
    try {
      const k = versionKey(projectId, collection);
      let v = await c.get(k);
      if (v === null || v === undefined) {
        // Start at a time-based epoch so a version key that expired can never
        // collide with entries written under an earlier value.
        await c.set(k, String(Date.now()), { NX: true, EX: VERSION_TTL_SECONDS });
        v = await c.get(k);
      }
      return v === null || v === undefined ? "" : String(v);
    } catch (e) { this.stats.errors += 1; return ""; }
  }

  async _get(key) {
    const c = await this._client();
    if (!c) return null;
    try {
      const raw = await c.get(key);
      if (raw) { this.stats.hits += 1; metrics.inc("maestro_cache_hits_total"); return JSON.parse(raw); }
      this.stats.misses += 1; metrics.inc("maestro_cache_misses_total");
      return null;
    } catch (e) { this.stats.errors += 1; return null; }
  }

  async _set(key, value) {
    const c = await this._client();
    if (!c) return false;
    try { await c.set(key, JSON.stringify(value), { EX: this._ttlSeconds() }); return true; } catch (e) { this.stats.errors += 1; return false; }
  }

  /* Returns { value, ver }: pass `ver` back to set so the write targets the same version. */
  async getDoc(projectId, collection, id) {
    const ver = await this.version(projectId, collection);
    if (!ver) return { value: null, ver: "" };
    return { value: await this._get(keyForDoc(projectId, collection, id, ver)), ver };
  }
  async setDoc(projectId, collection, id, ver, doc) { return ver ? this._set(keyForDoc(projectId, collection, id, ver), doc) : false; }

  async getQuery(projectId, collection, spec) {
    const ver = await this.version(projectId, collection);
    if (!ver) return { value: null, ver: "" };
    return { value: await this._get(keyForQuery(projectId, collection, spec, ver)), ver };
  }
  async setQuery(projectId, collection, spec, ver, payload) { return ver ? this._set(keyForQuery(projectId, collection, spec, ver), payload) : false; }

  // Low-level helpers kept for callers/tests that use explicit keys.
  async get(key) { return this._get(key); }
  async set(key, value) { return this._set(key, value); }
  async del(keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === "string" && k.length > 0);
    if (!list.length) return 0; // never send an argument-less DEL
    const c = await this._client();
    if (!c) return 0;
    try { return Number(await c.del(list)) || 0; } catch (e) { this.stats.errors += 1; return 0; }
  }

  async _deleteByPattern(pattern) {
    const c = await this._client();
    if (!c) return 0;
    let removed = 0;
    try {
      for await (const batch of c.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        const keys = (Array.isArray(batch) ? batch : [batch]).filter((k) => typeof k === "string" && k.length > 0);
        if (keys.length) removed += Number(await c.del(keys)) || 0;
      }
    } catch (e) { /* TTL will expire anything left */ }
    return removed;
  }

  // After ANY write/import/delete: bump the collection version (atomic).
  async invalidateCollection(projectId, collection) {
    assertScope(projectId, collection);
    const c = await this._client();
    if (!c) return 0;
    try {
      const k = versionKey(projectId, collection);
      const exists = await c.get(k);
      if (exists === null || exists === undefined) {
        await c.set(k, String(Date.now()), { NX: true, EX: VERSION_TTL_SECONDS });
      }
      await c.incr(k);
      await c.expire(k, VERSION_TTL_SECONDS);
      return 1;
    } catch (e) {
      this.stats.errors += 1;
      this._bypass.set(`${projectId}:${collection}`, Date.now() + (this._ttlSeconds() + 5) * 1000);
      return 0;
    }
  }

  async invalidateProject(projectId) {
    assertScope(projectId);
    return this._deleteByPattern(`${projectId}:*`);
  }
}

module.exports = { ProjectCache, keyForDoc, keyForQuery, versionKey };
