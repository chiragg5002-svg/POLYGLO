const { PostgresAdapter } = require("../../adapters/postgres-adapter");
const { MongoDbAdapter } = require("../../adapters/mongodb-adapter");
const { ElasticsearchAdapter } = require("../../adapters/elasticsearch-adapter");
const { FakeMongoClient, FakeEsClient } = require("../dbaas/_fakes");
const { liveDescribe } = require("../helpers/live");
const { runConformance } = require("./conformance");

// Always: real adapter code over fake drivers.
runConformance("MongoDB adapter (fake driver)", { makeAdapter: () => new MongoDbAdapter({ clientFactory: () => new FakeMongoClient() }) });
runConformance("Elasticsearch adapter (fake client)", { makeAdapter: () => new ElasticsearchAdapter({ clientFactory: () => new FakeEsClient() }) });

// Real services: SKIPPED (visibly) when unreachable.
liveDescribe(["pg"])("real PostgreSQL", () => {
  runConformance("PostgreSQL (REAL service)", { makeAdapter: () => new PostgresAdapter(), strictTypes: true });
});
liveDescribe(["mongo"])("real MongoDB", () => {
  // MONGO_COMPAT_ONLY=1 marks a MongoDB-wire-compatible server that is NOT real MongoDB
  // (e.g. FerretDB): it has no wildcard text index, so unscoped search is skipped.
  const compat = process.env.MONGO_COMPAT_ONLY === "1";
  runConformance(compat ? "MongoDB wire-compatible server (FerretDB, NOT real MongoDB)" : "MongoDB (REAL service)", { makeAdapter: () => new MongoDbAdapter(), textSearch: !compat });
});
liveDescribe(["es"])("real Elasticsearch", () => {
  runConformance("Elasticsearch (REAL service)", { makeAdapter: () => new ElasticsearchAdapter(), eventualSearch: true });
});
