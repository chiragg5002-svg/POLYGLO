/*
 * PostgreSQL-backed control-plane store. Uses a dedicated database
 * (default `maestro_control`) inside the existing PostgreSQL server —
 * no new database technology. The database and tables are created on
 * first use (CREATE ... IF NOT EXISTS), never dropped or altered
 * destructively.
 */
const crypto = require("crypto");
const { Pool, Client } = require("pg");
const { isTransient, internalStoreError } = require("../../adapters/common");
const { conflict, unavailable } = require("../errors");
const { getConfig } = require("../config");

const USAGE_FIELDS = ["requests", "queries", "inserts", "updates", "deletes", "errors"];

/*
 * Versioned, transactional migrations. Each runs once (recorded in
 * schema_migrations) under an advisory lock, and only ever ADDS objects —
 * nothing is dropped or rewritten, so upgrading an existing control plane
 * keeps all projects, keys and mappings. Manual rollback statements are in
 * DEPLOYMENT.md (they are deliberately not executed automatically).
 */
const DEFAULT_SCOPES_JSON = JSON.stringify(["data:read", "data:write", "collections:manage", "import", "usage:read"]);
const MIGRATIONS = [
  {
    id: 1,
    name: "initial_schema",
    up: [
      `CREATE TABLE IF NOT EXISTS projects (
         project_id text PRIMARY KEY,
         name text NOT NULL,
         status text NOT NULL DEFAULT 'active',
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
         key_id text PRIMARY KEY,
         project_id text NOT NULL REFERENCES projects(project_id),
         key_hash text NOT NULL,
         key_prefix text NOT NULL,
         label text,
         status text NOT NULL DEFAULT 'active',
         created_at timestamptz NOT NULL DEFAULT now(),
         last_used_at timestamptz
       )`,
      `CREATE INDEX IF NOT EXISTS api_keys_project_idx ON api_keys(project_id)`,
      `CREATE TABLE IF NOT EXISTS collections (
         collection_id text PRIMARY KEY,
         project_id text NOT NULL REFERENCES projects(project_id),
         name text NOT NULL,
         status text NOT NULL DEFAULT 'active',
         created_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (project_id, name)
       )`,
      `CREATE TABLE IF NOT EXISTS storage_mappings (
         project_id text NOT NULL REFERENCES projects(project_id),
         collection text NOT NULL,
         db_type text NOT NULL,
         database_name text,
         physical_name text NOT NULL,
         routing_reason text,
         routing_detail jsonb,
         schema jsonb,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, collection)
       )`,
      `CREATE TABLE IF NOT EXISTS usage (
         project_id text PRIMARY KEY REFERENCES projects(project_id),
         requests bigint NOT NULL DEFAULT 0,
         queries bigint NOT NULL DEFAULT 0,
         inserts bigint NOT NULL DEFAULT 0,
         updates bigint NOT NULL DEFAULT 0,
         deletes bigint NOT NULL DEFAULT 0,
         errors bigint NOT NULL DEFAULT 0,
         storage_bytes bigint NOT NULL DEFAULT 0,
         last_activity timestamptz
       )`,
    ],
  },
  {
    id: 2,
    name: "scopes_expiry_quotas_audit_idempotency",
    up: [
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes jsonb NOT NULL DEFAULT '${DEFAULT_SCOPES_JSON}'::jsonb`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from text`,
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS quotas jsonb`,
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS idempotency_hash text`,
      `CREATE UNIQUE INDEX IF NOT EXISTS projects_idempotency_idx ON projects(idempotency_hash) WHERE idempotency_hash IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS api_keys_project_status_idx ON api_keys(project_id, status)`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_status_chk') THEN
           ALTER TABLE projects ADD CONSTRAINT projects_status_chk CHECK (status IN ('active','deleted','suspended'));
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_status_chk') THEN
           ALTER TABLE api_keys ADD CONSTRAINT api_keys_status_chk CHECK (status IN ('active','revoked'));
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_mappings_type_chk') THEN
           ALTER TABLE storage_mappings ADD CONSTRAINT storage_mappings_type_chk CHECK (db_type IN ('postgresql','mongodb','elasticsearch'));
         END IF;
       END $$`,
      `CREATE TABLE IF NOT EXISTS audit_events (
         id bigserial PRIMARY KEY,
         at timestamptz NOT NULL DEFAULT now(),
         project_id text,
         actor text NOT NULL,
         action text NOT NULL,
         target text,
         request_id text,
         ip text,
         detail jsonb
       )`,
      `CREATE INDEX IF NOT EXISTS audit_events_project_idx ON audit_events(project_id, id DESC)`,
    ],
  },
  {
    id: 3,
    name: "import_jobs",
    up: [
      `CREATE TABLE IF NOT EXISTS import_jobs (
         import_id text PRIMARY KEY,
         project_id text NOT NULL REFERENCES projects(project_id),
         collection text NOT NULL,
         status text NOT NULL,
         dry_run boolean NOT NULL DEFAULT false,
         total integer NOT NULL DEFAULT 0,
         inserted integer NOT NULL DEFAULT 0,
         skipped integer NOT NULL DEFAULT 0,
         failed integer NOT NULL DEFAULT 0,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS import_jobs_project_idx ON import_jobs(project_id, created_at DESC)`,
    ],
  },
  {
    id: 4,
    name: "client_accounts_and_project_ownership",
    up: [
      `CREATE TABLE IF NOT EXISTS client_accounts (
         client_id text PRIMARY KEY,
         email text NOT NULL UNIQUE,
         password_hash text NOT NULL,
         display_name text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS client_sessions (
         session_id text PRIMARY KEY,
         client_id text NOT NULL REFERENCES client_accounts(client_id) ON DELETE CASCADE,
         token_hash text NOT NULL UNIQUE,
         expires_at timestamptz NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS client_sessions_expiry_idx ON client_sessions(expires_at)`,
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_client_id text REFERENCES client_accounts(client_id)`,
      `CREATE INDEX IF NOT EXISTS projects_owner_client_idx ON projects(owner_client_id, created_at)`,
    ],
  },
  {
    id: 5,
    name: "client_email_otp_challenges",
    up: [
      `CREATE TABLE IF NOT EXISTS client_otp_challenges (
         challenge_hash text PRIMARY KEY,
         client_id text NOT NULL REFERENCES client_accounts(client_id) ON DELETE CASCADE,
         otp_hash text NOT NULL,
         attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
         expires_at timestamptz NOT NULL,
         resend_after timestamptz NOT NULL,
         consumed_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS client_otp_expiry_idx ON client_otp_challenges(expires_at)`,
      `CREATE INDEX IF NOT EXISTS client_otp_client_idx ON client_otp_challenges(client_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS client_auth_rate_limits (
         rate_key text PRIMARY KEY,
         window_started timestamptz NOT NULL,
         hit_count integer NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS client_auth_rate_limits_window_idx ON client_auth_rate_limits(window_started)`,
    ],
  },
  {
    id: 6,
    name: "usage_billing_invoices",
    up: [
      `CREATE TABLE IF NOT EXISTS billing_plans (
         plan_id text PRIMARY KEY,
         name text NOT NULL,
         currency text NOT NULL DEFAULT 'INR' CHECK (currency='INR'),
         storage_paise_per_gb_month bigint NOT NULL CHECK (storage_paise_per_gb_month >= 0),
         requests_per_unit bigint NOT NULL CHECK (requests_per_unit > 0),
         request_unit_paise bigint NOT NULL CHECK (request_unit_paise >= 0),
         transfer_paise_per_gb bigint NOT NULL CHECK (transfer_paise_per_gb >= 0),
         active boolean NOT NULL DEFAULT true,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `INSERT INTO billing_plans(plan_id, name, storage_paise_per_gb_month, requests_per_unit, request_unit_paise, transfer_paise_per_gb)
       VALUES ('demo-inr-v1','Demonstration INR plan',2000,100000,500,1000)
       ON CONFLICT (plan_id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS usage_events (
         event_id text PRIMARY KEY,
         request_id text NOT NULL,
         project_id text NOT NULL REFERENCES projects(project_id),
         category text NOT NULL CHECK (category IN ('api_requests','outbound_bytes')),
         quantity numeric(24,6),
         available boolean NOT NULL DEFAULT true,
         occurred_at timestamptz NOT NULL,
         UNIQUE (request_id, category)
       )`,
      `CREATE INDEX IF NOT EXISTS usage_events_project_time_idx ON usage_events(project_id, occurred_at)`,
      `CREATE TABLE IF NOT EXISTS daily_usage (
         project_id text NOT NULL REFERENCES projects(project_id),
         usage_date date NOT NULL,
         api_requests bigint NOT NULL DEFAULT 0,
         outbound_bytes bigint,
         transfer_available boolean NOT NULL DEFAULT true,
         reconciled_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, usage_date)
       )`,
      `CREATE TABLE IF NOT EXISTS storage_snapshots (
         project_id text NOT NULL REFERENCES projects(project_id),
         snapshot_date date NOT NULL,
         storage_bytes bigint,
         available boolean NOT NULL,
         reason text,
         measured_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, snapshot_date)
       )`,
      `CREATE TABLE IF NOT EXISTS client_billing_profiles (
         client_id text PRIMARY KEY REFERENCES client_accounts(client_id) ON DELETE CASCADE,
         billing_name text,
         billing_address text,
         billing_contact text,
         purchase_order text,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS invoices (
         invoice_id text PRIMARY KEY,
         invoice_number text NOT NULL UNIQUE,
         client_id text NOT NULL REFERENCES client_accounts(client_id),
         period_start date NOT NULL,
         period_end date NOT NULL,
         due_date date,
         status text NOT NULL CHECK (status IN ('draft','reviewed','issued','partially_paid','paid','overdue','void')),
         currency text NOT NULL DEFAULT 'INR' CHECK (currency='INR'),
         subtotal_paise bigint NOT NULL,
         discount_paise bigint NOT NULL DEFAULT 0,
         credit_paise bigint NOT NULL DEFAULT 0,
         adjustment_paise bigint NOT NULL DEFAULT 0,
         tax_paise bigint NOT NULL DEFAULT 0,
         amount_due_paise bigint NOT NULL,
         paid_paise bigint NOT NULL DEFAULT 0,
         demo boolean NOT NULL DEFAULT true,
         plan_snapshot jsonb NOT NULL,
         client_snapshot jsonb NOT NULL,
         issued_snapshot jsonb,
         created_at timestamptz NOT NULL DEFAULT now(),
         issued_at timestamptz,
         UNIQUE (client_id, period_start, period_end),
         CHECK (period_end >= period_start)
       )`,
      `CREATE INDEX IF NOT EXISTS invoices_client_status_idx ON invoices(client_id, status, created_at DESC)`,
      `CREATE SEQUENCE IF NOT EXISTS maestro_invoice_number_seq`,
      `CREATE TABLE IF NOT EXISTS invoice_items (
         invoice_id text NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
         line_number integer NOT NULL,
         description text NOT NULL,
         service text NOT NULL,
         quantity numeric(24,6) NOT NULL,
         unit text NOT NULL,
         unit_price_paise bigint NOT NULL,
         unit_price_label text,
         amount_paise bigint NOT NULL,
         usage_period text NOT NULL,
         usage_snapshot jsonb NOT NULL,
         PRIMARY KEY (invoice_id, line_number)
       )`,
      `CREATE TABLE IF NOT EXISTS invoice_payments (
         payment_id text PRIMARY KEY,
         invoice_id text NOT NULL REFERENCES invoices(invoice_id),
         amount_paise bigint NOT NULL CHECK (amount_paise > 0),
         payment_reference text NOT NULL,
         recorded_by text NOT NULL,
         recorded_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments(invoice_id, recorded_at)`,
      `CREATE TABLE IF NOT EXISTS billing_audit_log (
         audit_id bigserial PRIMARY KEY,
         invoice_id text REFERENCES invoices(invoice_id),
         client_id text REFERENCES client_accounts(client_id),
         actor text NOT NULL,
         action text NOT NULL,
         reason text NOT NULL,
         detail jsonb,
         occurred_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS billing_audit_invoice_idx ON billing_audit_log(invoice_id, audit_id DESC)`,
    ],
  },
  {
    id: 7,
    name: "client_billing_plans_and_subscriptions",
    up: [
      `ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS monthly_fee_paise bigint NOT NULL DEFAULT 0 CHECK (monthly_fee_paise >= 0)`,
      `ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS pricing_configured boolean NOT NULL DEFAULT true`,
      `INSERT INTO billing_plans(plan_id,name,monthly_fee_paise,storage_paise_per_gb_month,requests_per_unit,request_unit_paise,transfer_paise_per_gb,active,pricing_configured)
       VALUES
         ('free','Free',0,0,100000,0,0,true,true),
         ('pro','Pro',0,0,100000,0,0,true,false),
         ('enterprise','Enterprise',0,0,100000,0,0,true,false)
       ON CONFLICT (plan_id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS client_billing_subscriptions (
         subscription_id text PRIMARY KEY,
         client_id text NOT NULL UNIQUE REFERENCES client_accounts(client_id) ON DELETE CASCADE,
         plan_id text NOT NULL REFERENCES billing_plans(plan_id),
         pending_plan_id text REFERENCES billing_plans(plan_id),
         pending_effective_at date,
         status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled')),
         period_start date NOT NULL,
         period_end date NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CHECK (period_end >= period_start)
       )`,
      `ALTER TABLE client_billing_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id text REFERENCES billing_plans(plan_id)`,
      `ALTER TABLE client_billing_subscriptions ADD COLUMN IF NOT EXISTS pending_effective_at date`,
      `INSERT INTO client_billing_subscriptions(subscription_id,client_id,plan_id,status,period_start,period_end)
       SELECT 'sub_' || md5(a.client_id), a.client_id,
         COALESCE((SELECT plan_id FROM billing_plans WHERE active=true AND plan_id='demo-inr-v1'), 'free'),
         'active', date_trunc('month',CURRENT_DATE)::date,
         (date_trunc('month',CURRENT_DATE) + interval '1 month - 1 day')::date
       FROM client_accounts a
       ON CONFLICT (client_id) DO NOTHING`,
      `CREATE INDEX IF NOT EXISTS client_billing_subscriptions_plan_idx ON client_billing_subscriptions(plan_id,status)`,
    ],
  },
];

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const numeric = (row, fields) => { for (const f of fields) if (row[f] !== undefined) row[f] = Number(row[f]); return row; };

class PostgresControlStore {
  constructor({ pgConfig, database } = {}) {
    this._pgConfig = pgConfig;
    this._database = database;
    this.pool = null;
    this._ready = null;
  }

  _cfg() { return this._pgConfig || getConfig().pg(); }
  _db() { return this._database || getConfig().controlDb; }

  async _ensureDatabase() {
    const admin = new Client(this._cfg());
    await admin.connect();
    try {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [this._db()]);
      if (!exists.rowCount) {
        try {
          await admin.query(`CREATE DATABASE "${this._db().replace(/"/g, '""')}"`);
        } catch (e) {
          // 42P04 duplicate_database / 23505 unique_violation: another process won the race.
          if (e.code !== "42P04" && e.code !== "23505") throw e;
        }
      }
    } finally {
      await admin.end().catch(() => {});
    }
  }

  init() {
    if (!this._ready) {
      this._ready = (async () => {
        await this._ensureDatabase();
        this.pool = new Pool({ ...this._cfg(), database: this._db(), max: 5, idleTimeoutMillis: 10000, allowExitOnIdle: true, connectionTimeoutMillis: getConfig().dbTimeoutMs, statement_timeout: getConfig().dbTimeoutMs });
        this.pool.on("error", () => {});
        // Serialise migrations across processes.
        const client = await this.pool.connect();
        try {
          await client.query("SELECT pg_advisory_lock(7461001)");
          await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
          const applied = new Set((await client.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
          for (const m of MIGRATIONS) {
            if (applied.has(m.id)) continue;
            await client.query("BEGIN");
            try {
              for (const sql of m.up) await client.query(sql);
              await client.query("INSERT INTO schema_migrations(id, name) VALUES ($1,$2)", [m.id, m.name]);
              await client.query("COMMIT");
            } catch (e) {
              await client.query("ROLLBACK").catch(() => {});
              throw e;
            }
          }
        } finally {
          await client.query("SELECT pg_advisory_unlock(7461001)").catch(() => {});
          client.release();
        }
      })().catch((e) => {
        this._ready = null;
        if (this.pool) { this.pool.end().catch(() => {}); this.pool = null; }
        console.error("[maestro] control-plane database unavailable:", e.message);
        throw unavailable("The MAESTRO control plane database is unavailable.");
      });
    }
    return this._ready;
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
    this.pool = null;
    this._ready = null;
  }

  // Connection problems become a clean 503 (never a raw driver error / 500).
  async _q(sql, params) {
    try {
      await this.init();
      return await this.pool.query(sql, params);
    } catch (e) {
      if (e && e.status) throw e;
      if (isTransient(e)) { const err = internalStoreError("control plane", e); throw err; }
      throw e;
    }
  }

  _project(r) { if (!r) return r; const { idempotency_hash: _h, ...rest } = r; return { ...rest, created_at: iso(r.created_at) }; }

  async createProject({ projectId, name }) {
    return (await this.createProjectWithKey({ projectId, name })).project;
  }

  /*
   * Creates the project, its usage row and (optionally) its first API key in
   * ONE transaction. With an idempotency hash, a retry returns the existing
   * project (replayed: true) and never creates a second one — enforced by a
   * unique index, so it is safe under concurrent requests.
   */
  async createProjectWithKey({ projectId, name, idempotencyHash = null, key = null, ownerClientId = null }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `INSERT INTO projects(project_id, name, idempotency_hash, owner_client_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (idempotency_hash) WHERE idempotency_hash IS NOT NULL DO NOTHING RETURNING *`,
        [projectId, name, idempotencyHash, ownerClientId]);
      if (!r.rows[0]) {
        await client.query("ROLLBACK");
        // Reuse THIS connection: asking the pool for another one while holding this one
        // deadlocks when many concurrent requests each hold a connection and wait for a second.
        const existing = await client.query("SELECT * FROM projects WHERE idempotency_hash=$1", [idempotencyHash]);
        return { project: this._project(existing.rows[0]), replayed: true };
      }
      await client.query("INSERT INTO usage(project_id) VALUES ($1)", [projectId]);
      let keyRow = null;
      if (key) {
        keyRow = (await client.query(
          `INSERT INTO api_keys(key_id, project_id, key_hash, key_prefix, label, scopes, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
          [key.keyId, projectId, key.hash, key.prefix, key.label || null, JSON.stringify(key.scopes), key.expiresAt || null])).rows[0];
      }
      await client.query("COMMIT");
      return { project: this._project(r.rows[0]), key: this._key(keyRow), replayed: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async getProject(projectId) { return this._project((await this._q("SELECT * FROM projects WHERE project_id=$1", [projectId])).rows[0] || null); }
  async listProjectsForClient(clientId) {
    return (await this._q("SELECT * FROM projects WHERE owner_client_id=$1 AND status <> 'deleted' ORDER BY created_at, project_id", [clientId])).rows.map((r) => this._project(r));
  }
  async listProjects() {
    return (await this._q("SELECT * FROM projects WHERE status <> 'deleted' ORDER BY created_at, project_id")).rows.map((r) => this._project(r));
  }
  async setProjectStatus(projectId, status) {
    return this._project((await this._q("UPDATE projects SET status=$2 WHERE project_id=$1 RETURNING *", [projectId, status])).rows[0] || null);
  }

  _key(r) { return r && { ...r, created_at: iso(r.created_at), last_used_at: iso(r.last_used_at), expires_at: iso(r.expires_at) }; }
  async createApiKey({ keyId, projectId, hash, prefix, label, scopes, expiresAt = null, rotatedFrom = null }) {
    return this._key((await this._q(
      `INSERT INTO api_keys(key_id, project_id, key_hash, key_prefix, label, scopes, expires_at, rotated_from)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [keyId, projectId, hash, prefix, label || null, JSON.stringify(scopes), expiresAt, rotatedFrom])).rows[0]);
  }
  async getApiKey(keyId) { return this._key((await this._q("SELECT * FROM api_keys WHERE key_id=$1", [keyId])).rows[0] || null); }
  async listApiKeys(projectId) {
    return (await this._q(
      "SELECT key_id, project_id, key_prefix, label, status, scopes, expires_at, rotated_from, created_at, last_used_at FROM api_keys WHERE project_id=$1 ORDER BY created_at, key_id", [projectId]))
      .rows.map((r) => this._key(r));
  }
  async revokeApiKey(projectId, keyId) {
    return (await this._q("UPDATE api_keys SET status='revoked' WHERE project_id=$1 AND key_id=$2", [projectId, keyId])).rowCount > 0;
  }
  async setApiKeyExpiry(projectId, keyId, expiresAt) {
    return (await this._q("UPDATE api_keys SET expires_at=$3 WHERE project_id=$1 AND key_id=$2 AND status='active'", [projectId, keyId, expiresAt])).rowCount > 0;
  }
  async revokeAllApiKeys(projectId) { await this._q("UPDATE api_keys SET status='revoked' WHERE project_id=$1", [projectId]); }
  async touchApiKey(keyId) { await this._q("UPDATE api_keys SET last_used_at=now() WHERE key_id=$1", [keyId]); }

  async setQuotas(projectId, quotas) {
    return this._project((await this._q("UPDATE projects SET quotas=$2::jsonb WHERE project_id=$1 RETURNING *", [projectId, JSON.stringify(quotas)])).rows[0] || null);
  }

  async addAuditEvent({ projectId = null, actor, action, target = null, requestId = null, ip = null, detail = null }) {
    await this._q(
      "INSERT INTO audit_events(project_id, actor, action, target, request_id, ip, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [projectId, actor, action, target, requestId, ip, detail ? JSON.stringify(detail) : null]);
  }
  async listAuditEvents({ projectId = null, limit = 100, beforeId = null } = {}) {
    const params = []; const where = [];
    if (projectId) { params.push(projectId); where.push(`project_id=$${params.length}`); }
    if (beforeId) { params.push(beforeId); where.push(`id < $${params.length}`); }
    params.push(limit);
    const r = await this._q(`SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${params.length}`, params);
    return r.rows.map((x) => ({ ...x, id: Number(x.id), at: iso(x.at) }));
  }

  async recordImportJob(job) {
    await this._q(
      `INSERT INTO import_jobs(import_id, project_id, collection, status, dry_run, total, inserted, skipped, failed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [job.importId, job.projectId, job.collection, job.status, Boolean(job.dryRun), job.total, job.inserted, job.skipped, job.failed]);
  }
  async listImportJobs(projectId, limit = 50) {
    return (await this._q("SELECT * FROM import_jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]))
      .rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
  }

  async ping() { await this._q("SELECT 1"); return true; }
  async getSchemaVersion() { return Number((await this._q("SELECT coalesce(max(id),0) AS v FROM schema_migrations")).rows[0].v); }

  async createClient({ clientId, email, passwordHash, displayName }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = (await client.query(
        "INSERT INTO client_accounts(client_id, email, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING client_id, email, password_hash, display_name, created_at",
        [clientId, email, passwordHash, displayName])).rows[0];
      await client.query(
        `INSERT INTO client_billing_subscriptions(subscription_id,client_id,plan_id,status,period_start,period_end)
         SELECT $1,$2,plan_id,'active',date_trunc('month',CURRENT_DATE)::date,
           (date_trunc('month',CURRENT_DATE) + interval '1 month - 1 day')::date
         FROM billing_plans WHERE plan_id='free'`,
        [`sub_${crypto.randomBytes(12).toString("hex")}`, clientId]);
      await client.query("COMMIT");
      return account;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") throw conflict("An account with this email already exists.");
      throw e;
    } finally {
      client.release();
    }
  }
  async getClientByEmail(email) {
    return (await this._q("SELECT client_id, email, password_hash, display_name, created_at FROM client_accounts WHERE email=$1", [email])).rows[0] || null;
  }
  async getClient(clientId) {
    return (await this._q("SELECT client_id, email, display_name, created_at FROM client_accounts WHERE client_id=$1", [clientId])).rows[0] || null;
  }
  async createClientSession({ sessionId, clientId, tokenHash, expiresAt }) {
    return (await this._q(
      "INSERT INTO client_sessions(session_id, client_id, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING session_id, client_id, token_hash, expires_at, created_at",
      [sessionId, clientId, tokenHash, expiresAt])).rows[0];
  }
  async getClientSession(tokenHash) {
    return (await this._q(
      `SELECT s.session_id, s.client_id, s.token_hash, s.expires_at, c.email, c.display_name
       FROM client_sessions s JOIN client_accounts c ON c.client_id=s.client_id
       WHERE s.token_hash=$1 AND s.expires_at > now()`, [tokenHash])).rows[0] || null;
  }
  async deleteClientSession(tokenHash) {
    return (await this._q("DELETE FROM client_sessions WHERE token_hash=$1", [tokenHash])).rowCount > 0;
  }
  async deleteExpiredClientSessions() {
    await this._q("DELETE FROM client_sessions WHERE expires_at <= now()");
  }
  async checkClientAuthRateLimit({ rateKey, max, windowMs }) {
    const row = (await this._q(
      `WITH expired AS (
         DELETE FROM client_auth_rate_limits WHERE window_started < now() - INTERVAL '1 day'
       )
       INSERT INTO client_auth_rate_limits(rate_key,window_started,hit_count) VALUES ($1,now(),1)
       ON CONFLICT (rate_key) DO UPDATE SET
         hit_count=CASE WHEN client_auth_rate_limits.window_started <= now() - ($3::double precision * INTERVAL '1 millisecond')
                        THEN 1 ELSE LEAST(client_auth_rate_limits.hit_count + 1,$2 + 1) END,
         window_started=CASE WHEN client_auth_rate_limits.window_started <= now() - ($3::double precision * INTERVAL '1 millisecond')
                             THEN now() ELSE client_auth_rate_limits.window_started END
       RETURNING window_started,hit_count`,
      [rateKey, max, windowMs])).rows[0];
    const remainingMs = Math.max(1, windowMs - (Date.now() - new Date(row.window_started).getTime()));
    return { allowed: row.hit_count <= max, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }
  async listBillingPlans() {
    return (await this._q("SELECT * FROM billing_plans ORDER BY plan_id")).rows;
  }
  async upsertBillingPlan(plan) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO billing_plans(plan_id, name, monthly_fee_paise, storage_paise_per_gb_month, requests_per_unit, request_unit_paise, transfer_paise_per_gb, active, pricing_configured, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (plan_id) DO UPDATE SET name=EXCLUDED.name,
           monthly_fee_paise=EXCLUDED.monthly_fee_paise,
           storage_paise_per_gb_month=EXCLUDED.storage_paise_per_gb_month,
           requests_per_unit=EXCLUDED.requests_per_unit, request_unit_paise=EXCLUDED.request_unit_paise,
           transfer_paise_per_gb=EXCLUDED.transfer_paise_per_gb, active=EXCLUDED.active,
           pricing_configured=EXCLUDED.pricing_configured, updated_at=now()
         RETURNING *`,
        [plan.planId, plan.name, plan.monthlyFeePaise, plan.storagePaisePerGbMonth,
          plan.requestsPerUnit, plan.requestUnitPaise, plan.transferPaisePerGb,
          plan.active, plan.pricingConfigured]);
      await client.query("COMMIT");
      return result.rows[0];
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async getActiveBillingPlan() {
    return (await this._q("SELECT * FROM billing_plans WHERE active=true ORDER BY plan_id LIMIT 1")).rows[0] || null;
  }
  async getClientSubscription(clientId) {
    await this._q(
      `UPDATE client_billing_subscriptions
       SET plan_id=pending_plan_id,pending_plan_id=NULL,pending_effective_at=NULL,
           period_start=pending_effective_at,
           period_end=(date_trunc('month',pending_effective_at) + interval '1 month - 1 day')::date,
           updated_at=now()
       WHERE client_id=$1 AND pending_effective_at <= CURRENT_DATE`,
      [clientId]);
    const row = (await this._q(
      `SELECT s.subscription_id,s.client_id,s.plan_id,s.pending_plan_id,s.pending_effective_at,
              s.status,s.period_start,s.period_end,s.created_at,s.updated_at,
              p.name,p.currency,p.monthly_fee_paise,p.storage_paise_per_gb_month,p.requests_per_unit,
              p.request_unit_paise,p.transfer_paise_per_gb,p.active,p.pricing_configured
       FROM client_billing_subscriptions s
       JOIN billing_plans p ON p.plan_id=s.plan_id
       WHERE s.client_id=$1`,
      [clientId])).rows[0];
    if (!row) return null;
    const pendingPlan = row.pending_plan_id
      ? (await this._q("SELECT * FROM billing_plans WHERE plan_id=$1", [row.pending_plan_id])).rows[0] || null
      : null;
    return {
      subscription: {
        subscription_id: row.subscription_id, client_id: row.client_id, plan_id: row.plan_id,
        pending_plan_id: row.pending_plan_id || null,
        pending_effective_at: row.pending_effective_at ? String(row.pending_effective_at).slice(0, 10) : null,
        status: row.status, period_start: String(row.period_start).slice(0, 10),
        period_end: String(row.period_end).slice(0, 10), created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      },
      plan: {
        plan_id: row.plan_id, name: row.name, currency: row.currency,
        monthly_fee_paise: String(row.monthly_fee_paise),
        storage_paise_per_gb_month: String(row.storage_paise_per_gb_month),
        requests_per_unit: String(row.requests_per_unit), request_unit_paise: String(row.request_unit_paise),
        transfer_paise_per_gb: String(row.transfer_paise_per_gb),
        active: row.active, pricing_configured: row.pricing_configured,
      },
      pendingPlan,
    };
  }
  async setClientSubscription({ clientId, planId }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const plan = await client.query(
        "SELECT plan_id FROM billing_plans WHERE plan_id=$1 AND active=true AND pricing_configured=true FOR SHARE",
        [planId]);
      if (!plan.rowCount) throw conflict("That billing plan is not available or does not have configured pricing.");
      const current = (await client.query(
        "SELECT plan_id,period_end FROM client_billing_subscriptions WHERE client_id=$1 FOR UPDATE",
        [clientId])).rows[0];
      let row;
      if (current) {
        row = (await client.query(
          `UPDATE client_billing_subscriptions SET
             pending_plan_id=CASE WHEN plan_id=$2 THEN NULL ELSE $2 END,
             pending_effective_at=CASE WHEN plan_id=$2 THEN NULL ELSE period_end + 1 END,
             updated_at=now()
           WHERE client_id=$1 RETURNING *`,
          [clientId, planId])).rows[0];
      } else {
        row = (await client.query(
          `INSERT INTO client_billing_subscriptions(subscription_id,client_id,plan_id,status,period_start,period_end)
           VALUES ($1,$2,$3,'active',date_trunc('month',CURRENT_DATE)::date,
             (date_trunc('month',CURRENT_DATE) + interval '1 month - 1 day')::date)
           RETURNING *`,
          [`sub_${crypto.randomBytes(12).toString("hex")}`, clientId, planId])).rows[0];
      }
      await client.query("COMMIT");
      return row;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async recordUsageEvent(event) {
    await this._q(
      `INSERT INTO usage_events(event_id, request_id, project_id, category, quantity, available, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (request_id, category) DO NOTHING`,
      [event.eventId, event.requestId, event.projectId, event.category, event.quantity, event.available, event.occurredAt]);
  }
  async reconcileDailyUsage({ start, end, projectId = null }) {
    await this._q(
      `WITH grouped AS (
         SELECT project_id, (occurred_at AT TIME ZONE 'UTC')::date AS usage_date,
           COALESCE(SUM(quantity) FILTER (WHERE category='api_requests'),0)::bigint AS api_requests,
           CASE WHEN bool_and(available) FILTER (WHERE category='outbound_bytes') IS FALSE THEN NULL
                ELSE COALESCE(SUM(quantity) FILTER (WHERE category='outbound_bytes'),0)::bigint END AS outbound_bytes,
           COALESCE(bool_and(available) FILTER (WHERE category='outbound_bytes'),true) AS transfer_available
         FROM usage_events
         WHERE occurred_at >= $1::date AND occurred_at < ($2::date + INTERVAL '1 day')
           AND ($3::text IS NULL OR project_id=$3)
         GROUP BY project_id, (occurred_at AT TIME ZONE 'UTC')::date
       )
       INSERT INTO daily_usage(project_id, usage_date, api_requests, outbound_bytes, transfer_available, reconciled_at)
       SELECT project_id, usage_date, api_requests, outbound_bytes, transfer_available, now() FROM grouped
       ON CONFLICT (project_id, usage_date) DO UPDATE SET
         api_requests=EXCLUDED.api_requests, outbound_bytes=EXCLUDED.outbound_bytes,
         transfer_available=EXCLUDED.transfer_available, reconciled_at=now()`,
      [start, end, projectId]);
  }
  async recordStorageSnapshot({ projectId, date, storageBytes, available, reason = null }) {
    await this._q(
      `INSERT INTO storage_snapshots(project_id, snapshot_date, storage_bytes, available, reason)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id, snapshot_date) DO UPDATE SET storage_bytes=EXCLUDED.storage_bytes,
         available=EXCLUDED.available, reason=EXCLUDED.reason, measured_at=now()`,
      [projectId, date, storageBytes, available, reason]);
  }
  async getBillingOverview(clientId, start, end) {
    const projects = (await this._q(
      "SELECT project_id,created_at FROM projects WHERE owner_client_id=$1 AND status <> 'deleted' ORDER BY project_id",
      [clientId])).rows;
    const clientSubscription = await this.getClientSubscription(clientId);
    const plan = clientSubscription ? clientSubscription.plan : await this.getActiveBillingPlan();
    const rows = projects.length ? (await this._q(
      `SELECT p.project_id, days.usage_date::date AS usage_date, COALESCE(d.api_requests,0) AS api_requests,
              CASE WHEN d.transfer_available IS FALSE THEN NULL ELSE COALESCE(d.outbound_bytes,0) END AS outbound_bytes,
              COALESCE(d.transfer_available,true) AS transfer_available,
              s.storage_bytes, COALESCE(s.available,false) AS storage_available, s.reason AS storage_reason
       FROM projects p
       CROSS JOIN generate_series(GREATEST($2::date,(p.created_at AT TIME ZONE 'UTC')::date),$3::date,INTERVAL '1 day') AS days(usage_date)
       LEFT JOIN daily_usage d ON d.project_id=p.project_id AND d.usage_date=days.usage_date::date
       LEFT JOIN storage_snapshots s ON s.project_id=p.project_id AND s.snapshot_date=days.usage_date::date
       WHERE p.owner_client_id=$1 AND p.status <> 'deleted'
       ORDER BY p.project_id, d.usage_date`,
      [clientId, start, end])).rows : [];
    const profile = (await this._q("SELECT * FROM client_billing_profiles WHERE client_id=$1", [clientId])).rows[0] || null;
    return {
      projects: projects.map((p) => ({ project_id: p.project_id, created_at: iso(p.created_at) })),
      daily: rows, plan, profile,
      subscription: clientSubscription ? clientSubscription.subscription : null,
      pendingPlan: clientSubscription ? clientSubscription.pendingPlan : null,
    };
  }
  async saveBillingProfile(clientId, profile) {
    return (await this._q(
      `INSERT INTO client_billing_profiles(client_id,billing_name,billing_address,billing_contact,purchase_order,updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (client_id) DO UPDATE SET billing_name=EXCLUDED.billing_name,
         billing_address=EXCLUDED.billing_address, billing_contact=EXCLUDED.billing_contact,
         purchase_order=EXCLUDED.purchase_order, updated_at=now() RETURNING *`,
      [clientId, profile.billingName, profile.billingAddress, profile.billingContact, profile.purchaseOrder])).rows[0];
  }
  async listClientBillingProfiles() {
    return (await this._q(
      `SELECT a.client_id,a.email,a.display_name,a.created_at,
              b.billing_name,b.billing_address,b.billing_contact,b.purchase_order,b.updated_at,
              count(p.project_id)::integer AS project_count
       FROM client_accounts a
       LEFT JOIN client_billing_profiles b ON b.client_id=a.client_id
       LEFT JOIN projects p ON p.owner_client_id=a.client_id AND p.status <> 'deleted'
       GROUP BY a.client_id,b.client_id ORDER BY a.created_at DESC`)).rows;
  }
  async createDraftInvoice(data) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sequence = (await client.query("SELECT nextval('maestro_invoice_number_seq') AS n")).rows[0].n;
      const invoiceNumber = `MST-${data.periodStart.slice(0, 4)}-${String(sequence).padStart(6, "0")}`;
      const created = await client.query(
        `INSERT INTO invoices(invoice_id,invoice_number,client_id,period_start,period_end,status,currency,
          subtotal_paise,discount_paise,credit_paise,adjustment_paise,tax_paise,amount_due_paise,
          demo,plan_snapshot,client_snapshot)
         VALUES ($1,$2,$3,$4,$5,'draft','INR',$6,0,0,0,0,$6,true,$7::jsonb,$8::jsonb)
         ON CONFLICT (client_id,period_start,period_end) DO NOTHING RETURNING *`,
        [data.invoiceId, invoiceNumber, data.clientId, data.periodStart, data.periodEnd, data.subtotalPaise,
          JSON.stringify(data.planSnapshot), JSON.stringify(data.clientSnapshot)]);
      if (!created.rows[0]) {
        await client.query("ROLLBACK");
        const existing = await this.getInvoiceByPeriod(data.clientId, data.periodStart, data.periodEnd);
        return { ...existing, replayed: true };
      }
      for (const [index, line] of data.items.entries()) {
        await client.query(
          `INSERT INTO invoice_items(invoice_id,line_number,description,service,quantity,unit,unit_price_paise,
            unit_price_label,amount_paise,usage_period,usage_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [data.invoiceId, index + 1, line.description, line.service, line.quantity, line.unit,
            line.unitPricePaise, line.unitPriceLabel || null, line.amountPaise, line.usagePeriod,
            JSON.stringify(line)]);
      }
      await client.query(
        "INSERT INTO billing_audit_log(invoice_id,client_id,actor,action,reason,detail) VALUES ($1,$2,$3,'draft.created',$4,$5::jsonb)",
        [data.invoiceId, data.clientId, data.actor, "Generated from reconciled usage", JSON.stringify({ periodStart: data.periodStart, periodEnd: data.periodEnd })]);
      await client.query("COMMIT");
      return this.getInvoice(data.invoiceId);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async getInvoiceByPeriod(clientId, start, end) {
    const row = (await this._q(
      "SELECT invoice_id FROM invoices WHERE client_id=$1 AND period_start=$2 AND period_end=$3",
      [clientId, start, end])).rows[0];
    return row ? this.getInvoice(row.invoice_id) : null;
  }
  async getInvoice(invoiceId) {
    const invoice = (await this._q("SELECT * FROM invoices WHERE invoice_id=$1", [invoiceId])).rows[0];
    if (!invoice) return null;
    const [items, payments] = await Promise.all([
      this._q("SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_number", [invoiceId]),
      this._q("SELECT * FROM invoice_payments WHERE invoice_id=$1 ORDER BY recorded_at", [invoiceId]),
    ]);
    return { ...invoice, items: items.rows, payments: payments.rows };
  }
  async listInvoicesForClient(clientId) {
    return (await this._q(
      "SELECT invoice_id FROM invoices WHERE client_id=$1 ORDER BY created_at DESC",
      [clientId])).rows.reduce(async (itemsPromise, row) => {
      const items = await itemsPromise;
      items.push(await this.getInvoice(row.invoice_id));
      return items;
    }, Promise.resolve([]));
  }
  async listAllInvoices() {
    return (await this._q("SELECT invoice_id FROM invoices ORDER BY created_at DESC LIMIT 500")).rows.reduce(async (itemsPromise, row) => {
      const items = await itemsPromise;
      items.push(await this.getInvoice(row.invoice_id));
      return items;
    }, Promise.resolve([]));
  }
  async auditBilling({ invoiceId, clientId, actor, action, reason, detail = null }) {
    await this._q(
      "INSERT INTO billing_audit_log(invoice_id,client_id,actor,action,reason,detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [invoiceId, clientId, actor, action, reason, detail === null ? null : JSON.stringify(detail)]);
  }
  async transitionInvoice(invoiceId, status, actor, reason, dueDate = null) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query("SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE", [invoiceId])).rows[0];
      if (!current) { await client.query("ROLLBACK"); return null; }
      if (status === "reviewed" && current.status !== "draft") throw conflict("Only a draft invoice can be marked reviewed.");
      if (status === "issued" && current.status !== "reviewed") throw conflict("Only a reviewed invoice can be issued.");
      if (status === "void" && (["paid", "void"].includes(current.status) || BigInt(current.paid_paise) > 0n)) {
        throw conflict("Invoices with recorded payments or an existing void cannot be voided.");
      }
      let issuedSnapshot = null;
      const issuedAt = new Date().toISOString();
      if (status === "issued") {
        const items = (await client.query("SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_number", [invoiceId])).rows;
        const clientDetails = current.client_snapshot || {};
        issuedSnapshot = {
          invoiceNumber: current.invoice_number,
          clientId: current.client_id,
          clientName: clientDetails.billingName || clientDetails.displayName || "Client",
          clientEmail: clientDetails.email || "",
          purchaseOrder: clientDetails.purchaseOrder || null,
          billingAddress: clientDetails.billingAddress || null,
          periodStart: String(current.period_start).slice(0, 10),
          periodEnd: String(current.period_end).slice(0, 10),
          dueDate,
          status: "issued",
          issuedAt,
          subtotalPaise: String(current.subtotal_paise),
          taxPaise: String(current.tax_paise),
          paidPaise: "0",
          amountDuePaise: String(current.amount_due_paise),
          items: items.map((item) => ({
            description: item.description, service: item.service, quantity: String(item.quantity),
            unit: item.unit, unitPricePaise: String(item.unit_price_paise),
            unitPriceLabel: item.unit_price_label, amountPaise: String(item.amount_paise),
            usagePeriod: item.usage_period,
          })),
        };
      }
      const updated = (await client.query(
        `UPDATE invoices SET status=$2, due_date=CASE WHEN $2='issued' THEN $3 ELSE due_date END,
          issued_at=CASE WHEN $2='issued' THEN $4 ELSE issued_at END,
          issued_snapshot=CASE WHEN $2='issued' THEN $5::jsonb ELSE issued_snapshot END
         WHERE invoice_id=$1 RETURNING *`,
        [invoiceId, status, dueDate, issuedAt, issuedSnapshot ? JSON.stringify(issuedSnapshot) : null])).rows[0];
      await client.query(
        "INSERT INTO billing_audit_log(invoice_id,client_id,actor,action,reason) VALUES ($1,$2,$3,$4,$5)",
        [invoiceId, current.client_id, actor, `invoice.${status}`, reason]);
      await client.query("COMMIT");
      return this.getInvoice(invoiceId);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async recordInvoicePayment({ invoiceId, paymentId, amountPaise, reference, actor }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invoice = (await client.query("SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE", [invoiceId])).rows[0];
      if (!invoice) { await client.query("ROLLBACK"); return null; }
      if (!["issued", "partially_paid", "overdue"].includes(invoice.status)) throw conflict("Payments can only be recorded against an issued invoice.");
      const nextPaid = BigInt(invoice.paid_paise) + BigInt(amountPaise);
      if (nextPaid > BigInt(invoice.amount_due_paise)) throw conflict("Payment exceeds the outstanding invoice balance.");
      const status = nextPaid === BigInt(invoice.amount_due_paise) ? "paid" : "partially_paid";
      await client.query(
        "INSERT INTO invoice_payments(payment_id,invoice_id,amount_paise,payment_reference,recorded_by) VALUES ($1,$2,$3,$4,$5)",
        [paymentId, invoiceId, amountPaise, reference, actor]);
      await client.query("UPDATE invoices SET paid_paise=$2,status=$3 WHERE invoice_id=$1", [invoiceId, nextPaid.toString(), status]);
      await client.query(
        "INSERT INTO billing_audit_log(invoice_id,client_id,actor,action,reason,detail) VALUES ($1,$2,$3,'payment.recorded',$4,$5::jsonb)",
        [invoiceId, invoice.client_id, actor, "Manual payment recorded; no payment was processed", JSON.stringify({ amountPaise, reference })]);
      await client.query("COMMIT");
      return this.getInvoice(invoiceId);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async listInvoicePaymentsForClient(clientId) {
    return (await this._q(
      `SELECT p.*, i.invoice_number, i.client_id FROM invoice_payments p
       JOIN invoices i ON i.invoice_id=p.invoice_id WHERE i.client_id=$1 ORDER BY p.recorded_at DESC`,
      [clientId])).rows;
  }
  async listBillingAudit(limit = 200) {
    return (await this._q("SELECT * FROM billing_audit_log ORDER BY audit_id DESC LIMIT $1", [limit])).rows;
  }
  async createOtpChallenge({ challengeHash, clientId, otpHash, expiresAt, resendAfter }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT client_id FROM client_accounts WHERE client_id=$1 FOR UPDATE", [clientId]);
      await client.query("DELETE FROM client_otp_challenges WHERE expires_at <= now()");
      await client.query(
        "UPDATE client_otp_challenges SET consumed_at=now() WHERE client_id=$1 AND consumed_at IS NULL",
        [clientId]);
      await client.query(
        `INSERT INTO client_otp_challenges(challenge_hash, client_id, otp_hash, expires_at, resend_after)
         VALUES ($1,$2,$3,$4,$5)`,
        [challengeHash, clientId, otpHash, expiresAt, resendAfter]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async invalidateOtpChallenge(challengeHash) {
    await this._q("UPDATE client_otp_challenges SET consumed_at=now() WHERE challenge_hash=$1 AND consumed_at IS NULL", [challengeHash]);
  }
  async getOtpChallengeAccount(challengeHash) {
    return (await this._q(
      `SELECT ch.client_id, a.email
       FROM client_otp_challenges ch JOIN client_accounts a ON a.client_id=ch.client_id
       WHERE ch.challenge_hash=$1 AND ch.consumed_at IS NULL AND ch.expires_at > now()`,
      [challengeHash])).rows[0] || null;
  }
  async resendOtpChallenge({ challengeHash, otpHash, now, expiresAt, resendAfter }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        "SELECT client_id, attempts, expires_at, resend_after, consumed_at FROM client_otp_challenges WHERE challenge_hash=$1 FOR UPDATE",
        [challengeHash]);
      const row = r.rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (new Date(row.resend_after).getTime() > now) {
        await client.query("ROLLBACK");
        return { status: "cooldown", resendAfter: iso(row.resend_after) };
      }
      await client.query(
        "UPDATE client_otp_challenges SET otp_hash=$2, attempts=0, expires_at=$3, resend_after=$4 WHERE challenge_hash=$1",
        [challengeHash, otpHash, expiresAt, resendAfter]);
      await client.query("COMMIT");
      return { status: "sent", clientId: row.client_id };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async verifyOtpChallenge({ challengeHash, otpHash, now, maxAttempts, session }) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `SELECT ch.client_id, ch.otp_hash, ch.attempts, ch.expires_at, ch.consumed_at,
                a.email, a.display_name, a.created_at
         FROM client_otp_challenges ch JOIN client_accounts a ON a.client_id=ch.client_id
         WHERE ch.challenge_hash=$1 FOR UPDATE OF ch`,
        [challengeHash]);
      const row = r.rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (row.attempts >= maxAttempts) {
        await client.query("ROLLBACK");
        return { status: "locked" };
      }
      const crypto = require("crypto");
      const matches = /^[0-9a-f]{64}$/.test(row.otp_hash) && /^[0-9a-f]{64}$/.test(otpHash) &&
        crypto.timingSafeEqual(Buffer.from(row.otp_hash, "hex"), Buffer.from(otpHash, "hex"));
      if (!matches) {
        const attempts = row.attempts + 1;
        await client.query(
          "UPDATE client_otp_challenges SET attempts=$2, consumed_at=CASE WHEN $2 >= $3 THEN now() ELSE consumed_at END WHERE challenge_hash=$1",
          [challengeHash, attempts, maxAttempts]);
        await client.query("COMMIT");
        return { status: attempts >= maxAttempts ? "locked" : "incorrect" };
      }
      await client.query("UPDATE client_otp_challenges SET consumed_at=now() WHERE challenge_hash=$1", [challengeHash]);
      await client.query(
        "INSERT INTO client_sessions(session_id, client_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
        [session.sessionId, row.client_id, session.tokenHash, session.expiresAt]);
      await client.query("COMMIT");
      return {
        status: "verified",
        account: { client_id: row.client_id, email: row.email, display_name: row.display_name, created_at: iso(row.created_at) },
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  _coll(r) { return r && { ...r, created_at: iso(r.created_at) }; }
  _map(r) { return r && { ...r, created_at: iso(r.created_at) }; }

  async createCollectionWithMapping(collection, mapping) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const c = await client.query(
        "INSERT INTO collections(collection_id, project_id, name) VALUES ($1,$2,$3) RETURNING *",
        [collection.collection_id, collection.project_id, collection.name]);
      const m = await client.query(
        `INSERT INTO storage_mappings(project_id, collection, db_type, database_name, physical_name, routing_reason, routing_detail, schema)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [mapping.project_id, mapping.collection, mapping.db_type, mapping.database_name || null, mapping.physical_name,
          mapping.routing_reason || null, mapping.routing_detail ? JSON.stringify(mapping.routing_detail) : null,
          mapping.schema ? JSON.stringify(mapping.schema) : null]);
      await client.query("COMMIT");
      return { collection: this._coll(c.rows[0]), mapping: this._map(m.rows[0]) };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") throw conflict(`Collection "${collection.name}" already exists.`);
      throw e;
    } finally {
      client.release();
    }
  }
  async getCollection(projectId, name) {
    return this._coll((await this._q("SELECT * FROM collections WHERE project_id=$1 AND name=$2", [projectId, name])).rows[0] || null);
  }
  async listCollections(projectId) {
    return (await this._q("SELECT * FROM collections WHERE project_id=$1 AND status <> 'deleted' ORDER BY created_at, name", [projectId])).rows.map((r) => this._coll(r));
  }
  async getMapping(projectId, collection) {
    return this._map((await this._q("SELECT * FROM storage_mappings WHERE project_id=$1 AND collection=$2", [projectId, collection])).rows[0] || null);
  }
  async listMappings(projectId) {
    return (await this._q("SELECT * FROM storage_mappings WHERE project_id=$1 ORDER BY created_at, collection", [projectId])).rows.map((r) => this._map(r));
  }
  async deleteCollection(projectId, name) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM storage_mappings WHERE project_id=$1 AND collection=$2", [projectId, name]);
      const r = await client.query("DELETE FROM collections WHERE project_id=$1 AND name=$2", [projectId, name]);
      await client.query("COMMIT");
      return r.rowCount > 0;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async deleteAllCollections(projectId) {
    await this._q("DELETE FROM storage_mappings WHERE project_id=$1", [projectId]);
    await this._q("DELETE FROM collections WHERE project_id=$1", [projectId]);
  }

  async incrementUsage(projectId, deltas) {
    const vals = USAGE_FIELDS.map((f) => Number(deltas[f] || 0));
    await this._q(
      `INSERT INTO usage(project_id, requests, queries, inserts, updates, deletes, errors, last_activity)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (project_id) DO UPDATE SET
         requests = usage.requests + EXCLUDED.requests, queries = usage.queries + EXCLUDED.queries,
         inserts = usage.inserts + EXCLUDED.inserts, updates = usage.updates + EXCLUDED.updates,
         deletes = usage.deletes + EXCLUDED.deletes, errors = usage.errors + EXCLUDED.errors,
         last_activity = now()`,
      [projectId, ...vals]);
  }
  async setStorageBytes(projectId, bytes) {
    await this._q(
      `INSERT INTO usage(project_id, storage_bytes) VALUES ($1,$2)
       ON CONFLICT (project_id) DO UPDATE SET storage_bytes = EXCLUDED.storage_bytes`, [projectId, Math.max(0, Math.floor(bytes))]);
  }
  async getUsage(projectId) {
    const r = (await this._q("SELECT * FROM usage WHERE project_id=$1", [projectId])).rows[0];
    if (!r) return { project_id: projectId, requests: 0, queries: 0, inserts: 0, updates: 0, deletes: 0, errors: 0, storage_bytes: 0, last_activity: null };
    return numeric({ ...r, last_activity: iso(r.last_activity) }, [...USAGE_FIELDS, "storage_bytes"]);
  }
}

module.exports = { PostgresControlStore };
