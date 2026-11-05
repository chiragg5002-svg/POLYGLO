/*
 * Control plane: projects, API keys, collections, storage mappings.
 * Knows nothing about physical databases beyond the mapping rows it
 * stores; the data plane (platform.js) does the actual storage work.
 */
const crypto = require("crypto");
const { generateApiKey, parseApiKey, verifyApiKey, extractBearer, hashApiKey } = require("../api-keys");
const { unauthorized, notFound, forbidden, badRequest } = require("../errors");
const { validateProjectName, validateProjectId, validateKeyId } = require("../validators");
const { validateScopes } = require("../scopes");
const { getConfig } = require("../config");

const TOUCH_INTERVAL_MS = 60 * 1000;
const DUMMY_HASH = hashApiKey("pk_000000000000_dummy");

class ControlPlane {
  constructor(store) {
    this.store = store;
    this._touched = new Map();
    this._authCache = new Map();
    this._usageBuf = new Map();
    this._usageTimer = null;
  }

  init() { return this.store.init(); }
  async close() {
    await this.flushUsage().catch(() => {});
    return this.store.close();
  }

  /*
   * Creates a project and its first API key atomically. `idempotencyKey`
   * (from the Idempotency-Key header) makes retries safe: a replay returns
   * the existing project WITHOUT a key (the secret is only ever shown once).
   */
  async createProject(rawName, { idempotencyKey, scopes, expiresInDays, ownerClientId = null } = {}) {
    const name = validateProjectName(rawName);
    const projectId = `proj_${crypto.randomBytes(6).toString("hex")}`;
    const g = generateApiKey();
    const key = {
      keyId: g.keyId, hash: g.hash, prefix: g.prefix, label: "default",
      scopes: validateScopes(scopes), expiresAt: this._expiry({ expiresInDays }),
    };
    let idempotencyHash = null;
    if (idempotencyKey !== undefined && idempotencyKey !== null && idempotencyKey !== "") {
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw badRequest("Idempotency-Key must be 8-128 characters.");
      idempotencyHash = crypto.createHash("sha256").update(ownerClientId ? `${ownerClientId}\0${idempotencyKey}` : idempotencyKey).digest("hex");
    }
    const res = await this.store.createProjectWithKey({ projectId, name, idempotencyHash, key, ownerClientId });
    if (res.replayed) {
      if (ownerClientId && res.project.owner_client_id !== ownerClientId) throw forbidden("Project ownership does not match.");
      return { project: this.publicProject(res.project), apiKey: null, replayed: true };
    }
    return {
      project: this.publicProject(res.project), replayed: false,
      apiKey: { keyId: res.key.key_id, key: g.key, prefix: res.key.key_prefix, label: res.key.label, scopes: res.key.scopes, expiresAt: res.key.expires_at, createdAt: res.key.created_at },
    };
  }

  _expiry({ expiresInDays, expiresAt } = {}) {
    if (expiresAt !== undefined && expiresAt !== null) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw badRequest("expiresAt must be a valid future date.");
      return d.toISOString();
    }
    if (expiresInDays !== undefined && expiresInDays !== null) {
      const n = Number(expiresInDays);
      if (!Number.isFinite(n) || n <= 0 || n > 3650) throw badRequest("expiresInDays must be between 1 and 3650.");
      return new Date(Date.now() + n * 86400000).toISOString();
    }
    return null;
  }

  // ---------- quotas ----------
  async getQuotas(projectId) {
    const p = await this.getProject(projectId);
    return { ...getConfig().quotas, ...(p.quotas || {}) };
  }

  async setQuotas(projectId, raw) {
    this.clearAuthCache();
    await this.getProject(projectId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Quotas must be a JSON object.");
    const allowed = Object.keys(getConfig().quotas);
    const next = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!allowed.includes(k)) throw badRequest(`Unknown quota "${String(k).slice(0, 40)}". Valid quotas: ${allowed.join(", ")}.`);
      if (!Number.isInteger(v) || v < 1 || v > Number.MAX_SAFE_INTEGER) throw badRequest(`Quota "${k}" must be a positive integer.`);
      next[k] = v;
    }
    const current = (await this.store.getProject(projectId)).quotas || {};
    await this.store.setQuotas(projectId, { ...current, ...next });
    return this.getQuotas(projectId);
  }

  // ---------- usage (batched) ----------
  /*
   * Per-request counters are accumulated in memory and written in one UPSERT
   * per project every MAESTRO_USAGE_FLUSH_MS (and on read / shutdown). A hard
   * crash can lose at most one flush interval of counters; usage reads flush
   * first so they are always current for this instance.
   */
  recordUsage(projectId, deltas) {
    const cur = this._usageBuf.get(projectId) || {};
    for (const [k, v] of Object.entries(deltas)) cur[k] = (cur[k] || 0) + Number(v || 0);
    this._usageBuf.set(projectId, cur);
    const ms = getConfig().usageFlushMs;
    if (ms === 0) return this.flushUsage();
    if (!this._usageTimer) { this._usageTimer = setTimeout(() => { this._usageTimer = null; this.flushUsage().catch(() => {}); }, ms); this._usageTimer.unref(); }
    return Promise.resolve();
  }
  async flushUsage() {
    if (this._usageTimer) { clearTimeout(this._usageTimer); this._usageTimer = null; }
    const batch = [...this._usageBuf.entries()];
    this._usageBuf.clear();
    for (const [projectId, deltas] of batch) {
      try { await this.store.incrementUsage(projectId, deltas); }
      catch (e) { // keep the counters for the next flush instead of losing them
        const cur = this._usageBuf.get(projectId) || {};
        for (const [k, v] of Object.entries(deltas)) cur[k] = (cur[k] || 0) + v;
        this._usageBuf.set(projectId, cur);
        throw e;
      }
    }
  }

  // ---------- audit ----------
  /* Audit failures never block the request, but are always logged. */
  async audit(event) {
    try { await this.store.addAuditEvent(event); }
    catch (e) { console.error("[maestro] audit write failed:", e.message); }
  }
  async listAudit(opts) { return this.store.listAuditEvents(opts); }

  publicProject(p) {
    return { projectId: p.project_id, name: p.name, status: p.status, createdAt: p.created_at };
  }

  async listProjects() { return (await this.store.listProjects()).map((p) => this.publicProject(p)); }

  async getProject(projectId) {
    validateProjectId(projectId);
    const p = await this.store.getProject(projectId);
    if (!p || p.status === "deleted") throw notFound("Project not found.");
    return p;
  }

  async getOwnedProject(projectId, clientId) {
    const project = await this.getProject(projectId);
    if (!clientId || project.owner_client_id !== clientId) throw notFound("Project not found.");
    return project;
  }

  async listOwnedProjects(clientId) {
    return (await this.store.listProjectsForClient(clientId)).map((p) => this.publicProject(p));
  }

  async getOwnedProjectDetails(projectId, clientId) {
    await this.getOwnedProject(projectId, clientId);
    return this.getProjectDetails(projectId);
  }

  async getProjectDetails(projectId) {
    const p = await this.getProject(projectId);
    const [keys, mappings, usage] = await Promise.all([
      this.listApiKeys(projectId), this.store.listMappings(projectId), this.store.getUsage(projectId),
    ]);
    return {
      ...this.publicProject(p),
      apiKeys: keys,
      collections: mappings.map((m) => this.publicMapping(m)),
      usage: this.publicUsage(usage),
    };
  }

  async createApiKey(projectId, label, { scopes, expiresInDays, expiresAt, rotatedFrom } = {}) {
    const p = await this.getProject(projectId);
    if (p.status !== "active") throw forbidden("Project is not active.");
    const g = generateApiKey();
    const row = await this.store.createApiKey({
      keyId: g.keyId, projectId, hash: g.hash, prefix: g.prefix,
      label: typeof label === "string" ? label.slice(0, 60) : null,
      scopes: validateScopes(scopes), expiresAt: this._expiry({ expiresInDays, expiresAt }), rotatedFrom: rotatedFrom || null,
    });
    // `key` is the only place the secret is ever exposed.
    return { keyId: row.key_id, key: g.key, prefix: row.key_prefix, label: row.label, scopes: row.scopes, expiresAt: row.expires_at, createdAt: row.created_at };
  }

  async listApiKeys(projectId) {
    await this.getProject(projectId);
    return (await this.store.listApiKeys(projectId)).map((k) => ({
      keyId: k.key_id, prefix: k.key_prefix, label: k.label, status: this._keyStatus(k), scopes: k.scopes, expiresAt: k.expires_at || null,
      rotatedFrom: k.rotated_from || null, createdAt: k.created_at, lastUsedAt: k.last_used_at,
    }));
  }

  _keyStatus(k) {
    if (k.status !== "active") return k.status;
    return k.expires_at && new Date(k.expires_at).getTime() <= Date.now() ? "expired" : "active";
  }

  async revokeApiKey(projectId, keyId) {
    this.clearAuthCache();
    await this.getProject(projectId);
    validateKeyId(keyId);
    if (!(await this.store.revokeApiKey(projectId, keyId))) throw notFound("API key not found.");
  }

  /*
   * Rotation: issues a replacement key with the same scopes and expires the
   * old one after `graceSeconds` (default 0 = revoked immediately; max 7 days)
   * so clients can switch over without downtime.
   */
  async rotateApiKey(projectId, keyId, { graceSeconds = 0, label } = {}) {
    await this.getProject(projectId);
    validateKeyId(keyId);
    const grace = Number(graceSeconds);
    if (!Number.isInteger(grace) || grace < 0 || grace > 7 * 86400) throw badRequest("graceSeconds must be an integer between 0 and 604800.");
    const old = await this.store.getApiKey(keyId);
    if (!old || old.project_id !== projectId || old.status !== "active") throw notFound("API key not found.");
    const fresh = await this.createApiKey(projectId, label || old.label, {
      scopes: old.scopes, expiresAt: old.expires_at && new Date(old.expires_at).getTime() > Date.now() ? old.expires_at : undefined, rotatedFrom: keyId,
    });
    if (grace === 0) await this.store.revokeApiKey(projectId, keyId);
    else await this.store.setApiKeyExpiry(projectId, keyId, new Date(Date.now() + grace * 1000).toISOString());
    this.clearAuthCache();
    return { ...fresh, replaced: keyId, oldKeyValidForSeconds: grace };
  }

  /*
   * Resolves `Authorization: Bearer pk_...` to a server-side context.
   * Nothing client-supplied other than the key itself influences the
   * resulting projectId.
   */
  /*
   * Successful authentications are cached in-process for a few seconds
   * (MAESTRO_AUTH_CACHE_TTL_MS, 0 disables) so the control-plane database is
   * not hit twice per request. Revoking, rotating, expiring or deleting
   * through THIS instance clears the cache immediately; on other instances a
   * revoked key can keep working for at most the TTL. Key expiry is always
   * re-checked on a hit.
   */
  _authKey(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
  clearAuthCache() { this._authCache.clear(); }

  async authenticate(authorizationHeader) {
    const token = extractBearer(authorizationHeader);
    const parsed = token && parseApiKey(token);
    if (!parsed) throw unauthorized();
    const ttl = getConfig().authCacheTtlMs;
    const ck = ttl > 0 ? this._authKey(token) : null;
    if (ck) {
      const hit = this._authCache.get(ck);
      if (hit && Date.now() < hit.until && !(hit.keyExpiresAt && hit.keyExpiresAt <= Date.now())) return { ...hit.ctx, scopes: [...hit.ctx.scopes] };
      if (hit) this._authCache.delete(ck);
    }
    const ctx = await this._authenticateUncached(token, parsed);
    if (ck) {
      if (this._authCache.size > 5000) this._authCache.clear();
      this._authCache.set(ck, { ctx, until: Date.now() + ttl, keyExpiresAt: ctx._keyExpiresAt || 0 });
    }
    return { ...ctx, scopes: [...ctx.scopes] };
  }

  async _authenticateUncached(token, parsed) {
    const row = await this.store.getApiKey(parsed.keyId);
    const ok = verifyApiKey(token, row ? row.key_hash : DUMMY_HASH);
    if (!row || !ok) throw unauthorized();
    if (row.status !== "active") throw unauthorized("API key has been revoked.");
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw unauthorized("API key has expired.");
    const project = await this.store.getProject(row.project_id);
    if (!project || project.status !== "active") throw unauthorized();
    const last = this._touched.get(row.key_id) || 0;
    if (Date.now() - last > TOUCH_INTERVAL_MS) {
      this._touched.set(row.key_id, Date.now());
      this.store.touchApiKey(row.key_id).catch(() => {});
    }
    return {
      _keyExpiresAt: row.expires_at ? new Date(row.expires_at).getTime() : 0,
      projectId: row.project_id, apiKeyId: row.key_id, projectName: project.name,
      scopes: Array.isArray(row.scopes) ? row.scopes : [], quotas: { ...getConfig().quotas, ...(project.quotas || {}) },
    };
  }

  async softDeleteProject(projectId) {
    this.clearAuthCache();
    await this.getProject(projectId);
    await this.store.revokeAllApiKeys(projectId);
    await this.store.setProjectStatus(projectId, "deleted");
  }

  publicMapping(m) {
    return {
      collection: m.collection, dbType: m.db_type, databaseName: m.database_name || null,
      physicalName: m.physical_name, routingReason: m.routing_reason, createdAt: m.created_at,
    };
  }

  publicUsage(u) {
    return {
      requests: u.requests, queries: u.queries, inserts: u.inserts, updates: u.updates, deletes: u.deletes,
      errors: u.errors, storageBytes: u.storage_bytes, lastActivity: u.last_activity,
    };
  }
}

module.exports = { ControlPlane };
