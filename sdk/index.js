/*
 * MAESTRO JavaScript SDK — a thin wrapper over the public REST API.
 * No dependencies; uses the global fetch (Node 18+ / browsers).
 *
 *   const { Maestro } = require("./sdk");   // or: require("maestro-sdk")
 *   const maestro = new Maestro({ apiKey: process.env.MAESTRO_API_KEY });
 *   await maestro.collection("products").insert({ name: "Laptop", price: 75000 });
 *   const products = await maestro.collection("products").find({ category: "electronics" });
 *
 * Keep the API key on your server — never ship it to a browser.
 */

class MaestroError extends Error {
  constructor(message, { status, code, details, retryAfter } = {}) {
    super(message);
    this.name = "MaestroError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

class AuthenticationError extends MaestroError {}   // 401
class PermissionError extends MaestroError {}       // 403 (incl. insufficient_scope)
class QuotaExceededError extends PermissionError {} // 403 quota_exceeded
class NotFoundError extends MaestroError {}         // 404
class ConflictError extends MaestroError {}         // 409
class ValidationError extends MaestroError {}       // 400 / 413 / 415 / 422
class RateLimitError extends MaestroError {}        // 429
class ServerError extends MaestroError {}           // 5xx (incl. 503 storage_unavailable)
class TimeoutError extends MaestroError {}
class NetworkError extends MaestroError {}

function errorFor(status, code) {
  if (code === "quota_exceeded") return QuotaExceededError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  if (status >= 400) return ValidationError;
  return MaestroError;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Methods that are safe to repeat after an ambiguous failure.
const IDEMPOTENT = new Set(["GET", "PUT", "DELETE"]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

class Maestro {
  /**
   * @param {object}  options
   * @param {string}  [options.apiKey]    defaults to process.env.MAESTRO_API_KEY
   * @param {string}  [options.baseUrl]   defaults to process.env.MAESTRO_URL or http://localhost:3000
   * @param {number}  [options.timeoutMs] per-request timeout (default 30000)
   * @param {Function} [options.fetch]    custom fetch implementation
   * @param {number}  [options.maxRetries] retries for transient failures (default 2; 0 disables)
   */
  constructor(options = {}) {
    const env = typeof process !== "undefined" && process.env ? process.env : {};
    const apiKey = options.apiKey || env.MAESTRO_API_KEY;
    if (!apiKey || typeof apiKey !== "string") {
      throw new MaestroError("A MAESTRO API key is required (options.apiKey or MAESTRO_API_KEY).", { code: "missing_api_key" });
    }
    // Non-enumerable: console.log(client), JSON.stringify(client) and error
    // reports never contain the secret.
    Object.defineProperty(this, "apiKey", { value: apiKey, enumerable: false, writable: false });
    this.maxRetries = options.maxRetries === undefined ? 2 : Math.max(0, Math.min(5, options.maxRetries));
    this.baseUrl = String(options.baseUrl || env.MAESTRO_URL || "http://localhost:3000").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs || 30000;
    this._fetch = options.fetch || (typeof fetch === "function" ? fetch : null);
    if (!this._fetch) throw new MaestroError("No fetch implementation available; use Node 18+ or pass options.fetch.", { code: "no_fetch" });
    try {
      const u = new URL(this.baseUrl);
      if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) {
        // eslint-disable-next-line no-console
        console.warn("[maestro-sdk] baseUrl is not HTTPS — your API key would be sent in clear text. Use HTTPS outside local development.");
      }
    } catch (e) {
      throw new MaestroError(`Invalid baseUrl: ${this.baseUrl}`, { code: "invalid_base_url" });
    }
  }

  async _request(method, path, { body, query, retryable } = {}) {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const safeToRepeat = retryable !== undefined ? retryable : IDEMPOTENT.has(method);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this._once(method, url, body);
      } catch (e) {
        // 429 is rejected before processing, so it is safe to retry any method;
        // network errors / 502-504 only for requests that are safe to repeat.
        const canRetry = attempt < this.maxRetries && e instanceof MaestroError &&
          (e instanceof RateLimitError || (safeToRepeat && (e instanceof NetworkError || e instanceof TimeoutError || [502, 503, 504].includes(e.status))));
        if (!canRetry) throw e;
        const base = e.retryAfter !== undefined ? Math.min(e.retryAfter, 10) * 1000 : Math.min(2000, 100 * 3 ** attempt);
        await sleep(base + Math.floor(Math.random() * 50));
      }
    }
  }

  async _once(method, url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (!isForm) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await this._fetch(url, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      const timedOut = e.name === "AbortError";
      throw new (timedOut ? TimeoutError : NetworkError)(timedOut ? `Request timed out after ${this.timeoutMs}ms.` : `Network error: ${String(e.message).replace(/Bearer\s+\S+|pk_\S+/g, "[redacted]")}`, {
        code: timedOut ? "timeout" : "network_error" });
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* non-JSON body */ }
    // 207 (partial import) and 422 (failed import) carry a full report: return it for 207, throw for 422.
    if (res.status === 207) return payload;
    if (!res.ok || (payload && payload.success === false)) {
      const err = (payload && payload.error) || {};
      const retry = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      const Cls = errorFor(res.status, err.code);
      throw new Cls(err.message || (payload && payload.message) || `Request failed with status ${res.status}.`, {
        status: res.status, code: err.code || "http_error", details: err.details || (res.status === 422 ? payload : undefined), retryAfter: retry ? Number(retry) : undefined });
    }
    return payload;
  }

  /**
   * Bulk import a CSV/TSV/JSON/NDJSON file. `file` is a string, Buffer, Uint8Array or Blob.
   * Resolves to the import report; a partially failing import (HTTP 207) resolves with
   * report.status === "partial" — always check report.summary.failed / report.errors.
   * Use { idField, onDuplicate: "skip" } to make retries idempotent.
   */
  importFile(collection, file, { filename, dryRun, idField, onDuplicate, storageHint } = {}) {
    if (typeof FormData === "undefined" || typeof Blob === "undefined") throw new MaestroError("importFile needs Node 18+ (FormData/Blob).", { code: "no_formdata" });
    const form = new FormData();
    form.append("collection", collection);
    if (dryRun) form.append("dryRun", "true");
    if (idField) form.append("idField", idField);
    if (onDuplicate) form.append("onDuplicate", onDuplicate);
    if (storageHint) form.append("storageHint", storageHint);
    form.append("file", file instanceof Blob ? file : new Blob([file]), filename || "import.csv");
    return this._request("POST", "/v1/import", { body: form, retryable: false });
  }
  imports() { return this._request("GET", "/v1/imports"); }

  // Never leak the key through util.inspect / console.log.
  [Symbol.for("nodejs.util.inspect.custom")]() { return `Maestro { baseUrl: '${this.baseUrl}', apiKey: '[redacted]' }`; }
  toJSON() { return { baseUrl: this.baseUrl }; }

  /** Returns a handle for one logical collection. */
  collection(name) {
    if (typeof name !== "string" || !name) throw new MaestroError("collection name is required.", { code: "invalid_request" });
    return new Collection(this, name);
  }

  /** Creates a collection explicitly; MAESTRO analyses `sampleData` to choose the storage engine. */
  createCollection(name, { sampleData, storageHint } = {}) {
    return this._request("POST", "/v1/collections", { body: { name, sampleData, storageHint } });
  }
  async listCollections() { return (await this._request("GET", "/v1/collections")).collections; }
  getCollection(name) { return this._request("GET", `/v1/collections/${encodeURIComponent(name)}`); }
  dropCollection(name) { return this._request("DELETE", `/v1/collections/${encodeURIComponent(name)}`); }
  usage() { return this._request("GET", "/v1/usage"); }
  project() { return this._request("GET", "/v1/project"); }
  /** Raw project-scoped query: { collection, queryType, filters, text, fields, sort, limit, offset } */
  query(body) { return this._request("POST", "/v1/query", { body, retryable: true }); } // read-only, safe to retry
}

class Collection {
  constructor(client, name) {
    this.client = client;
    this.name = name;
    this._path = `/v1/data/${encodeURIComponent(name)}`;
  }

  /** Inserts a document (creating the collection on first use). Resolves to { id, data, createdAt, updatedAt }. */
  async insert(data) {
    const r = await this.client._request("POST", "/v1/data", { body: { collection: this.name, data } });
    return pick(r);
  }

  /** Finds documents. `filters` is { field: value } or { field: { gte: 1, lt: 5 } }. Resolves to an array. */
  async find(filters = {}, { sort, limit, offset } = {}) {
    const r = await this.client.query({ collection: this.name, queryType: "select", filters, sort, limit, offset });
    return r.results;
  }

  /** First match or null. */
  async findOne(filters = {}, options = {}) {
    const rows = await this.find(filters, { ...options, limit: 1 });
    return rows[0] || null;
  }

  /** Fetch by id, or null when it doesn't exist. */
  async get(id) {
    try {
      return pick(await this.client._request("GET", `${this._path}/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof MaestroError && e.status === 404) return null;
      throw e;
    }
  }

  /** Full-text style search. */
  async search(text, { fields, filters, sort, limit, offset } = {}) {
    const r = await this.client.query({ collection: this.name, queryType: "search", text, fields, filters, sort, limit, offset });
    return r.results;
  }

  async count(filters = {}) {
    return (await this.client.query({ collection: this.name, queryType: "count", filters })).resultCount;
  }

  /** Replaces the document's data. */
  async update(id, data) {
    return pick(await this.client._request("PUT", `${this._path}/${encodeURIComponent(id)}`, { body: { data } }));
  }

  /** Merges top-level fields into the document. */
  async patch(id, data) {
    return pick(await this.client._request("PATCH", `${this._path}/${encodeURIComponent(id)}`, { body: { data } }));
  }

  /** Deletes by id; resolves true, or false if it didn't exist. */
  async delete(id) {
    try {
      await this.client._request("DELETE", `${this._path}/${encodeURIComponent(id)}`);
      return true;
    } catch (e) {
      if (e instanceof MaestroError && e.status === 404) return false;
      throw e;
    }
  }

  /** Details including which storage engine MAESTRO selected. */
  info() { return this.client.getCollection(this.name); }
}

function pick(r) {
  return { id: r.id, data: r.data, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

module.exports = { Maestro, MaestroError, Collection, AuthenticationError, PermissionError, QuotaExceededError, NotFoundError, ConflictError, ValidationError, RateLimitError, ServerError, TimeoutError, NetworkError };
module.exports.default = Maestro;
