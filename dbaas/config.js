/*
 * DBaaS configuration — everything comes from environment variables
 * (read lazily so tests can change them) and nothing secret has a
 * hard-coded default except local-development database fallbacks that
 * mirror docker-compose.yml.
 */
const num = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
};

const list = (name) => String(process.env[name] || "").split(",").map((v) => v.trim()).filter(Boolean);

// Ephemeral operator token generated at startup in NON-production when none is
// configured (see security.ensureOperatorToken). Never used in production.
let ephemeralAdminToken = "";
const setEphemeralAdminToken = (t) => { ephemeralAdminToken = t; };

function getConfig() {
  return {
    isProduction: process.env.NODE_ENV === "production",
    // Explicit, development-only escape hatch that lets operator routes run
    // WITHOUT credentials. Off by default; refused at startup in production.
    insecureDev: process.env.MAESTRO_INSECURE_DEV === "true",
    ephemeralAdminToken,
    corsOrigins: list("MAESTRO_CORS_ORIGINS"),
    ipRateLimitPerMinute: num("MAESTRO_IP_RATE_LIMIT_PER_MINUTE", 1200, { min: 1 }),
    authCacheTtlMs: num("MAESTRO_AUTH_CACHE_TTL_MS", 5000, { min: 0 }),
    usageFlushMs: num("MAESTRO_USAGE_FLUSH_MS", 1000, { min: 0 }),
    maxInflight: num("MAESTRO_MAX_INFLIGHT", 200, { min: 1 }),
    requestTimeoutMs: num("MAESTRO_REQUEST_TIMEOUT_MS", 30000, { min: 1000 }),
    shutdownTimeoutMs: num("MAESTRO_SHUTDOWN_TIMEOUT_MS", 15000, { min: 1000 }),
    dbTimeoutMs: num("MAESTRO_DB_TIMEOUT_MS", 10000, { min: 500 }),
    backendRetries: num("MAESTRO_BACKEND_RETRIES", 2, { min: 0, max: 5 }),
    breakerThreshold: num("MAESTRO_BREAKER_THRESHOLD", 5, { min: 1 }),
    breakerCooldownMs: num("MAESTRO_BREAKER_COOLDOWN_MS", 10000, { min: 100 }),
    maxImportBytes: num("MAESTRO_MAX_IMPORT_BYTES", 10 * 1024 * 1024, { min: 1024 }),
    // Default per-project quotas (overridable per project via the admin API).
    quotas: {
      maxCollections: num("MAESTRO_MAX_COLLECTIONS_PER_PROJECT", 50, { min: 1 }),
      maxDocuments: num("MAESTRO_QUOTA_MAX_DOCUMENTS", 1000000, { min: 1 }),
      maxStorageBytes: num("MAESTRO_QUOTA_MAX_STORAGE_BYTES", 1024 * 1024 * 1024, { min: 1024 }),
      maxImportRows: num("MAESTRO_QUOTA_MAX_IMPORT_ROWS", 50000, { min: 1 }),
      requestsPerMinute: num("MAESTRO_QUOTA_REQUESTS_PER_MINUTE", 600, { min: 1 }),
    },
    // Protects the control-plane (/v1/projects*). Required in production.
    adminToken: process.env.MAESTRO_ADMIN_TOKEN || "",
    // Optional HMAC pepper for API-key hashes. If unset, plain SHA-256 is
    // used (API keys are 256-bit random, so this is safe either way).
    keyPepper: process.env.MAESTRO_KEY_PEPPER || "",
    controlDb: process.env.MAESTRO_CONTROL_DB || "maestro_control",
    autoCreateCollections: process.env.MAESTRO_AUTO_CREATE_COLLECTIONS !== "false",
    rateLimitPerMinute: num("MAESTRO_RATE_LIMIT_PER_MINUTE", 600, { min: 1 }),
    authFailLimitPerMinute: num("MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE", 30, { min: 1 }),
    otpAccountRateLimitPerMinute: num("MAESTRO_OTP_ACCOUNT_RATE_LIMIT_PER_MINUTE", 5, { min: 1 }),
    otpPepper: process.env.MAESTRO_OTP_PEPPER || "",
    smtp: () => ({
      host: process.env.SMTP_HOST || "",
      port: num("SMTP_PORT", 587, { min: 1, max: 65535 }),
      secure: process.env.SMTP_SECURE === "true",
      username: process.env.SMTP_USERNAME || "",
      password: process.env.SMTP_PASSWORD || "",
      from: process.env.SMTP_FROM || "",
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false",
    }),
    maxDocumentBytes: num("MAESTRO_MAX_DOCUMENT_BYTES", 256 * 1024, { min: 1024 }),
    maxQueryLimit: num("MAESTRO_MAX_QUERY_LIMIT", 1000, { min: 1 }),
    defaultQueryLimit: num("MAESTRO_DEFAULT_QUERY_LIMIT", 50, { min: 1 }),
    maxCollectionsPerProject: num("MAESTRO_MAX_COLLECTIONS_PER_PROJECT", 50, { min: 1 }),
    cacheTtlSeconds: num("QUERY_CACHE_TTL_SECONDS", 60, { min: 1 }),
    routingTimeoutMs: num("MAESTRO_ROUTING_TIMEOUT_MS", 8000, { min: 100 }),
    routingUseOllama: process.env.MAESTRO_ROUTING_USE_OLLAMA !== "false",
    routingMinConfidence: num("MAESTRO_ROUTING_MIN_CONFIDENCE", 30, { min: 0, max: 100 }),
    pg: () => ({
      host: process.env.PG_HOST || "localhost",
      port: Number(process.env.PG_PORT || 5432),
      user: process.env.PG_USER || "postgres",
      password: process.env.PG_PASSWORD || "",
      database: process.env.PG_DATABASE || "postgres",
    }),
    mongoUri: () => process.env.MONGO_URI || "mongodb://localhost:27017",
    elasticsearchUrl: () => process.env.ELASTICSEARCH_URL || "http://localhost:9200",
  };
}

module.exports = { getConfig, setEphemeralAdminToken };
