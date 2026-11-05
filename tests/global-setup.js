/*
 * Probes real services once, before any suite runs, and exposes the result
 * to every test file via MAESTRO_LIVE_FLAGS. Live suites use
 * tests/helpers/live.js to choose test vs test.skip, so a missing service
 * shows up as SKIPPED in Jest's summary — never as a silent "pass".
 */
require("dotenv").config();
const { isPortOpen, isHttpReachable } = require("./integration/_helpers");

module.exports = async () => {
  // The app only caches when REDIS_URL is set, so "Redis available" must mean exactly that.
  const redisUrl = new URL(process.env.REDIS_URL || "redis://localhost:6379");
  const mongoUrl = new URL(process.env.MONGO_URI || "mongodb://localhost:27017");
  const ollamaHost = process.env.OLLAMA_HOST || "127.0.0.1";
  const [pg, redis, mongo, es, ollama] = await Promise.all([
    isPortOpen(process.env.PG_HOST || "localhost", Number(process.env.PG_PORT || 5432)),
    Boolean(process.env.REDIS_URL) && isPortOpen(redisUrl.hostname, Number(redisUrl.port || 6379)),
    isPortOpen(mongoUrl.hostname, Number(mongoUrl.port || 27017)),
    isHttpReachable(`${process.env.ELASTICSEARCH_URL || "http://localhost:9200"}/_cluster/health`),
    isPortOpen(ollamaHost, Number(process.env.OLLAMA_PORT || 11434)),
  ]);
  const flags = { pg, redis, mongo, es, ollama };
  // Is the "MongoDB" really MongoDB? MongoDB-wire-compatible servers such as FerretDB have no
  // wildcard text index, so tests that need $text are skipped and reports say so.
  let mongoKind = "n/a";
  if (mongo) {
    try {
      const { MongoClient } = require("mongodb");
      const c = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017", { serverSelectionTimeoutMS: 2000 });
      await c.connect();
      const info = await c.db("admin").command({ buildInfo: 1 });
      await c.close();
      const compat = Boolean(info.ferretdb) || /ferret/i.test(JSON.stringify(info));
      mongoKind = compat ? `compat-only (FerretDB ${info.ferretdb && info.ferretdb.version || ""})`.trim() : `MongoDB ${info.version}`;
      if (compat) process.env.MONGO_COMPAT_ONLY = "1";
    } catch (e) { mongoKind = "unknown"; }
  }
  process.env.MAESTRO_MONGO_KIND = mongoKind;
  process.env.MAESTRO_LIVE_FLAGS = JSON.stringify(flags);
  // eslint-disable-next-line no-console
  console.log(`\n[live-services] ${Object.entries(flags).map(([k, v]) => `${k}=${v ? "UP" : "down"}`).join("  ")}  [mongo kind: ${mongoKind}]`);
};
