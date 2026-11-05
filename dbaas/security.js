/*
 * Cross-cutting HTTP security: startup validation (fail closed in
 * production), security headers, CORS allowlist, request ids, access
 * logging, backpressure, request timeouts, operator authentication and
 * content-type enforcement.
 */
const crypto = require("crypto");
const { getConfig, setEphemeralAdminToken } = require("./config");
const { unauthorized, tooMany, unavailable, DbaasError } = require("./errors");
const { RateLimiter } = require("./rate-limit");
const { logger } = require("./logger");
const { metrics } = require("./metrics");

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const WEAK_PASSWORDS = new Set(["", "postgres", "password", "admin", "root", "changeme", "secret", "maestro"]);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/*
 * Returns { errors: string[], warnings: string[] }. In production any error
 * must stop the process (see assertStartupConfig).
 */
function validateStartupConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const prod = env.NODE_ENV === "production";
  const token = env.MAESTRO_ADMIN_TOKEN || "";
  if (prod) {
    if (token.length < 32) errors.push("MAESTRO_ADMIN_TOKEN must be set to a random value of at least 32 characters.");
    if (WEAK_PASSWORDS.has(token.toLowerCase())) errors.push("MAESTRO_ADMIN_TOKEN is a well-known weak value.");
    if ((env.MAESTRO_KEY_PEPPER || "").length < 32) errors.push("MAESTRO_KEY_PEPPER must be set (>= 32 characters) so a database leak cannot be used to brute-force API-key hashes.");
    if (WEAK_PASSWORDS.has(String(env.PG_PASSWORD || "").toLowerCase())) errors.push("PG_PASSWORD is empty or a well-known weak value.");
    if (env.MAESTRO_INSECURE_DEV === "true") errors.push("MAESTRO_INSECURE_DEV=true is not allowed in production.");
    if (env.MAESTRO_CONTROL_STORE === "memory") errors.push("MAESTRO_CONTROL_STORE=memory is not allowed in production.");
    if ((env.MAESTRO_CORS_ORIGINS || "").split(",").some((o) => o.trim() === "*")) errors.push('MAESTRO_CORS_ORIGINS must not contain "*".');
  } else {
    if (env.MAESTRO_INSECURE_DEV === "true") warnings.push("MAESTRO_INSECURE_DEV=true: operator routes are UNAUTHENTICATED. Development only.");
    if (!token) warnings.push("MAESTRO_ADMIN_TOKEN is not set; an ephemeral operator token will be generated for this process.");
  }
  if ((env.MAESTRO_CORS_ORIGINS || "").split(",").some((o) => o.trim() === "*")) warnings.push('CORS wildcard "*" ignored: only exact origins are allowed.');
  return { errors, warnings };
}

function assertStartupConfig(env = process.env) {
  const { errors, warnings } = validateStartupConfig(env);
  warnings.forEach((w) => logger.warn(w));
  if (errors.length) {
    const err = new Error(`Refusing to start with unsafe configuration:\n - ${errors.join("\n - ")}`);
    err.code = "UNSAFE_CONFIG";
    throw err;
  }
}

// Development convenience that is still secure by default: generate a random
// per-process operator token instead of leaving routes open.
function ensureOperatorToken() {
  const cfg = getConfig();
  if (cfg.adminToken || cfg.isProduction || cfg.insecureDev) return null;
  const token = crypto.randomBytes(24).toString("base64url");
  setEphemeralAdminToken(token);
  return token;
}

function effectiveAdminToken(cfg) { return cfg.adminToken || cfg.ephemeralAdminToken || ""; }

const apiPath = (p) => /^\/(v1|database|import|profile|partition|analysis|metadata|routing|connections|metrics)(\/|$)/.test(p);

function securityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-DNS-Prefetch-Control": "off",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  if (apiPath(req.path)) res.set("Cache-Control", "no-store");
  if (getConfig().isProduction || req.secure || req.get("x-forwarded-proto") === "https") {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

// Exact-match allowlist. No wildcard, never sends Allow-Credentials.
function cors(req, res, next) {
  const origin = req.get("origin");
  if (origin) {
    res.vary("Origin");
    if (getConfig().corsOrigins.filter((o) => o !== "*").includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      if (req.method === "OPTIONS") {
        res.set({
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Request-Id,Idempotency-Key",
          "Access-Control-Max-Age": "600",
        });
        return res.status(204).end();
      }
    } else if (req.method === "OPTIONS") {
      return res.status(403).json({ success: false, message: "Origin not allowed.", error: { code: "cors_denied", message: "Origin not allowed." } });
    }
  }
  next();
}

function routeLabel(req) {
  const route = req.route && req.route.path;
  if (route) return `${req.baseUrl || ""}${route}`;
  return "unmatched";
}

/*
 * Request id + access log + metrics + in-flight accounting. Honours a
 * well-formed inbound X-Request-Id, otherwise generates one.
 */
function requestContext() {
  let inflight = 0;
  metrics.gauge("maestro_http_inflight_requests", () => inflight);
  return (req, res, next) => {
    const inbound = req.get("x-request-id");
    req.id = inbound && REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
    res.set("X-Request-Id", req.id);
    const started = process.hrtime.bigint();
    const cfg = getConfig();

    // Backpressure: shed load instead of queueing without bound. Health
    // probes are exempt so orchestrators can still see the process.
    if (inflight >= cfg.maxInflight && req.path !== "/health" && req.path !== "/ready") {
      metrics.inc("maestro_backpressure_rejections_total");
      res.set("Retry-After", "1");
      return res.status(503).json({ success: false, message: "Server is busy. Retry shortly.", error: { code: "overloaded", message: "Server is busy. Retry shortly." } });
    }
    inflight += 1;

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        metrics.inc("maestro_request_timeouts_total");
        res.status(503).json({ success: false, message: "Request timed out.", error: { code: "request_timeout", message: "Request timed out." } });
      }
    }, cfg.requestTimeoutMs);
    timer.unref();

    res.on("close", () => {
      clearTimeout(timer);
      inflight -= 1;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeLabel(req);
      metrics.inc("maestro_http_requests_total", { method: req.method, route, status: res.statusCode });
      metrics.observe("maestro_http_request_duration_seconds", { route }, seconds);
      if (req.path !== "/health" && req.path !== "/ready" && req.path !== "/metrics") {
        logger.info("request", {
          requestId: req.id, method: req.method, route, status: res.statusCode,
          durationMs: Math.round(seconds * 1000), projectId: req.maestro && req.maestro.projectId, ip: req.ip,
        });
      }
    });
    next();
  };
}

// Only JSON bodies are accepted on the JSON API (multipart routes opt out).
function requireJsonBody(req, res, next) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
  const length = Number(req.get("content-length") || 0);
  const chunked = Boolean(req.get("transfer-encoding"));
  if (!length && !chunked) return next();
  if (req.is("application/json")) return next();
  if (req.is("multipart/form-data") && `${req.baseUrl}${req.path}` === "/v1/import") return next(); // the only upload route (multer enforces size/type)
  return next(new DbaasError(415, "unsupported_media_type", "Content-Type must be application/json."));
}

/*
 * Operator authentication (control plane + internal legacy tools). Fails
 * closed: with no token configured, access is refused unless the explicit
 * development flag MAESTRO_INSECURE_DEV=true is set outside production.
 */
function createOperatorAuth() {
  const failLimiter = new RateLimiter({ windowMs: 60000, max: getConfig().authFailLimitPerMinute });
  const rateLimiter = new RateLimiter({ windowMs: 60000, max: getConfig().ipRateLimitPerMinute });
  return (req, res, next) => {
    const cfg = getConfig();
    try {
      const token = effectiveAdminToken(cfg);
      if (!token) {
        if (!cfg.isProduction && cfg.insecureDev) return next();
        return next(unavailable("Operator access is not configured. Set MAESTRO_ADMIN_TOKEN."));
      }
      if (failLimiter.blocked(req.ip)) { metrics.inc("maestro_rate_limited_total", { scope: "operator_auth" }); return next(tooMany("Too many failed attempts.", 60)); }
      const header = req.get("authorization") || "";
      const supplied = /^Bearer\s+(\S+)$/i.exec(header)?.[1] || req.get("x-maestro-admin-token") || "";
      if (supplied && crypto.timingSafeEqual(sha(supplied), sha(token))) {
        rateLimiter.check(req.ip);
        req.operator = true;
        return next();
      }
      failLimiter.hit(req.ip);
      metrics.inc("maestro_auth_failures_total", { kind: "operator" });
      return next(unauthorized("Operator credentials required."));
    } catch (e) { return next(e); }
  };
}

module.exports = {
  validateStartupConfig, assertStartupConfig, ensureOperatorToken, securityHeaders, cors, requestContext,
  requireJsonBody, createOperatorAuth, effectiveAdminToken, REQUEST_ID,
};
