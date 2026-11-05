const { PostgresAdapter } = require("./postgres-adapter");
const { MongoDbAdapter } = require("./mongodb-adapter");
const { ElasticsearchAdapter } = require("./elasticsearch-adapter");

const { protectAdapter } = require("./common");
const { getConfig } = require("../dbaas/config");

// Registry keyed by the public db_type vocabulary. Every adapter gets the
// circuit breaker + bounded read retries (see common.protectAdapter).
function createAdapters(overrides = {}) {
  const cfg = getConfig();
  const opts = { retries: cfg.backendRetries, threshold: cfg.breakerThreshold, cooldownMs: cfg.breakerCooldownMs };
  return {
    postgresql: protectAdapter(overrides.postgresql || new PostgresAdapter(), opts),
    mongodb: protectAdapter(overrides.mongodb || new MongoDbAdapter(), opts),
    elasticsearch: protectAdapter(overrides.elasticsearch || new ElasticsearchAdapter(), opts),
  };
}

module.exports = { createAdapters, PostgresAdapter, MongoDbAdapter, ElasticsearchAdapter };
