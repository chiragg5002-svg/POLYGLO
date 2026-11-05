/*
 * LIVE (real PostgreSQL) control-plane tests: migrations, upgrade from the
 * ORIGINAL schema without data loss, idempotent project creation under
 * concurrency, scopes/expiry persistence, constraints, audit trail, imports.
 */
require("dotenv").config();
const { Client } = require("pg");
const { liveTest } = require("../helpers/live");
const { PostgresControlStore } = require("../../dbaas/control-plane/postgres-store");
const { ControlPlane } = require("../../dbaas/control-plane");
const { generateApiKey } = require("../../dbaas/api-keys");

const live = liveTest(["pg"]);
const cfg = { host: process.env.PG_HOST || "localhost", port: Number(process.env.PG_PORT || 5432), user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "" };
const dbs = [];
const adminQuery = async (sql) => { const c = new Client({ ...cfg, database: "postgres" }); await c.connect(); try { return await c.query(sql); } finally { await c.end(); } };
const freshDb = async () => { const n = `maestro_control_t${Date.now()}_${Math.floor(Math.random() * 1e6)}`; await adminQuery(`CREATE DATABASE "${n}"`); dbs.push(n); return n; };
const storeFor = (db) => { process.env.MAESTRO_CONTROL_DB = db; return new PostgresControlStore(); };
afterAll(async () => { for (const d of dbs) await adminQuery(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => {}); });

live("fresh database: all migrations apply, are recorded, and re-running is a no-op", async () => {
  const db = await freshDb(); const s = storeFor(db);
  await s.init();
  expect(await s.getSchemaVersion()).toBe(4);
  const s2 = storeFor(db); await s2.init();
  expect(await s2.getSchemaVersion()).toBe(4);
  const c = new Client({ ...cfg, database: db }); await c.connect();
  const rows = (await c.query("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id);
  await c.end(); expect(rows).toEqual([1, 2, 3, 4]);
  await s.close(); await s2.close();
}, 30000);

live("UPGRADE: a control plane created by the original (v1) schema keeps every project, key and mapping", async () => {
  const db = await freshDb();
  const c = new Client({ ...cfg, database: db }); await c.connect();
  // the exact original DDL (pre scopes/expiry/quotas/audit)
  await c.query(`CREATE TABLE projects (project_id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE api_keys (key_id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(project_id), key_hash text NOT NULL, key_prefix text NOT NULL, label text, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz);
    CREATE TABLE collections (collection_id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(project_id), name text NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, name));
    CREATE TABLE storage_mappings (project_id text NOT NULL REFERENCES projects(project_id), collection text NOT NULL, db_type text NOT NULL, database_name text, physical_name text NOT NULL, routing_reason text, routing_detail jsonb, schema jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, collection));
    CREATE TABLE usage (project_id text PRIMARY KEY REFERENCES projects(project_id), requests bigint NOT NULL DEFAULT 0, queries bigint NOT NULL DEFAULT 0, inserts bigint NOT NULL DEFAULT 0, updates bigint NOT NULL DEFAULT 0, deletes bigint NOT NULL DEFAULT 0, errors bigint NOT NULL DEFAULT 0, storage_bytes bigint NOT NULL DEFAULT 0, last_activity timestamptz);`);
  const g = generateApiKey();
  await c.query("INSERT INTO projects(project_id,name) VALUES ('proj_aaaaaaaaaaaa','Legacy')");
  await c.query("INSERT INTO api_keys(key_id,project_id,key_hash,key_prefix,label) VALUES ($1,'proj_aaaaaaaaaaaa',$2,$3,'old')", [g.keyId, g.hash, g.prefix]);
  await c.query("INSERT INTO storage_mappings(project_id,collection,db_type,database_name,physical_name) VALUES ('proj_aaaaaaaaaaaa','items','postgresql','maestro_proj_aaaaaaaaaaaa','items')");
  await c.query("INSERT INTO usage(project_id,requests) VALUES ('proj_aaaaaaaaaaaa', 41)");
  await c.end();

  const s = storeFor(db); const cp = new ControlPlane(s);
  await s.init();
  expect(await s.getSchemaVersion()).toBe(4);
  const ctx = await cp.authenticate(`Bearer ${g.key}`);          // the OLD key still authenticates
  expect(ctx.projectId).toBe("proj_aaaaaaaaaaaa");
  expect(ctx.scopes).toEqual(["data:read", "data:write", "collections:manage", "import", "usage:read"]); // full access, as before
  expect((await s.getMapping("proj_aaaaaaaaaaaa", "items")).db_type).toBe("postgresql");
  expect(Number((await s.getUsage("proj_aaaaaaaaaaaa")).requests)).toBe(41);
  expect((await cp.listApiKeys("proj_aaaaaaaaaaaa"))[0]).toMatchObject({ label: "old", status: "active", expiresAt: null });
  await s.close();
}, 30000);

live("client accounts, hashed sessions and project ownership persist", async () => {
  const db = await freshDb();
  const s = storeFor(db); const cp = new ControlPlane(s);
  await s.init();
  const account = await s.createClient({
    clientId: "client_live_test", email: "client-live@example.test",
    passwordHash: "scrypt$test-hash", displayName: "Live client",
  });
  await s.createClientSession({
    sessionId: "sess_live_test", clientId: account.client_id,
    tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const { project } = await cp.createProject("Owned project", { ownerClientId: account.client_id });
  expect((await s.getClientByEmail("client-live@example.test")).password_hash).toBe("scrypt$test-hash");
  expect(await s.getClientSession("a".repeat(64))).toMatchObject({ client_id: account.client_id });
  expect(await cp.listOwnedProjects(account.client_id)).toEqual([project]);
  await s.close();
}, 30000);

live("idempotent project creation: 25 concurrent requests -> exactly one project and one key row", async () => {
  const db = await freshDb(); const s = storeFor(db); const cp = new ControlPlane(s);
  const rs = await Promise.all(Array.from({ length: 25 }, () => cp.createProject("Once", { idempotencyKey: "same-key-12345678" })));
  expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
  expect(rs.filter((r) => r.apiKey)).toHaveLength(1);
  expect(new Set(rs.map((r) => r.project.projectId)).size).toBe(1);
  expect(await cp.listProjects()).toHaveLength(1);
  const c = new Client({ ...cfg, database: db }); await c.connect();
  expect(Number((await c.query("SELECT count(*) FROM api_keys")).rows[0].count)).toBe(1);
  await c.end(); await s.close();
}, 30000);

live("scopes, expiry, rotation and key status persist; CHECK constraints reject bad states", async () => {
  const db = await freshDb(); const s = storeFor(db); const cp = new ControlPlane(s);
  const { project, apiKey } = await cp.createProject("P", { scopes: ["data:read"], expiresInDays: 2 });
  const keys = await cp.listApiKeys(project.projectId);
  expect(keys[0].scopes).toEqual(["data:read"]);
  expect(new Date(keys[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  const rot = await cp.rotateApiKey(project.projectId, apiKey.keyId, { graceSeconds: 60 });
  expect(rot.scopes).toEqual(["data:read"]);
  const after = await cp.listApiKeys(project.projectId);
  expect(after).toHaveLength(2);
  expect(after.find((k) => k.keyId === apiKey.keyId).status).toBe("active"); // still in grace
  const c = new Client({ ...cfg, database: db }); await c.connect();
  await expect(c.query("UPDATE projects SET status='weird'")).rejects.toThrow(/projects_status_chk/);
  await expect(c.query("UPDATE api_keys SET status='weird'")).rejects.toThrow(/api_keys_status_chk/);
  await expect(c.query("INSERT INTO storage_mappings(project_id,collection,db_type,physical_name) VALUES ($1,'x','oracle','x')", [project.projectId])).rejects.toThrow(/storage_mappings_type_chk/);
  await c.end(); await s.close();
}, 30000);

live("audit events and import jobs are stored, ordered, filterable, and contain no secrets", async () => {
  const db = await freshDb(); const s = storeFor(db); const cp = new ControlPlane(s);
  const { project, apiKey } = await cp.createProject("A");
  await cp.audit({ projectId: project.projectId, actor: "operator", action: "key.create", target: apiKey.keyId, requestId: "r1", ip: "1.2.3.4", detail: { scopes: ["data:read"] } });
  await cp.audit({ projectId: null, actor: "operator", action: "project.create", target: "x" });
  const ev = await cp.listAudit({ limit: 10 });
  expect(ev.map((e) => e.action)).toEqual(["project.create", "key.create"]); // newest first
  expect((await cp.listAudit({ projectId: project.projectId })).length).toBe(1);
  expect(JSON.stringify(ev)).not.toContain(apiKey.key);
  await s.recordImportJob({ importId: "imp_1", projectId: project.projectId, collection: "c", status: "partial", dryRun: false, total: 10, inserted: 8, skipped: 0, failed: 2 });
  expect((await s.listImportJobs(project.projectId))[0]).toMatchObject({ import_id: "imp_1", status: "partial", failed: 2 });
  await s.close();
}, 30000);

live("a connection failure surfaces as 503 storage_unavailable, not a raw driver error", async () => {
  const saved = { ...process.env };
  process.env.PG_PORT = "1"; process.env.MAESTRO_CONTROL_DB = "nope";
  const s = new PostgresControlStore();
  const err = await s.getApiKey("abc").catch((e) => e);
  Object.assign(process.env, saved); process.env.PG_PORT = saved.PG_PORT || "5432";
  expect(err.status).toBe(503);
  expect(["storage_unavailable", "service_unavailable"]).toContain(err.code);
  expect(err.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|password/i);
}, 30000);
