/*
 * PostgreSQL storage adapter.
 *
 * Layout (logical isolation): one PostgreSQL *database* per project
 * (`maestro_<projectId>`), one table per collection. Columns are
 * inferred from the sample document at collection creation; fields
 * that weren't in the sample go to a `_extra jsonb` column so inserts
 * never fail just because a new field appeared. All statements are
 * parameterised; the only strings interpolated into SQL are
 * identifiers that were validated by the API layer, re-validated by
 * assertSafeMapping, and double-quoted.
 */
const crypto = require("crypto");
const { Pool, Client } = require("pg");
const { getConfig } = require("../dbaas/config");
const { badRequest, duplicate } = require("../dbaas/errors");
const { assertSafeMapping, internalStoreError, escapeLike } = require("./common");

const MAX_COLUMNS = 100;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const q = (ident) => {
  if (!IDENT.test(ident)) throw new Error("Unsafe identifier.");
  return `"${ident}"`;
};

function inferColumnType(value) {
  if (typeof value === "number") return "double precision";
  if (typeof value === "boolean") return "boolean";
  if (value !== null && typeof value === "object") return "jsonb";
  return "text";
}

class PostgresAdapter {
  constructor({ pgConfig } = {}) {
    this._pgConfig = pgConfig;
    this.pools = new Map();
    this.dbType = "postgresql";
  }

  _cfg() { return this._pgConfig || getConfig().pg(); }

  _pool(database) {
    let pool = this.pools.get(database);
    if (!pool) {
      const t = getConfig().dbTimeoutMs;
      pool = new Pool({ ...this._cfg(), database, max: 4, idleTimeoutMillis: 10000, allowExitOnIdle: true, connectionTimeoutMillis: t, statement_timeout: t, query_timeout: t + 1000 });
      pool.on("error", () => {});
      this.pools.set(database, pool);
    }
    return pool;
  }

  // Used by /metrics: aggregate pool utilisation across project databases.
  poolStats() {
    let total = 0; let idle = 0; let waiting = 0;
    for (const p of this.pools.values()) { total += p.totalCount; idle += p.idleCount; waiting += p.waitingCount; }
    return { pools: this.pools.size, connections: total, idle, waiting };
  }

  // Dry-run support: throws the same type errors a real insert would.
  validate(mapping, data) { this._split(mapping, data); }

  async close() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => {})));
    this.pools.clear();
  }

  async ping() {
    const c = new Client(this._cfg());
    await c.connect();
    await c.end();
    return true;
  }

  async plan({ projectId, collection, sample }) {
    const columns = [];
    for (const [field, value] of Object.entries(sample || {})) {
      if (columns.length >= MAX_COLUMNS) break;
      columns.push({ field, type: inferColumnType(value) });
    }
    return { database_name: `maestro_${projectId}`, physical_name: collection, schema: { columns } };
  }

  // Concurrent first-writes to a brand-new collection can race on
  // CREATE DATABASE / CREATE TABLE IF NOT EXISTS (PostgreSQL does not make
  // those safely concurrent). Session-level advisory locks serialise them
  // across both requests and processes.
  async _ensureDatabase(database) {
    const admin = new Client(this._cfg());
    await admin.connect();
    try {
      await admin.query("SELECT pg_advisory_lock(7461002)");
      try {
        const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]);
        if (!exists.rowCount) {
          try {
            await admin.query(`CREATE DATABASE ${q(database)}`);
          } catch (e) {
            if (e.code !== "42P04" && e.code !== "23505") throw e;
          }
        }
      } finally {
        await admin.query("SELECT pg_advisory_unlock(7461002)").catch(() => {});
      }
    } finally {
      await admin.end().catch(() => {});
    }
  }

  async createStorage(mapping) {
    assertSafeMapping(mapping);
    try {
      await this._ensureDatabase(mapping.database_name);
      const cols = (mapping.schema?.columns || []).map((c) => `${q(c.field)} ${c.type}`);
      const sql = `CREATE TABLE IF NOT EXISTS ${q(mapping.physical_name)} (
        "_id" text PRIMARY KEY,
        "_created_at" timestamptz NOT NULL DEFAULT now(),
        "_updated_at" timestamptz NOT NULL DEFAULT now(),
        ${cols.length ? `${cols.join(",\n        ")},` : ""}
        "_extra" jsonb NOT NULL DEFAULT '{}'::jsonb
      )`;
      const client = await this._pool(mapping.database_name).connect();
      try {
        await client.query("SELECT pg_advisory_lock(7461003)");
        try {
          await client.query(sql);
          await client.query(`CREATE INDEX IF NOT EXISTS ${q(`${mapping.physical_name}_created_idx`.slice(0, 63))} ON ${q(mapping.physical_name)} ("_created_at")`);
        } finally {
          await client.query("SELECT pg_advisory_unlock(7461003)").catch(() => {});
        }
      } finally {
        client.release();
      }
    } catch (e) {
      throw internalStoreError("postgres createStorage", e);
    }
  }

  // ---- value <-> column helpers ----
  _columnMap(mapping) {
    return new Map((mapping.schema?.columns || []).map((c) => [c.field, c]));
  }

  _checkType(column, value) {
    if (value === null || value === undefined) return;
    const t = column.type;
    const ok =
      (t === "double precision" && typeof value === "number") ||
      (t === "boolean" && typeof value === "boolean") ||
      (t === "text" && typeof value === "string") ||
      t === "jsonb";
    if (!ok) {
      throw badRequest(`Field "${column.field}" expects ${t === "double precision" ? "a number" : t === "text" ? "a string" : t}, got ${typeof value}.`);
    }
  }

  _split(mapping, data) {
    const known = this._columnMap(mapping);
    const columnValues = new Map();
    const extra = {};
    for (const [field, value] of Object.entries(data)) {
      const col = known.get(field);
      if (col) {
        this._checkType(col, value);
        columnValues.set(field, value);
      } else {
        extra[field] = value;
      }
    }
    return { columnValues, extra };
  }

  _param(column, value) {
    if (value === undefined || value === null) return null;
    return column.type === "jsonb" ? JSON.stringify(value) : value;
  }

  _rowToDoc(mapping, row) {
    const data = {};
    for (const c of mapping.schema?.columns || []) {
      if (row[c.field] !== null && row[c.field] !== undefined) data[c.field] = row[c.field];
    }
    Object.assign(data, row._extra || {});
    return {
      id: row._id,
      data,
      createdAt: row._created_at instanceof Date ? row._created_at.toISOString() : row._created_at,
      updatedAt: row._updated_at instanceof Date ? row._updated_at.toISOString() : row._updated_at,
    };
  }

  async create(mapping, { id, data }) {
    assertSafeMapping(mapping);
    const { columnValues, extra } = this._split(mapping, data);
    const cols = mapping.schema?.columns || [];
    const names = ['"_id"', ...cols.map((c) => q(c.field)), '"_extra"'];
    const params = [id, ...cols.map((c) => this._param(c, columnValues.get(c.field))), JSON.stringify(extra)];
    const placeholders = params.map((_, i) => (i === params.length - 1 ? `$${i + 1}::jsonb` : cols[i - 1]?.type === "jsonb" ? `$${i + 1}::jsonb` : `$${i + 1}`));
    try {
      const r = await this._pool(mapping.database_name).query(
        `INSERT INTO ${q(mapping.physical_name)} (${names.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`, params);
      return this._rowToDoc(mapping, r.rows[0]);
    } catch (e) {
      if (e.code === "23505") throw duplicate();
      throw internalStoreError("postgres create", e);
    }
  }

  async findOne(mapping, id) {
    assertSafeMapping(mapping);
    try {
      const r = await this._pool(mapping.database_name).query(`SELECT * FROM ${q(mapping.physical_name)} WHERE "_id"=$1`, [id]);
      return r.rows[0] ? this._rowToDoc(mapping, r.rows[0]) : null;
    } catch (e) {
      throw internalStoreError("postgres findOne", e);
    }
  }

  async update(mapping, id, data) {
    assertSafeMapping(mapping);
    const { columnValues, extra } = this._split(mapping, data);
    const cols = mapping.schema?.columns || [];
    const sets = cols.map((c, i) => `${q(c.field)} = $${i + 2}${c.type === "jsonb" ? "::jsonb" : ""}`);
    const params = [id, ...cols.map((c) => this._param(c, columnValues.get(c.field))), JSON.stringify(extra)];
    sets.push(`"_extra" = $${params.length}::jsonb`, `"_updated_at" = now()`);
    try {
      const r = await this._pool(mapping.database_name).query(
        `UPDATE ${q(mapping.physical_name)} SET ${sets.join(", ")} WHERE "_id"=$1 RETURNING *`, params);
      return r.rows[0] ? this._rowToDoc(mapping, r.rows[0]) : null;
    } catch (e) {
      throw internalStoreError("postgres update", e);
    }
  }

  async delete(mapping, id) {
    assertSafeMapping(mapping);
    try {
      const r = await this._pool(mapping.database_name).query(`DELETE FROM ${q(mapping.physical_name)} WHERE "_id"=$1`, [id]);
      return r.rowCount > 0;
    } catch (e) {
      throw internalStoreError("postgres delete", e);
    }
  }

  // ---- query building (all values bound as parameters) ----
  _fieldExpr(mapping, field, params) {
    const known = this._columnMap(mapping);
    const segments = field.split(".");
    const col = known.get(segments[0]);
    if (col && segments.length === 1) {
      return { kind: col.type === "jsonb" ? "jsonb" : "scalar", type: col.type, expr: q(col.field), jsonbRoot: col.type === "jsonb" };
    }
    if (col && col.type !== "jsonb") throw badRequest(`Field "${segments[0]}" is not an object; "${field}" is invalid.`);
    const root = col ? q(col.field) : '"_extra"';
    const path = col ? segments.slice(1) : segments;
    params.push(path);
    return { kind: "jsonb", type: "jsonb", expr: `(${root} #> $${params.length}::text[])` };
  }

  _condition(mapping, { field, operator, value }, params) {
    const f = this._fieldExpr(mapping, field, params);
    const bind = (v) => { params.push(v); return `$${params.length}`; };

    if (f.kind === "scalar") {
      const expected = f.type;
      const check = (v) => {
        if (v === null) return;
        const ok = (expected === "double precision" && typeof v === "number") || (expected === "boolean" && typeof v === "boolean") || (expected === "text" && typeof v === "string");
        if (!ok) throw badRequest(`Filter on "${field}" must use ${expected === "double precision" ? "a number" : expected === "text" ? "a string" : expected}.`);
      };
      if (operator === "in") {
        value.forEach(check);
        const nonNull = value.filter((v) => v !== null);
        const parts = [];
        if (nonNull.length) parts.push(`${f.expr} = ANY(${bind(nonNull)})`);
        if (nonNull.length !== value.length) parts.push(`${f.expr} IS NULL`);
        return `(${parts.join(" OR ")})`;
      }
      check(value);
      if (operator === "eq") return value === null ? `${f.expr} IS NULL` : `${f.expr} = ${bind(value)}`;
      if (operator === "ne") return value === null ? `${f.expr} IS NOT NULL` : `${f.expr} IS DISTINCT FROM ${bind(value)}`;
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator];
      if (expected === "boolean") throw badRequest(`Operator "${operator}" is not valid for boolean field "${field}".`);
      return `${f.expr} ${op} ${bind(value)}`;
    }

    // jsonb path / jsonb column
    if (operator === "in") {
      return `${f.expr} = ANY(${bind(value.map((v) => JSON.stringify(v)))}::jsonb[])`;
    }
    if (operator === "eq") return `${f.expr} IS NOT DISTINCT FROM ${bind(JSON.stringify(value))}::jsonb`;
    if (operator === "ne") return `${f.expr} IS DISTINCT FROM ${bind(JSON.stringify(value))}::jsonb`;
    const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator];
    if (typeof value === "number") {
      return `(CASE WHEN jsonb_typeof(${f.expr}) = 'number' THEN (${f.expr} #>> '{}')::double precision END) ${op} ${bind(value)}`;
    }
    return `(CASE WHEN jsonb_typeof(${f.expr}) = 'string' THEN (${f.expr} #>> '{}') END) ${op} ${bind(value)}`;
  }

  _where(mapping, spec, params) {
    const clauses = (spec.filters || []).map((c) => this._condition(mapping, c, params));
    if (spec.queryType === "search" && spec.text) {
      const like = `%${escapeLike(spec.text)}%`;
      const exprs = [];
      if (spec.fields && spec.fields.length) {
        for (const field of spec.fields) {
          const f = this._fieldExpr(mapping, field, params);
          exprs.push(f.kind === "scalar" ? `${f.expr}::text` : `(${f.expr} #>> '{}')`);
        }
      } else {
        const textCols = (mapping.schema?.columns || []).filter((c) => c.type === "text");
        textCols.forEach((c) => exprs.push(q(c.field)));
        exprs.push('"_extra"::text');
      }
      params.push(like);
      const p = `$${params.length}`;
      clauses.push(`(${exprs.map((e) => `${e} ILIKE ${p} ESCAPE '\\'`).join(" OR ")})`);
    }
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  }

  _orderBy(mapping, spec, params) {
    if (!spec.sort) return 'ORDER BY "_created_at" ASC, "_id" ASC';
    const f = this._fieldExpr(mapping, spec.sort.field, params);
    const dir = spec.sort.direction === "desc" ? "DESC" : "ASC";
    return `ORDER BY ${f.expr} ${dir}, "_id" ASC`;
  }

  async find(mapping, spec) {
    assertSafeMapping(mapping);
    const params = [];
    try {
      const where = this._where(mapping, spec, params);
      const order = this._orderBy(mapping, spec, params);
      params.push(spec.limit, spec.offset || 0);
      const sql = `SELECT * FROM ${q(mapping.physical_name)} ${where} ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const r = await this._pool(mapping.database_name).query(sql, params);
      const results = r.rows.map((row) => this._rowToDoc(mapping, row));
      return { results, resultCount: results.length };
    } catch (e) {
      if (e.name === "DbaasError") throw e;
      throw internalStoreError("postgres find", e);
    }
  }

  async count(mapping, spec) {
    assertSafeMapping(mapping);
    const params = [];
    try {
      const where = this._where(mapping, spec, params);
      const r = await this._pool(mapping.database_name).query(`SELECT count(*)::bigint AS n FROM ${q(mapping.physical_name)} ${where}`, params);
      return Number(r.rows[0].n);
    } catch (e) {
      if (e.name === "DbaasError") throw e;
      throw internalStoreError("postgres count", e);
    }
  }

  async query(mapping, spec) {
    if (spec.queryType === "count") {
      const n = await this.count(mapping, spec);
      return { results: [], resultCount: n };
    }
    return this.find(mapping, spec);
  }

  async storageBytes(mapping) {
    assertSafeMapping(mapping);
    try {
      const r = await this._pool(mapping.database_name).query("SELECT pg_total_relation_size(quote_ident($1)::regclass)::bigint AS n", [mapping.physical_name]);
      const rawBytes = r.rows[0] && r.rows[0].n;
      if (rawBytes === null || rawBytes === undefined) throw new Error("PostgreSQL did not return a relation size.");
      const bytes = Number(rawBytes);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("PostgreSQL did not return a valid relation size.");
      return bytes;
    } catch (e) {
      throw internalStoreError("postgres storage measurement", e);
    }
  }

  async dropStorage(mapping) {
    assertSafeMapping(mapping);
    try {
      await this._pool(mapping.database_name).query(`DROP TABLE IF EXISTS ${q(mapping.physical_name)}`);
    } catch (e) {
      throw internalStoreError("postgres dropStorage", e);
    }
  }

  async dropProjectStorage(projectId, mappings) {
    const dbs = new Set(mappings.map((m) => m.database_name).filter(Boolean));
    for (const db of dbs) {
      if (db !== `maestro_${projectId}`) continue; // never drop anything but this project's own database
      const pool = this.pools.get(db);
      if (pool) { await pool.end().catch(() => {}); this.pools.delete(db); }
      const admin = new Client(this._cfg());
      await admin.connect();
      try { await admin.query(`DROP DATABASE IF EXISTS ${q(db)} WITH (FORCE)`); } finally { await admin.end().catch(() => {}); }
    }
  }
}

PostgresAdapter.newId = () => crypto.randomUUID();
module.exports = { PostgresAdapter };
