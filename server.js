const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const dotenv = require("dotenv");

const {
  createDatabase,
  importFile,
  importPartitions,
  getMetadata,
  buildMetadataSummary,
  buildMetadataTable,
  parseCsv,
  parseJson,
  ImportValidationError,
} = require("./database-service");

const { getRoutingRecommendation } = require("./routing-engine");
const { profileFile, profileDataset, ProfilingValidationError } = require("./data-profiler");
const { analyzeStore } = require("./store-analysis-engine");
const { planPartition, toPreviewPlan } = require("./partitioner");
const { executeQuery, QueryValidationError } = require("./query-engine");
const { executeFederatedQuery, FederationValidationError } = require("./federation-engine");
const { redactSensitive } = require("./redact");
const { createDbaas } = require("./dbaas");
const { assertStartupConfig, ensureOperatorToken, securityHeaders, cors, requestContext, requireJsonBody, createOperatorAuth } = require("./dbaas/security");
const { createOpsRouter } = require("./dbaas/ops");
const { getConfig } = require("./dbaas/config");
const { logger } = require("./dbaas/logger");
const { metrics } = require("./dbaas/metrics");
const registry = require("./dbaas/route-registry");
const queryCache = require("./query-cache");

// ============================================================
// ENV
// ============================================================
// Only load real .env here. Loading .env.example as well would
// pull placeholder values (fake API keys, example connection
// strings) into process.env whenever a real .env value is
// missing — which makes /connections/status lie about what's
// actually configured, and can cause /routing/recommend to
// attempt an Ollama call with a placeholder key instead of
// cleanly falling back to rule-based recommendations.
dotenv.config({
  path: path.join(__dirname, ".env"),
});

// Fail closed: a production process with unsafe auth/secret configuration
// must not start. (Development only warns; see dbaas/security.js.)
if (process.env.NODE_ENV === "production") assertStartupConfig();

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const operatorAuth = createOperatorAuth();
let shuttingDown = false;

app.disable("x-powered-by");
// Behind a reverse proxy, set MAESTRO_TRUST_PROXY=1 (number of proxy hops) so
// req.ip, rate limiting and HTTPS detection use the real client address.
if (process.env.MAESTRO_TRUST_PROXY) {
  const hops = Number(process.env.MAESTRO_TRUST_PROXY);
  app.set("trust proxy", Number.isInteger(hops) && hops > 0 ? hops : process.env.MAESTRO_TRUST_PROXY === "true" ? 1 : false);
}

// Every legacy (internal-tool) route is OPERATOR-only: it acts on the global
// metadata store and arbitrary database names, so it is never tenant-scoped.
function legacy(method, routePath, ...handlers) {
  registry.register({ method: method.toUpperCase(), path: routePath, access: "operator", scope: null, variant: "legacy" });
  app[method](routePath, operatorAuth, ...handlers);
}

app.use(requestContext());
app.use(securityHeaders);
app.use(cors);

const UPLOAD_DIR = process.env.MAESTRO_UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    if (name.endsWith(".csv") || name.endsWith(".json")) {
      return cb(null, true);
    }
    cb(new Error("Only CSV or JSON files are accepted."));
  },
});

// DBaaS API bodies are small JSON documents: enforce a real 2 MB cap with a
// streaming limit (not just the Content-Length header, which chunked requests
// omit) and require application/json. The global 25 MB parser below only
// serves the legacy internal routes.
app.use("/v1", requireJsonBody, express.json({ limit: "2mb" }));

app.use(express.urlencoded({ extended: true, limit: "10mb" })); // unchanged
app.use(express.json({ limit: "25mb" }));

app.use("/static", express.static(path.join(__dirname, "public")));

// ============================================================
// HELPERS
// ============================================================

// Removes an uploaded temp file, swallowing (but logging) any
// error so cleanup never masks the real response.
function cleanupUpload(filePath) {
  if (!filePath) return;

  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error(`Failed to remove upload "${filePath}":`, err);
    }
  });
}

// Sends a safe error response: full detail is always logged
// server-side, but the client only gets the raw message in
// non-production so this doesn't leak internals once deployed.
function sendError(res, status, error, fallbackMessage) {
  console.error(fallbackMessage, error);

  res.status(status).json({
    success: false,
    message: isProduction
      ? fallbackMessage
      : `${fallbackMessage}: ${redactSensitive(error.message)}`,
  });
}

// Very small in-memory fixed-window limiter, keyed by IP, so a
// single caller can't hammer the Ollama-backed route and burn
// resources. Not distributed — fine for a single-instance app;
// swap for a real store (Redis) if this ever runs multi-instance.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { windowStart: now, count: 1 });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again shortly.",
      });
    }

    next();
  };
}

const routingLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
});

// ============================================================
// HOME
// ============================================================

registry.register({ method: "GET", path: "/", access: "public", scope: null, variant: "ui" });
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});
registry.register({ method: "GET", path: "/client", access: "public", scope: null, variant: "ui" });
app.get("/client", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "views", "client.html"));
});
registry.register({ method: "GET", path: "/client/billing", access: "public", scope: null, variant: "ui" });
app.get("/client/billing", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "client-billing.html"));
});

// ============================================================
// CREATE DATABASE
// ============================================================

legacy("post", "/database/create", async (req, res) => {
  try {
    const { dbType, dbName, collectionName } = req.body;

    if (!dbType || !dbName) {
      return res.status(400).json({
        success: false,
        message: "Database type and name are required.",
      });
    }

    const result = await createDatabase({
      dbType,
      dbName,
      collectionName,
    });

    res.json({
      success: true,
      message: "Database request completed.",
      data: result,
    });
  } catch (error) {
    const status = error instanceof ImportValidationError ? 400 : 500;
    sendError(res, status, error, "Error creating database");
  }
});

// ============================================================
// IMPORT DATA
// ============================================================

legacy("post", "/database/import", upload.single("datasetFile"), async (req, res) => {
  try {
    const { dbType, dbName, collectionName } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a JSON or CSV file.",
      });
    }

    const result = await importFile({
      dbType,
      dbName,
      collectionName,
      filePath: req.file.path,
      originalName: req.file.originalname,
    });

    // "Final import response for each database" — for a single-target
    // import this report has exactly one entry, keyed by dbType, in
    // the same shape a partitioned import's report uses.
    const report = {
      [result.dbType]: {
        dbName: result.dbName,
        collectionName: result.collectionName,
        status: result.status,
        insertedCount: result.insertedCount,
        failedCount: result.failedCount,
        rowCount: result.rowCount,
        errors: result.errors,
      },
    };

    res.json({
      success: result.status !== "error",
      message: "Data import completed.",
      data: result,
      report,
    });
  } catch (error) {
    const status = error instanceof ImportValidationError ? 400 : 500;
    sendError(res, status, error, "Error importing data");
  } finally {
    cleanupUpload(req.file && req.file.path);
  }
});

// ============================================================
// DATA PROFILING
// ============================================================

legacy("post", "/profile", upload.single("datasetFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV or JSON file.",
      });
    }

    console.log(`Profiling file: ${req.file.originalname}`);

    const profile = profileFile(req.file.path, req.file.originalname);

    res.json({
      success: true,
      message: "Dataset profiling completed.",
      profile,
    });
  } catch (error) {
    const status = error instanceof ProfilingValidationError ? 400 : 500;
    sendError(res, status, error, "Profiling error");
  } finally {
    cleanupUpload(req.file && req.file.path);
  }
});

// ============================================================
// PARTITIONING HELPERS
// ============================================================
// Shared by /partition/preview and /partition/import: reads an
// uploaded file off disk and returns both its parsed rows and its
// data-profiler profile, since the partitioner needs both (rows to
// project into each partition, the profile to classify columns).
const { parseCsv: profilerParseCsv, parseJson: profilerParseJson, detectFormatFromName } =
  require("./data-profiler");

function loadRowsAndProfile(filePath, originalName) {
  const contents = fs.readFileSync(filePath, "utf8");
  const format = detectFormatFromName(originalName);

  let rows;
  if (format === "json") {
    rows = profilerParseJson(contents);
  } else if (format === "csv" || format === "tsv") {
    rows = profilerParseCsv(contents);
  } else {
    throw new ProfilingValidationError("Only CSV, TSV and JSON files are supported.");
  }

  const profile = profileDataset(rows, originalName, { format });
  return { rows, profile };
}

// ============================================================
// PARTITION PREVIEW
// ============================================================
// Analyzes an uploaded dataset and returns the partition plan
// (whether partitioning is needed, which columns go where, sample
// rows for each target, the record identifier, and the explainable
// rules behind the decision) WITHOUT writing anything anywhere. Use
// /partition/import to actually store the result.
legacy("post", "/partition/preview", upload.single("datasetFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV or JSON file.",
      });
    }

    const { rows, profile } = loadRowsAndProfile(req.file.path, req.file.originalname);
    const plan = planPartition({ rows, originalName: req.file.originalname, profile });

    res.json({
      success: true,
      message: plan.required
        ? "Partitioning is required for this dataset."
        : "Partitioning is not required for this dataset.",
      plan: toPreviewPlan(plan),
    });
  } catch (error) {
    const status = error instanceof ProfilingValidationError ? 400 : 500;
    sendError(res, status, error, "Partition preview error");
  } finally {
    cleanupUpload(req.file && req.file.path);
  }
});

// ============================================================
// PARTITION IMPORT
// ============================================================
// Re-runs the same analysis as /partition/preview and then actually
// writes each partition to its target database (or, when
// partitioning isn't needed, the single best-fit database). This is
// additive: it does not replace or remove the existing single-target
// /database/import route above.
//
// Body fields (multipart/form-data):
//   datasetFile   - required, the CSV/JSON file to partition & import
//   dbName        - required, default database name for every target
//   postgresDb, postgresCollection      - optional per-target overrides
//   mongoDb, mongoCollection            - optional per-target overrides
//   elasticsearchDb, elasticsearchCollection - optional per-target overrides
legacy("post", "/partition/import", upload.single("datasetFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV or JSON file.",
      });
    }

    const { dbName, postgresDb, postgresCollection, mongoDb, mongoCollection, elasticsearchDb, elasticsearchCollection } =
      req.body;

    if (!dbName) {
      return res.status(400).json({
        success: false,
        message: "A default database name (dbName) is required.",
      });
    }

    const { rows, profile } = loadRowsAndProfile(req.file.path, req.file.originalname);
    const plan = planPartition({ rows, originalName: req.file.originalname, profile });

    const targets = {
      postgres: { dbName: postgresDb || dbName, collectionName: postgresCollection },
      mongodb: { dbName: mongoDb || dbName, collectionName: mongoCollection },
      elasticsearch: { dbName: elasticsearchDb || dbName, collectionName: elasticsearchCollection },
    };

    const result = await importPartitions({
      plan,
      targets,
      defaultDbName: dbName,
      originalName: req.file.originalname,
      profile,
    });

    // "Final import response for each database" — one entry per
    // target actually written to, however many databases the dataset
    // was split across.
    const report = {};
    result.partitions.forEach((partition) => {
      report[partition.target] = {
        dbName: partition.dbName,
        collectionName: partition.collectionName,
        status: partition.status,
        insertedCount: partition.insertedCount,
        failedCount: partition.failedCount,
        rowCount: partition.rowCount,
        errors: partition.errors,
      };
    });

    res.json({
      success: result.status !== "error",
      message: plan.required
        ? `Dataset split across ${result.partitions.length} partition(s) and imported.`
        : "Dataset stored in a single database (no partitioning was required).",
      plan: toPreviewPlan(plan),
      result,
      report,
    });
  } catch (error) {
    const status = error instanceof ProfilingValidationError || error instanceof ImportValidationError ? 400 : 500;
    sendError(res, status, error, "Partition import error");
  } finally {
    cleanupUpload(req.file && req.file.path);
  }
});

// ============================================================
// METADATA RELATION & HYBRID STORE ANALYSIS
// ============================================================
// Additive feature: profiles the upload (reusing loadRowsAndProfile
// above, the same helper /partition/preview uses), then runs
// metadata + relationship analysis, rule-based store scoring,
// optional Ollama store scoring, and a weighted hybrid decision. See
// store-analysis-engine.js for the full pipeline. Does not touch or
// replace the existing /routing/recommend endpoint or its
// rules/Ollama logic — this is a second, independent analysis built
// from the same underlying profiler/routing building blocks.
legacy("post", "/analysis/store", upload.single("datasetFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV or JSON file.",
      });
    }

    const { rows, profile } = loadRowsAndProfile(req.file.path, req.file.originalname);
    const analysis = await analyzeStore({ rows, originalName: req.file.originalname, profile });

    res.json({
      success: true,
      dataset: req.file.originalname,
      metadata: analysis.metadata,
      relationships: analysis.relationships,
      ruleBased: analysis.ruleBased,
      ollama: analysis.ollama,
      hybrid: analysis.hybrid,
      warnings: analysis.warnings,
    });
  } catch (error) {
    const status = error instanceof ProfilingValidationError ? 400 : 500;
    sendError(res, status, error, "Store analysis error");
  } finally {
    cleanupUpload(req.file && req.file.path);
  }
});

// ============================================================
// METADATA
// ============================================================

legacy("get", "/metadata", async (req, res) => {
  try {
    const metadata = await getMetadata();
    res.json(metadata);
  } catch (error) {
    sendError(res, 500, error, "Error fetching metadata");
  }
});

// ============================================================
// METADATA SUMMARY
// ============================================================

legacy("get", "/metadata/summary", async (req, res) => {
  try {
    const metadata = await getMetadata();
    res.json(buildMetadataSummary(metadata));
  } catch (error) {
    sendError(res, 500, error, "Error building metadata summary");
  }
});

// ============================================================
// METADATA TABLE
// ============================================================

legacy("get", "/metadata/table", async (req, res) => {
  try {
    const metadata = await getMetadata();
    res.json(buildMetadataTable(metadata));
  } catch (error) {
    sendError(res, 500, error, "Error building metadata table");
  }
});

// ============================================================
// DBaaS PLATFORM (projects, API keys, collections, /v1/data, ...)
// ============================================================
// Added alongside the original routes; see dbaas/ and DBaaS.md.
// Mounted BEFORE the legacy POST /v1/query below: that route is
// shared — requests with "Authorization: Bearer pk_..." are handled
// as project-scoped by the platform router, everything else falls
// through (next("router")) to the original query engine unchanged.
// Nothing here opens a database connection until the first /v1
// platform request.
const dbaas = createDbaas({ operatorAuth });
app.use(createOpsRouter({ platform: dbaas.platform, isShuttingDown: () => shuttingDown, operatorAuth }));
app.use(dbaas.router);
app.use("/v1", dbaas.errorHandler);
app.dbaas = dbaas;
metrics.gauge("maestro_pg_pool", () => dbaas.platform.poolStats());
metrics.gauge("maestro_cache_stats", () => dbaas.platform.cache.stats);
metrics.gauge("maestro_circuit_breaker_open", () => Object.fromEntries(Object.entries(dbaas.platform.adapters).map(([k, a]) => [k, a.breaker && a.breaker.state === "open" ? 1 : 0])));

// ============================================================
// UNIFIED QUERY ENGINE
// ============================================================
// Accepts a dataset name, a query type (select/search/count),
// conditions, and an optional target database override. Resolves
// which database the dataset lives in from import/partition
// metadata (the routing engine's earlier decision), then runs a
// safe, parameterized query against exactly that one database.
// Cross-database joins are not implemented: a dataset partitioned
// across more than one database requires an explicit
// "targetDatabase" to pick one. See API_QUERY.md for the full
// request/response schema and example curl commands.
legacy("post", "/v1/query", async (req, res) => {
  try {
    const result = await executeQuery(req.body || {});
    res.json({
      success: result.status === "success",
      ...result,
    });
  } catch (error) {
    const status = error instanceof QueryValidationError ? 400 : 500;
    sendError(res, status, error, "Query error");
  }
});

// ============================================================
// CROSS-DATABASE QUERY FEDERATION (PROTOTYPE)
// ============================================================
// Joins exactly two datasets — each may live in postgres, mongodb,
// or elasticsearch — by fetching each independently (capped rows,
// overall timeout) and joining them in the application layer.
// Explicitly a safe prototype, not production-grade federation: see
// the header of federation-engine.js and API_FEDERATION.md for what
// it does and doesn't guarantee.
legacy("post", "/v1/query/federated", async (req, res) => {
  try {
    const result = await executeFederatedQuery(req.body || {});
    res.json({
      success: result.status === "success",
      ...result,
    });
  } catch (error) {
    const status = error instanceof FederationValidationError || error instanceof QueryValidationError ? 400 : 500;
    sendError(res, status, error, "Federated query error");
  }
});

// ============================================================
// DATABASE ROUTING RECOMMENDATION
// ============================================================

legacy("post", "/routing/recommend", routingLimiter, async (req, res) => {
  try {
    const { rows, originalName, content } = req.body;

    let parsedRows = [];

    // --------------------------------------------------------
    // Parse uploaded content
    // --------------------------------------------------------

    if (content) {
      const lowerName = (originalName || "").toLowerCase();

      if (lowerName.endsWith(".json")) {
        parsedRows = parseJson(content);
      } else if (lowerName.endsWith(".csv")) {
        parsedRows = parseCsv(content);
      } else {
        return res.status(400).json({
          success: false,
          message:
            "Unrecognized file type — only .json and .csv content are supported.",
        });
      }
    } else if (rows) {
      parsedRows = Array.isArray(rows) ? rows : [rows];
    }

    const metadata = await getMetadata();

    // --------------------------------------------------------
    // Hybrid recommendation: deterministic rules first, local
    // Ollama second, safe fallback if Ollama is unavailable or
    // returns something unusable. See routing-engine.js for the
    // full pipeline and the safety checks that stop an unsafe
    // Ollama answer (e.g. Postgres for log/search/nested data)
    // from being trusted.
    // --------------------------------------------------------

    const recommendation = await getRoutingRecommendation({
      rows: parsedRows,
      originalName,
      metadata: {
        totalImports: metadata.imports?.length || 0,
      },
    });

    res.json(recommendation);
  } catch (error) {
    sendError(res, 500, error, "Error generating routing recommendation");
  }
});

// ============================================================
// CONNECTION STATUS
// ============================================================

legacy("get", "/connections/status", (req, res) => {
  res.json({
    postgres: {
      label: "PostgreSQL",
      status: process.env.PG_HOST || process.env.PG_USER ? "ready" : "pending",
      detail: process.env.PG_HOST
        ? "configured"
        : "set PG_HOST/PG_USER to enable",
    },
    mongodb: {
      label: "MongoDB",
      status: process.env.MONGO_URI ? "ready" : "pending",
      detail: process.env.MONGO_URI ? "configured" : "set MONGO_URI to enable",
    },
    elasticsearch: {
      label: "Elasticsearch",
      status: process.env.ELASTICSEARCH_URL ? "ready" : "pending",
      detail: process.env.ELASTICSEARCH_URL
        ? "configured"
        : "set ELASTICSEARCH_URL to enable",
    },
    redis: {
      label: "Redis",
      status: process.env.REDIS_URL ? "ready" : "pending",
      detail: process.env.REDIS_URL ? "configured" : "set REDIS_URL to enable",
    },
  });
});

// ============================================================
// MULTER / UPLOAD ERROR HANDLING
// ============================================================
// Must come after the routes so multer errors thrown inside
// upload.single(...) (bad file type, file too large) are caught
// here instead of crashing the request with a raw stack trace.
// Unknown routes get a JSON 404 (no framework HTML, no stack traces).
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found.", error: { code: "not_found", message: "Not found.", requestId: req.id } });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /Only CSV or JSON/.test((err && err.message) || "")) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      success: false,
      message:
        err.code === "LIMIT_FILE_SIZE"
          ? `File too large. Max size is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
          : err.message,
    });
  }
  // DbaasError (auth, rate limits), body-parser errors and anything else:
  // one consistent, non-leaking error shape.
  return dbaas.errorHandler(err, req, res, next);
});

// ============================================================
// START SERVER + GRACEFUL SHUTDOWN
// ============================================================

const port = process.env.PORT || 3000;

async function shutdown(server, signal) {
  if (shuttingDown) return;
  shuttingDown = true; // /ready flips to 503 so the load balancer stops routing here
  logger.info("shutting down", { signal });
  const force = setTimeout(() => { logger.error("forced exit after shutdown timeout"); process.exit(1); }, getConfig().shutdownTimeoutMs);
  force.unref();
  server.close(async () => {
    try { await dbaas.platform.close(); await queryCache.closeClient(); } catch (e) { logger.error("error during shutdown", { error: e.message }); }
    logger.info("shutdown complete");
    process.exit(0);
  });
  if (server.closeIdleConnections) server.closeIdleConnections();
}

// Only bind a real port when this file is run directly (`node server.js` /
// `npm start`), not when it is required as a module (as the tests do via
// supertest).
if (require.main === module) {
  const token = ensureOperatorToken();
  if (token) {
    process.stderr.write("\n[maestro] MAESTRO_ADMIN_TOKEN is unset; a process-scoped development token was generated and will not be logged. Set MAESTRO_ADMIN_TOKEN in .env for dashboard sign-in.\n\n");
  }
  const server = app.listen(port, () => {
    logger.info("MAESTRO listening", { port: Number(port), env: process.env.NODE_ENV || "development" });
    if (!isProduction) process.stdout.write(`MAESTRO UI running at http://localhost:${port}\n`);
  });
  const cfg = getConfig();
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = cfg.requestTimeoutMs + 5000;
  process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
  process.on("SIGINT", () => shutdown(server, "SIGINT"));
}

module.exports = app;
