/*
 * Operational endpoints: liveness (/health), readiness (/ready), metrics
 * (/metrics, operator-only) and the OpenAPI document.
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const registry = require("./route-registry");
const { metrics } = require("./metrics");
const { createOperatorAuth } = require("./security");

function createOpsRouter({ platform, isShuttingDown = () => false, operatorAuth = createOperatorAuth() }) {
  const router = express.Router();
  const def = (routePath, access, ...handlers) => { registry.register({ method: "GET", path: routePath, access, scope: null, variant: "ops" }); router.get(routePath, ...handlers); };

  // Liveness: the process is up. Never touches dependencies.
  def("/health", "public", (req, res) => res.json({ status: "ok" }));

  // Readiness: can this instance serve traffic? Requires the control plane;
  // Redis/MongoDB/Elasticsearch are reported but only degrade the status.
  def("/ready", "public", async (req, res) => {
    if (isShuttingDown()) return res.status(503).json({ status: "shutting_down", ready: false });
    const h = await platform.health();
    const degraded = Object.values(h.dependencies).some((v) => v !== "ok");
    res.status(h.ready ? 200 : 503).json({ status: h.ready ? (degraded ? "degraded" : "ok") : "unavailable", ready: h.ready, dependencies: h.dependencies, circuitBreakers: h.circuitBreakers });
  });

  def("/metrics", "operator", operatorAuth, (req, res) => {
    res.type("text/plain; version=0.0.4").send(metrics.render());
  });

  def("/v1/openapi.yaml", "public", (req, res) => {
    res.type("application/yaml").send(fs.readFileSync(path.join(__dirname, "..", "openapi.yaml"), "utf8"));
  });
  return router;
}

module.exports = { createOpsRouter };
