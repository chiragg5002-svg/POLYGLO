const express = require("express");
const { securityHeaders, cors, requestContext, requireJsonBody } = require("../../dbaas/security");
const { createDbaas } = require("../../dbaas");
const { MemoryControlStore } = require("../../dbaas/control-plane/memory-store");
const { ProjectCache } = require("../../dbaas/cache");
const { PostgresAdapter } = require("../../adapters/postgres-adapter");
const { MongoDbAdapter } = require("../../adapters/mongodb-adapter");
const { ElasticsearchAdapter } = require("../../adapters/elasticsearch-adapter");
const { FakeRedis, FakeMongoClient, FakeEsClient } = require("./_fakes");

/*
 * Builds an app around the real DBaaS router/platform with:
 *  - the in-memory control plane
 *  - a FakePgAdapter (a real PostgresAdapter needs a database; see tests/live)
 *  - the REAL Mongo and Elasticsearch adapters driven by fake drivers
 *  - the REAL ProjectCache over a FakeRedis
 *  - a test-only operator middleware by default; auth suites inject the real one
 */
class FakePgAdapter extends PostgresAdapter {
  constructor() {
    super();
    this.tables = new Map();
    this.dropped = [];
  }
  _t(m) {
    const key = `${m.database_name}/${m.physical_name}`;
    if (!this.tables.has(key)) this.tables.set(key, []);
    return this.tables.get(key);
  }
  async createStorage(m) { this._t(m); }
  async create(m, { id, data }) { if (this._t(m).some((x) => x.id === id)) throw require("../../dbaas/errors").duplicate(); const d = { id, data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this._t(m).push(d); return d; }
  async findOne(m, id) { return this._t(m).find((d) => d.id === id) || null; }
  async update(m, id, data) { const d = this._t(m).find((x) => x.id === id); if (!d) return null; d.data = data; d.updatedAt = new Date().toISOString(); return d; }
  async delete(m, id) { const t = this._t(m); const i = t.findIndex((d) => d.id === id); if (i >= 0) t.splice(i, 1); return i >= 0; }
  _filter(m, spec) {
    return this._t(m).filter((d) => (spec.filters || []).every(({ field, operator, value }) => {
      const v = field.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d.data);
      return { eq: v === value, ne: v !== value, gt: v > value, gte: v >= value, lt: v < value, lte: v <= value, in: Array.isArray(value) && value.includes(v) }[operator];
    }) && (spec.queryType !== "search" || JSON.stringify(d.data).toLowerCase().includes(spec.text.toLowerCase())));
  }
  async find(m, spec) {
    let rows = this._filter(m, spec);
    if (spec.sort) {
      const get = (d) => spec.sort.field.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d.data);
      const dir = spec.sort.direction === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => (get(a) > get(b) ? 1 : get(a) < get(b) ? -1 : 0) * dir);
    }
    const r = rows.slice(spec.offset || 0, (spec.offset || 0) + spec.limit);
    return { results: r, resultCount: r.length };
  }
  async count(m, spec) { return this._filter(m, spec).length; }
  async storageBytes(m) { return JSON.stringify(this._t(m)).length; }
  async dropStorage(m) { this.tables.delete(`${m.database_name}/${m.physical_name}`); }
  async dropProjectStorage(projectId) { this.dropped.push(projectId); for (const k of [...this.tables.keys()]) if (k.startsWith(`maestro_${projectId}/`)) this.tables.delete(k); }
  async close() {}
}

function testOperatorAuth(req, res, next) {
  const authorization = req.get("authorization");
  const supplied = /^Bearer\s+(\S+)$/i.exec(authorization || "")?.[1] ||
    req.get("x-maestro-admin-token") || "";
  // Behavior tests may omit operator auth; explicitly supplied credentials must still be valid.
  if (!authorization && !req.get("x-maestro-admin-token")) return next();
  if (supplied && supplied === process.env.MAESTRO_ADMIN_TOKEN) return next();
  return res.status(401).json({ success: false, message: "Operator credentials required." });
}

function buildTestApp({ recommend, routerOptions, mailer, operatorAuth } = {}) {
  const redis = new FakeRedis();
  const mongoClient = new FakeMongoClient();
  const esClient = new FakeEsClient();
  const adapters = {
    postgresql: new FakePgAdapter(),
    mongodb: new MongoDbAdapter({ clientFactory: () => mongoClient }),
    elasticsearch: new ElasticsearchAdapter({ clientFactory: () => esClient }),
  };
  const cache = new ProjectCache({ getClient: async () => redis, isEnabled: () => true, ttlSeconds: 60 });
  const store = new MemoryControlStore();
  const testMailer = mailer || {
    sent: [],
    async sendOtp(email, otp) { this.sent.push({ email, otp }); },
  };
  const dbaas = createDbaas({
    store, adapters, cache, recommend,
    mailer: testMailer,
    operatorAuth: operatorAuth || testOperatorAuth,
    routerOptions: routerOptions || { useOllama: false },
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext());
  app.use(securityHeaders);
  app.use(cors);
  app.use("/v1", requireJsonBody, express.json({ limit: "2mb" })); // same chain as server.js
  app.use(dbaas.router);
  app.use("/v1", dbaas.errorHandler);
  // legacy stand-in so we can prove POST /v1/query falls through without a pk_ key
  app.post("/v1/query", (req, res) => res.json({ legacy: true }));
  return { app, dbaas, redis, mongoClient, esClient, adapters, cache, store, mailer: testMailer };
}

module.exports = { buildTestApp, FakePgAdapter };
