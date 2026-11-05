/*
 * In-memory fakes used by the offline DBaaS unit tests.
 *  - FakeRedis      : get/set/del/scanIterator; DEL with zero keys errors exactly like real Redis
 *  - FakeMongoClient: just enough of the MongoDB driver for MongoDbAdapter
 *  - FakeEsClient   : just enough of the Elasticsearch client for ElasticsearchAdapter
 * They interpret the queries the adapters build, so the adapters' real
 * translation code runs. They are NOT a substitute for the live suites
 * (tests/live) that run against real MongoDB / Elasticsearch.
 */

class FakeRedis {
  constructor() { this.data = new Map(); this.delCalls = []; }
  async get(k) { return this.data.has(k) ? this.data.get(k) : null; }
  async set(k, v, opts = {}) { if (opts.NX && this.data.has(k)) return null; this.data.set(k, v); return "OK"; }
  async incr(k) { const n = Number(this.data.get(k) || 0) + 1; this.data.set(k, String(n)); return n; }
  async expire() { return 1; }
  async ping() { return "PONG"; }
  async del(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    this.delCalls.push(list);
    if (!list.length) throw new Error("ERR wrong number of arguments for 'del' command");
    let n = 0;
    for (const k of list) if (this.data.delete(k)) n += 1;
    return n;
  }
  async *scanIterator({ MATCH }) {
    const re = new RegExp(`^${MATCH.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const keys = [...this.data.keys()].filter((k) => re.test(k));
    if (keys.length) yield keys;
  }
}

// ---------------- Mongo ----------------
const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function mongoMatch(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$and") return cond.every((f) => mongoMatch(doc, f));
    if (key === "$or") return cond.some((f) => mongoMatch(doc, f));
    if (key === "$text") {
      const needle = cond.$search.toLowerCase();
      const strings = [];
      (function walk(v) { if (typeof v === "string") strings.push(v.toLowerCase()); else if (v && typeof v === "object") Object.values(v).forEach(walk); })(doc.data);
      return strings.some((s) => s.includes(needle));
    }
    const val = getPath(doc, key);
    if (cond && typeof cond === "object" && !(cond instanceof RegExp) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, arg]) => {
        const arr = Array.isArray(val) ? val : [val];
        switch (op) {
          case "$ne": return !arr.some((x) => x === arg);
          case "$gt": return val > arg;
          case "$gte": return val >= arg;
          case "$lt": return val < arg;
          case "$lte": return val <= arg;
          case "$in": return arr.some((x) => arg.includes(x));
          case "$regex": return typeof val === "string" && arg.test(val);
          default: throw new Error(`FakeMongo: unsupported operator ${op}`);
        }
      });
    }
    return Array.isArray(val) ? val.includes(cond) : val === cond;
  });
}
class FakeMongoClient {
  constructor() { this.dbs = new Map(); this.closed = false; this.dropped = []; }
  async connect() {}
  async close() { this.closed = true; }
  db(name) {
    if (!this.dbs.has(name)) this.dbs.set(name, new Map());
    const colls = this.dbs.get(name);
    const client = this;
    return {
      command: async () => ({ ok: 1 }),
      createCollection: async (c) => { if (colls.has(c)) { const e = new Error("exists"); e.code = 48; throw e; } colls.set(c, []); },
      dropDatabase: async () => { client.dropped.push(name); client.dbs.delete(name); },
      collection: (cname) => {
        if (!colls.has(cname)) colls.set(cname, []);
        const rows = colls.get(cname);
        return {
          createIndex: async () => "idx",
          insertOne: async (doc) => { if (rows.some((r) => r._id === doc._id)) { const e = new Error("dup"); e.code = 11000; throw e; } rows.push(JSON.parse(JSON.stringify(doc))); },
          findOne: async (f) => rows.find((r) => mongoMatch(r, f)) || null,
          find: (f) => {
            let out = rows.filter((r) => mongoMatch(r, f));
            const cur = {
              sort: (s) => { const [[k, d]] = Object.entries(s); out = [...out].sort((a, b) => (getPath(a, k) > getPath(b, k) ? 1 : getPath(a, k) < getPath(b, k) ? -1 : 0) * d); return cur; },
              skip: (n) => { out = out.slice(n); return cur; },
              limit: (n) => { out = out.slice(0, n); return cur; },
              toArray: async () => out,
            };
            return cur;
          },
          countDocuments: async (f) => rows.filter((r) => mongoMatch(r, f)).length,
          findOneAndUpdate: async (f, u) => { const r = rows.find((x) => mongoMatch(x, f)); if (!r) return null; Object.assign(r, u.$set); return r; },
          deleteOne: async (f) => { const i = rows.findIndex((r) => mongoMatch(r, f)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
          drop: async () => { colls.delete(cname); },
          aggregate: () => ({ toArray: async () => [{ storageStats: {
            size: JSON.stringify(rows).length,
            storageSize: JSON.stringify(rows).length,
            totalIndexSize: rows.length ? 16 : 0,
          } }] }),
        };
      },
    };
  }
}

// ---------------- Elasticsearch ----------------
function esMatch(src, q) {
  if (q.match_all) return true;
  if (q.term) { const [f, v] = Object.entries(q.term)[0]; return esValues(src, f).includes(v); }
  if (q.terms) { const [f, vs] = Object.entries(q.terms)[0]; return esValues(src, f).some((x) => vs.includes(x)); }
  if (q.exists) return esValues(src, q.exists.field).length > 0;
  if (q.wildcard) {
    const [field, matcher] = Object.entries(q.wildcard)[0];
    const pattern = typeof matcher === "string" ? matcher : matcher.value;
    const values = field === "data" ? flattenedValues(src.data) : esValues(src, field);
    return values.some((value) => wildcardMatches(value, pattern, matcher.case_insensitive));
  }
  if (q.range) {
    const [f, ops] = Object.entries(q.range)[0];
    return esValues(src, f).some((x) => Object.entries(ops).every(([o, a]) => ({ gt: x > a, gte: x >= a, lt: x < a, lte: x <= a })[o]));
  }
  if (q.multi_match) {
    const needle = q.multi_match.query.toLowerCase();
    const strings = [];
    (function walk(v) { if (typeof v === "string") strings.push(v.toLowerCase()); else if (v && typeof v === "object") Object.values(v).forEach(walk); })(src.data);
    return strings.some((s) => s.split(/\W+/).includes(needle) || s.includes(needle));
  }
  if (q.bool) {
    const b = q.bool;
    return (b.filter || []).every((c) => esMatch(src, c)) &&
      (b.must || []).every((c) => esMatch(src, c)) &&
      !(b.must_not || []).some((c) => esMatch(src, c)) &&
      (!b.should || !b.should.length || b.should.some((c) => esMatch(src, c)));
  }
  throw new Error(`FakeES: unsupported query ${JSON.stringify(q)}`);
}
function esValues(src, field) {
  const path = field.replace(/\.keyword$/, "");
  const v = getPath(src, path);
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}
function wildcardMatches(value, pattern, caseInsensitive) {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source, caseInsensitive ? "i" : "").test(String(value));
}
function flattenedValues(value) {
  if (Array.isArray(value)) return value.flatMap(flattenedValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenedValues);
  return value === undefined || value === null ? [] : [String(value)];
}
class FakeEsClient {
  constructor() { this.indices_ = new Map(); this.calls = []; this.indices = this._indices(); }
  _idx(name) { const i = this.indices_.get(name); if (!i) { const e = new Error("index_not_found"); e.meta = { statusCode: 404 }; throw e; } return i; }
  _indices() {
    const self = this;
    return {
      create: async ({ index }) => {
        if (self.indices_.has(index)) { const e = new Error("exists"); e.meta = { statusCode: 400, body: { error: { type: "resource_already_exists_exception" } } }; throw e; }
        self.indices_.set(index, new Map());
      },
      delete: async ({ index }) => { self.indices_.delete(index); },
      getMapping: async ({ index }) => ({
        [index]: { mappings: { properties: { data: { type: "flattened" } } } },
      }),
      stats: async ({ index }) => ({ _all: { total: { store: { size_in_bytes: JSON.stringify([...self._idx(index).values()]).length } } } }),
    };
  }
  async ping() { return true; }
  async close() {}
  async index({ index, id, document, op_type }) {
    const docs = this._idx(index);
    if (op_type === "create" && docs.has(id)) { const e = new Error("conflict"); e.meta = { statusCode: 409 }; throw e; }
    docs.set(id, JSON.parse(JSON.stringify(document)));
    return { result: "created" };
  }
  async get({ index, id }) { const d = this._idx(index).get(id); if (!d) { const e = new Error("nf"); e.meta = { statusCode: 404 }; throw e; } return { _source: d }; }
  async update({ index, id, script }) {
    const d = this._idx(index).get(id);
    if (!d) { const e = new Error("nf"); e.meta = { statusCode: 404 }; throw e; }
    this.calls.push({ op: "update", script });
    d.data = script.params.data; d.updatedAt = script.params.updatedAt;
    return { result: "updated" };
  }
  async delete({ index, id }) { const ok = this._idx(index).delete(id); if (!ok) { const e = new Error("nf"); e.meta = { statusCode: 404 }; throw e; } return { result: "deleted" }; }
  async search({ index, query, size, from, sort }) {
    this.calls.push({ op: "search", query, sort });
    let hits = [...this._idx(index).values()].filter((s) => esMatch(s, query));
    const [first] = sort;
    const [k, spec] = Object.entries(first)[0];
    const dir = (typeof spec === "string" ? spec : spec.order) === "desc" ? -1 : 1;
    const key = k.replace(/\.keyword$/, "");
    hits = hits.sort((a, b) => (getPath(a, key) > getPath(b, key) ? 1 : getPath(a, key) < getPath(b, key) ? -1 : 0) * dir);
    return { hits: { hits: hits.slice(from, from + size).map((_source) => ({ _source })) } };
  }
  async count({ index, query }) { return { count: [...this._idx(index).values()].filter((s) => esMatch(s, query)).length }; }
}

module.exports = { FakeRedis, FakeMongoClient, FakeEsClient };
