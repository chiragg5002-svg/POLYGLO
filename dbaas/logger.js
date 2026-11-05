/*
 * Structured JSON logger with request-id support and secret redaction.
 * One JSON object per line on stdout (stderr for errors) so log shippers
 * can parse it. MAESTRO_LOG_LEVEL = debug|info|warn|error|silent.
 */
const { redactSensitive } = require("../redact");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY = /authorization|token|password|passwd|secret|api[-_]?key|cookie|pepper|credential|connection|uri|dsn/i;

function scrub(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactSensitive(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
    return out;
  }
  return value;
}

function threshold() {
  return LEVELS[String(process.env.MAESTRO_LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: scrub(String(msg)), ...scrub(fields || {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
}

const logger = {
  debug: (m, f) => write("debug", m, f),
  info: (m, f) => write("info", m, f),
  warn: (m, f) => write("warn", m, f),
  error: (m, f) => write("error", m, f),
  scrub,
};

module.exports = { logger, scrub };
