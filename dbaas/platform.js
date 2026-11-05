/*
 * The data plane + collection management. Every public method takes a
 * server-resolved context `ctx = { projectId, scopes, quotas, ... }` (from
 * the auth middleware) as its FIRST argument and never reads a project id
 * from client input. The chain for every operation is:
 *
 *   ctx.projectId -> collection (validated) -> storage mapping row
 *   (looked up by projectId+collection) -> adapter -> physical store
 *
 * so a request can only ever reach storage that the control plane mapped
 * to its own project.
 */
const crypto = require("crypto");
const { getConfig } = require("./config");
const { DbaasError, badRequest, notFound, conflict, quotaExceeded, payloadTooLarge } = require("./errors");
const V = require("./validators");
const { recommendStorage } = require("./intelligent-router");
const { readRecords, FieldProfiler, MAX_ROW_ERRORS_REPORTED } = require("./importer");
const { metrics } = require("./metrics");

const MAPPING_TTL_MS = 10000;
const CAPACITY_TTL_MS = 10000;
const IMPORT_BATCH = 200;
const IMPORT_CONCURRENCY = 8;
const IMPORT_ABORT_AFTER_BACKEND_FAILURES = 20;
const bump = (ctx, field, n = 1) => { if (ctx.usage) ctx.usage[field] = (ctx.usage[field] || 0) + n; };
const quotasOf = (ctx) => ctx.quotas || getConfig().quotas;

class Platform {
  constructor({ controlPlane, adapters, cache, recommend = recommendStorage, routerOptions = {} }) {
    this.cp = controlPlane;
    this.store = controlPlane.store;
    this.adapters = adapters;
    this.cache = cache;
    this.recommend = recommend;
    this.routerOptions = routerOptions;
    this._mappings = new Map();
    this._capacity = new Map();
  }

  // ---------- mapping resolution ----------
  async _mapping(ctx, collection) {
    V.validateCollectionName(collection);
    const key = `${ctx.projectId}\u0000${collection}`;
    const hit = this._mappings.get(key);
    if (hit && Date.now() - hit.at < MAPPING_TTL_MS) return hit.mapping;
    const mapping = await this.store.getMapping(ctx.projectId, collection);
    if (!mapping || mapping.project_id !== ctx.projectId) {
      this._mappings.delete(key);
      throw notFound(`Collection "${collection}" does not exist in this project.`);
    }
    this._mappings.set(key, { mapping, at: Date.now() });
    return mapping;
  }

  _adapter(mapping) {
    const a = this.adapters[mapping.db_type];
    if (!a) throw new Error(`No adapter for ${mapping.db_type}`);
    return a;
  }

  // ---------- quotas ----------
  async _capacitySnapshot(ctx) {
    const hit = this._capacity.get(ctx.projectId);
    if (hit && Date.now() - hit.at < CAPACITY_TTL_MS) return hit;
    const mappings = await this.store.listMappings(ctx.projectId);
    let docs = 0; let bytes = 0;
    for (const m of mappings) {
      const adapter = this._adapter(m);
      const [n, b] = await Promise.all([
        adapter.count(m, { queryType: "count", filters: [] }).catch(() => 0),
        adapter.storageBytes(m).catch(() => 0),
      ]);
      docs += Number(n) || 0; bytes += Number(b) || 0;
    }
    const snap = { at: Date.now(), docs, bytes };
    this._capacity.set(ctx.projectId, snap);
    return snap;
  }

  /*
   * Soft quota check for writes. When a limit is reached, WRITES are
   * refused with 403 quota_exceeded; reads and deletes keep working so a
   * project can always free space. The usage snapshot is cached for a few
   * seconds, so under heavy concurrency a project may overshoot a limit
   * slightly (documented in DBaaS.md).
   */
  async _enforceCapacity(ctx, adding = 1) {
    const q = quotasOf(ctx);
    const snap = await this._capacitySnapshot(ctx);
    if (snap.docs + adding > q.maxDocuments) {
      metrics.inc("maestro_quota_rejections_total", { quota: "maxDocuments" });
      throw quotaExceeded("maxDocuments", q.maxDocuments);
    }
    if (snap.bytes >= q.maxStorageBytes) {
      metrics.inc("maestro_quota_rejections_total", { quota: "maxStorageBytes" });
      throw quotaExceeded("maxStorageBytes", q.maxStorageBytes);
    }
    snap.docs += adding; // optimistic, corrected on the next refresh
  }
  _forgetCapacity(ctx) { this._capacity.delete(ctx.projectId); }

  // ---------- collections ----------
  publicCollection(ctx, mapping) {
    return {
      success: true,
      projectId: ctx.projectId,
      collection: mapping.collection,
      storage: { dbType: mapping.db_type, routingReason: mapping.routing_reason, createdAt: mapping.created_at },
    };
  }

  // First non-null value per field across sample rows, so schema inference is
  // not fooled by an empty cell in the first row.
  _mergeSample(rows) {
    const merged = {};
    for (const row of rows) for (const [k, v] of Object.entries(row)) if (!(k in merged) || (merged[k] === null && v !== null)) merged[k] = v;
    return merged;
  }

  async createCollection(ctx, body = {}, { autoCreated = false, sampleRows = null } = {}) {
    if (!V.isPlainObject(body)) throw badRequest("Request body must be a JSON object.");
    const name = V.validateCollectionName(body.name);
    const rows = sampleRows && sampleRows.length ? sampleRows : null;
    const sample = rows ? this._mergeSample(rows) : V.validateDocument(body.sampleData === undefined ? {} : body.sampleData, { allowEmpty: true });
    let hint = null;
    if (body.storageHint !== undefined && body.storageHint !== null) {
      if (!V.STORE_TYPES.includes(body.storageHint)) throw badRequest(`storageHint must be one of: ${V.STORE_TYPES.join(", ")}.`);
      hint = body.storageHint;
    }

    if (await this.store.getCollection(ctx.projectId, name)) throw conflict(`Collection "${name}" already exists.`);
    const existing = await this.store.listCollections(ctx.projectId);
    const limit = quotasOf(ctx).maxCollections;
    if (existing.length >= limit) {
      metrics.inc("maestro_quota_rejections_total", { quota: "maxCollections" });
      throw quotaExceeded("maxCollections", limit, `Project has reached the collection limit (${limit}).`);
    }

    // 1. Decide where it lives. The analysis only *recommends*; this
    //    method validates and makes the final choice.
    let decision;
    if (hint) {
      decision = { dbType: hint, reason: `Developer-specified storage hint (${hint}).`, source: "hint", confidence: 100, scores: null, warnings: [] };
    } else if (Object.keys(sample).length) {
      decision = await this.recommend(rows || [sample], name, this.routerOptions);
    } else {
      decision = { dbType: "postgresql", reason: "No sample data supplied; defaulted to postgresql.", source: "default", confidence: 0, scores: null, warnings: [] };
    }
    if (!V.STORE_TYPES.includes(decision.dbType)) throw new Error("Router produced an invalid store.");

    // 2. Create physical storage, 3. record the mapping.
    const adapter = this.adapters[decision.dbType];
    const plan = await adapter.plan({ projectId: ctx.projectId, collection: name, sample });
    const mapping = {
      project_id: ctx.projectId, collection: name, db_type: decision.dbType,
      database_name: plan.database_name, physical_name: plan.physical_name,
      routing_reason: decision.reason,
      routing_detail: { source: decision.source, confidence: decision.confidence, scores: decision.scores, warnings: decision.warnings, autoCreated },
      schema: plan.schema,
    };
    await adapter.createStorage(mapping);
    try {
      const saved = await this.store.createCollectionWithMapping(
        { collection_id: `col_${crypto.randomBytes(6).toString("hex")}`, project_id: ctx.projectId, name }, mapping);
      await this.cp.audit({ projectId: ctx.projectId, actor: `key:${ctx.apiKeyId}`, action: "collection.create", target: name, requestId: ctx.requestId, ip: ctx.ip, detail: { dbType: decision.dbType, autoCreated } });
      return this.publicCollection(ctx, saved.mapping);
    } catch (e) {
      // Lost a creation race: keep the winner's storage, drop ours if it differs.
      const winner = await this.store.getMapping(ctx.projectId, name).catch(() => null);
      if (!winner || winner.db_type !== mapping.db_type) await adapter.dropStorage(mapping).catch(() => {});
      throw e;
    }
  }

  async listCollections(ctx) {
    const mappings = await this.store.listMappings(ctx.projectId);
    return { success: true, projectId: ctx.projectId, collections: mappings.map((m) => ({
      name: m.collection, dbType: m.db_type, routingReason: m.routing_reason, createdAt: m.created_at })) };
  }

  async getCollection(ctx, name) {
    const m = await this._mapping(ctx, name);
    const documents = await this._adapter(m).count(m, { queryType: "count", filters: [] });
    return { ...this.publicCollection(ctx, m), documents };
  }

  async deleteCollection(ctx, name) {
    const m = await this._mapping(ctx, name);
    await this._adapter(m).dropStorage(m);
    await this.store.deleteCollection(ctx.projectId, name);
    this._mappings.delete(`${ctx.projectId}\u0000${name}`);
    this._forgetCapacity(ctx);
    await this.cache.invalidateCollection(ctx.projectId, name);
    await this.cp.audit({ projectId: ctx.projectId, actor: `key:${ctx.apiKeyId}`, action: "collection.delete", target: name, requestId: ctx.requestId, ip: ctx.ip });
    return { success: true, projectId: ctx.projectId, collection: name, deleted: true };
  }

  // ---------- data ----------
  async _mappingOrAutoCreate(ctx, collection, sample, sampleRows, storageHint) {
    try {
      return await this._mapping(ctx, collection);
    } catch (e) {
      if (e.status !== 404 || !getConfig().autoCreateCollections) throw e;
      try {
        await this.createCollection(ctx, { name: collection, sampleData: sample, storageHint: storageHint || undefined }, { autoCreated: true, sampleRows });
      } catch (createErr) {
        if (createErr.status !== 409) throw createErr; // someone else created it concurrently
      }
      return this._mapping(ctx, collection);
    }
  }

  async insert(ctx, body = {}) {
    if (!V.isPlainObject(body)) throw badRequest("Request body must be a JSON object.");
    const collection = V.validateCollectionName(body.collection);
    const data = V.validateDocument(body.data);
    const mapping = await this._mappingOrAutoCreate(ctx, collection, data);
    await this._enforceCapacity(ctx, 1);
    const doc = await this._adapter(mapping).create(mapping, { id: crypto.randomUUID(), data });
    await this.cache.invalidateCollection(ctx.projectId, collection);
    bump(ctx, "inserts");
    return { success: true, projectId: ctx.projectId, collection, ...doc };
  }

  async getById(ctx, collection, rawId) {
    const id = V.validateDocumentId(rawId);
    const mapping = await this._mapping(ctx, collection);
    const { value, ver } = await this.cache.getDoc(ctx.projectId, collection, id);
    let doc = value;
    const cached = Boolean(doc);
    if (!doc) {
      doc = await this._adapter(mapping).findOne(mapping, id);
      if (!doc) throw notFound("Document not found.");
      await this.cache.setDoc(ctx.projectId, collection, id, ver, doc);
    }
    bump(ctx, "queries");
    return { success: true, projectId: ctx.projectId, collection, cached, ...doc };
  }

  async update(ctx, collection, rawId, body = {}, { merge = false } = {}) {
    const id = V.validateDocumentId(rawId);
    if (!V.isPlainObject(body)) throw badRequest("Request body must be a JSON object.");
    let data = V.validateDocument(body.data);
    const mapping = await this._mapping(ctx, collection);
    const adapter = this._adapter(mapping);
    if (merge) {
      const current = await adapter.findOne(mapping, id);
      if (!current) throw notFound("Document not found.");
      data = V.validateDocument({ ...current.data, ...data });
    }
    const doc = await adapter.update(mapping, id, data);
    if (!doc) throw notFound("Document not found.");
    await this.cache.invalidateCollection(ctx.projectId, collection);
    bump(ctx, "updates");
    return { success: true, projectId: ctx.projectId, collection, ...doc };
  }

  async remove(ctx, collection, rawId) {
    const id = V.validateDocumentId(rawId);
    const mapping = await this._mapping(ctx, collection);
    const deleted = await this._adapter(mapping).delete(mapping, id);
    if (!deleted) throw notFound("Document not found.");
    this._forgetCapacity(ctx);
    await this.cache.invalidateCollection(ctx.projectId, collection);
    bump(ctx, "deletes");
    return { success: true, projectId: ctx.projectId, collection, id, deleted: true };
  }

  // ---------- queries ----------
  async query(ctx, body = {}) {
    const spec = V.validateQueryRequest(body);
    const mapping = await this._mapping(ctx, spec.collection);
    bump(ctx, "queries");

    // The version is read BEFORE the database so a concurrent write can
    // never leave a stale result under the new version (see cache.js).
    const { value, ver } = await this.cache.getQuery(ctx.projectId, spec.collection, spec);
    if (value) {
      return { success: true, projectId: ctx.projectId, collection: spec.collection, queryType: spec.queryType, cached: true, ...value };
    }
    const result = await this._adapter(mapping).query(mapping, spec);
    const payload = { results: result.results, resultCount: result.resultCount };
    await this.cache.setQuery(ctx.projectId, spec.collection, spec, ver, payload);
    return { success: true, projectId: ctx.projectId, collection: spec.collection, queryType: spec.queryType, cached: false, ...payload };
  }

  async list(ctx, collection, params = {}) {
    let filters;
    if (params.filters !== undefined) {
      try { filters = JSON.parse(params.filters); } catch (e) { throw badRequest('"filters" must be valid JSON.'); }
    }
    return this.query(ctx, { collection, queryType: "select", filters, sort: params.sort, limit: params.limit, offset: params.offset });
  }

  // ---------- bulk import ----------
  /*
   * Validates, profiles and (unless dryRun) writes an uploaded file.
   * Outcomes are reported per row; a partially failing import is reported
   * as "partial" (HTTP 207) and never as success. See DBaaS.md > Import.
   */
  async importFile(ctx, { collection: rawCollection, filePath, filename, dryRun = false, idField, onDuplicate = "error", storageHint }) {
    const collection = V.validateCollectionName(rawCollection);
    if (!["skip", "error", "replace"].includes(onDuplicate)) throw badRequest('onDuplicate must be "skip", "error" or "replace".');
    if (idField !== undefined && idField !== null && idField !== "") V.validateFieldPath(idField, { allowDotted: false });
    else idField = null;
    if (storageHint !== undefined && storageHint !== null && storageHint !== "" && !V.STORE_TYPES.includes(storageHint)) {
      throw badRequest(`storageHint must be one of: ${V.STORE_TYPES.join(", ")}.`);
    }
    const q = quotasOf(ctx);
    const importId = `imp_${crypto.randomBytes(6).toString("hex")}`;
    const profiler = new FieldProfiler();
    const errors = []; let errorCount = 0;
    const addError = (row, message) => { errorCount += 1; if (errors.length < MAX_ROW_ERRORS_REPORTED) errors.push({ row, message }); };
    const counts = { total: 0, valid: 0, inserted: 0, skipped: 0, replaced: 0 };
    const sampleRows = [];
    let pending = [];
    let mapping = null; let existingMapping = null; let aborted = null; let backendFailures = 0; let attempted = false;
    const warnings = [];

    try { existingMapping = await this._mapping(ctx, collection); } catch (e) { if (e.status !== 404) throw e; }
    const adapterForExisting = existingMapping ? this._adapter(existingMapping) : null;

    const flush = async () => {
      if (!pending.length || aborted) { pending = []; return; }
      const batch = pending; pending = [];
      if (!mapping) {
        mapping = existingMapping || await this._mappingOrAutoCreate(ctx, collection, batch[0].data, [...sampleRows], storageHint);
      }
      await this._enforceCapacity(ctx, batch.length).catch((e) => {
        if (e.code !== "quota_exceeded") throw e;
        aborted = `Stopped: ${e.message}`;
        batch.forEach((r) => addError(r.row, "Not imported: project quota reached."));
        return "blocked";
      });
      if (aborted) return;
      attempted = true;
      const adapter = this._adapter(mapping);
      for (let i = 0; i < batch.length && !aborted; i += IMPORT_CONCURRENCY) {
        const slice = batch.slice(i, i + IMPORT_CONCURRENCY);
        const outcomes = await Promise.all(slice.map(async (r) => {
          try {
            await adapter.create(mapping, { id: r.id, data: r.data });
            return { r, ok: "inserted" };
          } catch (e) {
            if (e.code === "duplicate_id") {
              if (onDuplicate === "skip") return { r, ok: "skipped" };
              if (onDuplicate === "replace") {
                try { await adapter.update(mapping, r.id, r.data); return { r, ok: "replaced" }; } catch (e2) { return { r, err: e2 }; }
              }
            }
            return { r, err: e };
          }
        }));
        for (const o of outcomes) {
          if (o.ok === "inserted") counts.inserted += 1;
          else if (o.ok === "skipped") counts.skipped += 1;
          else if (o.ok === "replaced") counts.replaced += 1;
          else {
            const e = o.err;
            const backend = e instanceof DbaasError ? e.status >= 500 : true;
            if (backend) { backendFailures += 1; addError(o.r.row, "Storage backend error; row not imported."); }
            else addError(o.r.row, e.code === "duplicate_id" ? `Duplicate id "${o.r.id}".` : e.message);
          }
        }
        if (backendFailures >= IMPORT_ABORT_AFTER_BACKEND_FAILURES) aborted = "Aborted: the storage backend kept failing. Retry later (use idField + onDuplicate=skip to make retries safe).";
      }
    };

    const meta = { mapping: null };
    const seenIds = new Map();
    for await (const item of readRecords(filePath, filename, { maxRows: q.maxImportRows, meta })) {
      counts.total += 1;
      if (item.error) { addError(item.row, item.error); continue; }
      let id = null;
      try {
        V.validateDocument(item.data);
        if (idField) {
          const raw = item.data[idField];
          if (raw === undefined || raw === null || raw === "") throw badRequest(`Missing id field "${idField}".`);
          id = V.validateDocumentId(typeof raw === "number" ? String(raw) : raw);
        }
        if (existingMapping && adapterForExisting.validate) adapterForExisting.validate(existingMapping, item.data);
        if (id !== null) {
          if (seenIds.has(id)) {
            if (onDuplicate === "skip") { counts.skipped += 1; counts.valid += 1; continue; }
            throw badRequest(`Duplicate id "${id}" within the file (first seen at row ${seenIds.get(id)}).`);
          }
          seenIds.set(id, item.row);
        }
      } catch (e) {
        if (!(e instanceof DbaasError) || e.status >= 500) throw e;
        addError(item.row, e.message);
        continue;
      }
      counts.valid += 1;
      profiler.add(item.data);
      if (sampleRows.length < 100) sampleRows.push(item.data);
      if (!dryRun) {
        pending.push({ row: item.row, id: id || crypto.randomUUID(), data: item.data });
        if (pending.length >= IMPORT_BATCH) await flush();
      }
    }
    const fieldMapping = meta.mapping;
    if (counts.total === 0) throw badRequest("The file contains no records.");

    let routing = null;
    if (dryRun) {
      if (existingMapping) routing = { dbType: existingMapping.db_type, source: "existing_collection", reason: existingMapping.routing_reason };
      else if (storageHint) routing = { dbType: storageHint, source: "hint", reason: `Developer-specified storage hint (${storageHint}).` };
      else if (sampleRows.length) {
        const d = await this.recommend(sampleRows, collection, this.routerOptions);
        routing = { dbType: d.dbType, source: d.source, confidence: d.confidence, reason: d.reason, warnings: d.warnings };
      }
    } else {
      await flush();
      if (mapping || existingMapping) {
        const m = mapping || existingMapping;
        routing = { dbType: m.db_type, source: existingMapping ? "existing_collection" : (m.routing_detail && m.routing_detail.source) || "router", reason: m.routing_reason };
      }
    }

    const written = counts.inserted + counts.replaced;
    const invalid = counts.total - counts.valid;
    const failed = errorCount;
    let status;
    if (dryRun) status = "dry_run";
    else if (aborted || (failed > 0 && written + counts.skipped > 0)) status = "partial";
    else if (failed > 0 || written + counts.skipped === 0) status = "failed";
    else status = "success";

    if (!dryRun) {
      if (attempted) {
        await this.cache.invalidateCollection(ctx.projectId, collection); // after every import, even partial ones
        this._forgetCapacity(ctx);
      }
      bump(ctx, "inserts", counts.inserted);
      bump(ctx, "updates", counts.replaced);
    }
    await this.store.recordImportJob({ importId, projectId: ctx.projectId, collection, status, dryRun, total: counts.total, inserted: written, skipped: counts.skipped, failed }).catch(() => {});
    await this.cp.audit({ projectId: ctx.projectId, actor: `key:${ctx.apiKeyId}`, action: dryRun ? "import.dry_run" : "import.run", target: collection, requestId: ctx.requestId, ip: ctx.ip,
      detail: { importId, status, total: counts.total, inserted: written, skipped: counts.skipped, failed } });

    const schema = profiler.report();
    return {
      success: status !== "failed", importId, collection, dryRun, status,
      summary: { total: counts.total, valid: counts.valid, invalid, inserted: counts.inserted, replaced: counts.replaced, skipped: counts.skipped, failed, ...(aborted ? { aborted } : {}) },
      errors, errorsTruncated: errorCount > errors.length,
      fieldMapping, schema: { rows: schema.rows, fields: schema.fields }, routing,
      warnings: [...schema.warnings, ...warnings],
      note: !dryRun && !idField ? "No idField was given, so re-uploading this file inserts the rows again. Use idField (+ onDuplicate=skip) for idempotent retries." : undefined,
    };
  }

  // ---------- usage / project lifecycle ----------
  async usage(ctx) {
    const warnings = new Set();
    await this.cp.flushUsage().catch(() => { warnings.add("Usage counters may be stale."); });
    const mappings = await this.store.listMappings(ctx.projectId);
    const collections = [];
    let total = 0;
    let totalStorageAvailable = true;
    for (const m of mappings) {
      const adapter = this._adapter(m);
      const [bytes, documents] = await Promise.all([
        adapter.storageBytes(m).catch(() => {
          warnings.add("Storage size unavailable for one or more collections.");
          return null;
        }),
        adapter.count(m, { queryType: "count", filters: [] }).catch(() => {
          warnings.add("Document counts unavailable for one or more collections.");
          return null;
        }),
      ]);
      if (bytes === null || bytes === undefined) {
        totalStorageAvailable = false;
      } else {
        total += bytes;
      }
      collections.push({ name: m.collection, dbType: m.db_type, storageBytes: bytes, documents });
    }
    if (totalStorageAvailable) await this.store.setStorageBytes(ctx.projectId, total);
    const usage = this.cp.publicUsage(await this.store.getUsage(ctx.projectId));
    if (!totalStorageAvailable) usage.storageBytes = null;
    const quotas = ctx.quotas || (await this.cp.getQuotas(ctx.projectId));
    return { success: true, projectId: ctx.projectId, usage, quotas, collections, warnings: [...warnings] };
  }

  /*
   * Deleting with purge drops every store the project owns. Each store is
   * attempted independently and reported separately; if ANY store fails the
   * project is left intact (keys stay valid) and a 502 `purge_incomplete`
   * with per-store outcomes is returned. Purging is idempotent, so the
   * operator can simply retry.
   */
  async deleteProject(projectId, { purge = false } = {}) {
    await this.cp.getProject(projectId);
    let stores = [];
    if (purge) {
      const mappings = await this.store.listMappings(projectId);
      for (const [dbType, adapter] of Object.entries(this.adapters)) {
        const mine = mappings.filter((m) => m.db_type === dbType);
        if (!mine.length) continue;
        try { await adapter.dropProjectStorage(projectId, mine); stores.push({ store: dbType, status: "purged", collections: mine.length }); }
        catch (e) { stores.push({ store: dbType, status: "failed", collections: mine.length, error: "storage backend failed" }); }
      }
      if (stores.some((s) => s.status === "failed")) {
        throw new DbaasError(502, "purge_incomplete", "Some stores could not be purged. The project was NOT deleted; retry the request.", { stores });
      }
      await this.cache.invalidateProject(projectId);
      await this.store.deleteAllCollections(projectId);
      for (const k of [...this._mappings.keys()]) if (k.startsWith(`${projectId}\u0000`)) this._mappings.delete(k);
      this._capacity.delete(projectId);
    }
    await this.cp.softDeleteProject(projectId);
    return { success: true, projectId, deleted: true, dataPurged: Boolean(purge), ...(purge ? { stores } : {}) };
  }

  // ---------- operations ----------
  async health() {
    const withTimeout = (p, ms = 1500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    const check = async (fn) => { try { await withTimeout(fn()); return "ok"; } catch (e) { return "unavailable"; } };
    const [controlPlane, redis, mongodb, elasticsearch] = await Promise.all([
      check(() => this.store.ping()),
      check(async () => { const c = await this.cache._client(); if (!c) throw new Error("off"); await c.ping(); }),
      check(() => this.adapters.mongodb.ping()),
      check(() => this.adapters.elasticsearch.ping()),
    ]);
    const breakers = Object.fromEntries(Object.entries(this.adapters).map(([k, a]) => [k, a.breaker ? a.breaker.state : "n/a"]));
    // Only the control plane is required for readiness; the rest degrade gracefully.
    return { ready: controlPlane === "ok", dependencies: { controlPlane, redis, mongodb, elasticsearch }, circuitBreakers: breakers };
  }

  poolStats() {
    const pg = this.adapters.postgresql;
    return pg && pg.poolStats ? pg.poolStats() : {};
  }

  async close() {
    await Promise.all(Object.values(this.adapters).map((a) => a.close && a.close().catch(() => {})));
    await this.cp.close();
  }
}

module.exports = { Platform };
