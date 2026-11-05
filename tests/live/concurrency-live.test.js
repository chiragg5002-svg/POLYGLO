/*
 * LIVE concurrency + isolation proofs on real PostgreSQL and Redis:
 *  - 40 simultaneous project creations
 *  - two tenants hammering the SAME collection name concurrently
 *    (mixed insert/query/update/delete, cache hits and misses) with
 *    read-your-writes checks and a cross-tenant leakage check
 *  - cache never serves a result older than the last completed write
 */
require("dotenv").config();
process.env.QUERY_CACHE_ENABLED = "true";
process.env.MAESTRO_ROUTING_USE_OLLAMA = "false";
process.env.MAESTRO_ADMIN_TOKEN = "maestro-live-test-operator-token";
process.env.MAESTRO_INSECURE_DEV = "false";
process.env.MAESTRO_RATE_LIMIT_PER_MINUTE = "1000000";
process.env.MAESTRO_QUOTA_REQUESTS_PER_MINUTE = "1000000";
process.env.MAESTRO_IP_RATE_LIMIT_PER_MINUTE = "1000000";
const CONTROL_DB = `maestro_control_conc_${Date.now()}`;
process.env.MAESTRO_CONTROL_DB = CONTROL_DB;

const express = require("express");
const request = require("supertest");
const { Client } = require("pg");
const { liveTest } = require("../helpers/live");
const { createDbaas } = require("../../dbaas");
const { PostgresControlStore } = require("../../dbaas/control-plane/postgres-store");
const queryCache = require("../../query-cache");
const { createOperatorAuth, requestContext, requireJsonBody } = require("../../dbaas/security");

const live = liveTest(["pg", "redis"]);
let dbaas; let app; const created = [];

beforeAll(async () => {
  if (!JSON.parse(process.env.MAESTRO_LIVE_FLAGS || "{}").pg) return;
  dbaas = createDbaas({ store: new PostgresControlStore(), operatorAuth: createOperatorAuth() });
  app = express();
  app.use(requestContext());
  app.use("/v1", requireJsonBody, express.json({ limit: "2mb" }));
  app.use(dbaas.router);
  app.use("/v1", dbaas.errorHandler);
}, 30000);

afterAll(async () => {
  if (!dbaas) return;
  for (const id of created) {
    await request(app).delete(`/v1/projects/${id}?purge=true`)
      .set("Authorization", "Bearer maestro-live-test-operator-token").catch(() => {});
  }
  await dbaas.platform.close();
  await queryCache.closeClient();
  const admin = new Client({ host: process.env.PG_HOST || "localhost", port: Number(process.env.PG_PORT || 5432), user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "", database: "postgres" });
  await admin.connect().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${CONTROL_DB}" WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}, 60000);

const mk = async (name) => {
  const r = await request(app).post("/v1/projects")
    .set("Authorization", "Bearer maestro-live-test-operator-token").send({ name });
  expect(r.status).toBe(201);
  created.push(r.body.projectId);
  return { id: r.body.projectId, auth: { Authorization: `Bearer ${r.body.apiKey}` } };
};

live("40 concurrent project creations all succeed with unique ids and working keys", async () => {
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => request(app).post("/v1/projects")
    .set("Authorization", "Bearer maestro-live-test-operator-token").send({ name: `Conc ${i}` })));
  rs.forEach((r) => created.push(r.body.projectId));
  expect(rs.every((r) => r.status === 201)).toBe(true);
  expect(new Set(rs.map((r) => r.body.projectId)).size).toBe(40);
  const checks = await Promise.all(rs.slice(0, 10).map((r) => request(app).get("/v1/project").set({ Authorization: `Bearer ${r.body.apiKey}` })));
  expect(checks.every((c) => c.status === 200)).toBe(true);
}, 60000);

live("two tenants hammer the same collection name concurrently: no leakage, read-your-writes holds, cache never stale", async () => {
  const T = [await mk("TenantA"), await mk("TenantB")];
  const marker = (i) => `tenant-${i}-only`;
  // seed the collection once per tenant (first-write race handled by the platform)
  await Promise.all(T.map((t, i) => request(app).post("/v1/data").set(t.auth).send({ collection: "orders", data: { owner: marker(i), n: -1 } })));

  const WORKERS = 12; const OPS = 25; const violations = [];
  const worker = async (ti, w) => {
    const t = T[ti]; const mine = [];
    for (let k = 0; k < OPS; k += 1) {
      const roll = (w * 31 + k * 17) % 4;
      if (roll === 0 || mine.length === 0) {
        const r = await request(app).post("/v1/data").set(t.auth).send({ collection: "orders", data: { owner: marker(ti), n: w * 1000 + k, w } });
        if (r.status !== 201) violations.push(`insert ${r.status}`); else mine.push({ id: r.body.id, n: w * 1000 + k });
      } else if (roll === 1) {
        const q = await request(app).post("/v1/query").set(t.auth).send({ collection: "orders", limit: 1000 });
        if (q.status !== 200) violations.push(`query ${q.status}`);
        else for (const d of q.body.results) if (d.data.owner !== marker(ti)) violations.push(`LEAK: tenant ${ti} saw ${d.data.owner}`);
      } else if (roll === 2) {
        // read-your-writes: after my insert completed, a count including my row must never be served stale
        const doc = mine[mine.length - 1];
        const q = await request(app).post("/v1/query").set(t.auth).send({ collection: "orders", filters: { n: doc.n } });
        if (q.body.resultCount !== 1) violations.push(`stale/missing own row n=${doc.n} (count ${q.body.resultCount}, cached ${q.body.cached})`);
      } else {
        const doc = mine.pop();
        const d = await request(app).delete(`/v1/data/orders/${doc.id}`).set(t.auth);
        if (d.status !== 200) violations.push(`delete ${d.status}`);
        const q = await request(app).post("/v1/query").set(t.auth).send({ collection: "orders", filters: { n: doc.n } });
        if (q.body.resultCount !== 0) violations.push(`deleted row still visible n=${doc.n} (cached ${q.body.cached})`);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w % 2, w)));
  expect(violations).toEqual([]);

  // final cross-check straight from the physical stores
  for (let i = 0; i < 2; i += 1) {
    const all = await request(app).post("/v1/query").set(T[i].auth).send({ collection: "orders", limit: 1000 });
    expect(all.body.results.every((d) => d.data.owner === marker(i))).toBe(true);
  }
}, 120000);
