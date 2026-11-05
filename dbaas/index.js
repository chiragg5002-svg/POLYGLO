/*
 * Wiring for the DBaaS layer. Everything is lazy: requiring this module
 * (or server.js) never opens a database connection — the control-plane
 * database is created/connected on the first /v1 request.
 */
const { ControlPlane } = require("./control-plane");
const { PostgresControlStore } = require("./control-plane/postgres-store");
const { MemoryControlStore } = require("./control-plane/memory-store");
const { createAdapters } = require("../adapters");
const { ProjectCache } = require("./cache");
const { Platform } = require("./platform");
const { createDbaasRouter, dbaasErrorHandler } = require("./routes");

function createPlatform(overrides = {}) {
  let store = overrides.store;
  if (!store) {
    if (process.env.MAESTRO_CONTROL_STORE === "memory") {
      if (process.env.NODE_ENV === "production") throw new Error("MAESTRO_CONTROL_STORE=memory is not allowed in production.");
      require("./logger").logger.warn("Using the IN-MEMORY control plane — projects and API keys are lost on restart (dev only).");
      store = new MemoryControlStore();
    } else {
      store = new PostgresControlStore();
    }
  }
  const controlPlane = new ControlPlane(store);
  return new Platform({
    controlPlane,
    adapters: overrides.adapters || createAdapters(),
    cache: overrides.cache || new ProjectCache(),
    recommend: overrides.recommend,
    routerOptions: overrides.routerOptions || {},
  });
}

function createDbaas(overrides = {}) {
  const platform = createPlatform(overrides);
  return {
    platform,
    router: createDbaasRouter({ platform, operatorAuth: overrides.operatorAuth, mailer: overrides.mailer }),
    errorHandler: dbaasErrorHandler,
  };
}

module.exports = { createDbaas, createPlatform };
