/*
 * Typed errors for the DBaaS layer. Every error that should reach a
 * developer carries an HTTP status and a stable machine-readable
 * `code`; anything else is treated as an internal error and rendered
 * generically (never with stack traces or connection details).
 */
class DbaasError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "DbaasError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (message, details) => new DbaasError(400, "invalid_request", message, details);
const unauthorized = (message = "Missing or invalid API key.") => new DbaasError(401, "unauthorized", message);
const forbidden = (message = "Forbidden.") => new DbaasError(403, "forbidden", message);
const notFound = (message = "Not found.") => new DbaasError(404, "not_found", message);
const conflict = (message) => new DbaasError(409, "conflict", message);
const tooMany = (message = "Too many requests.", retryAfterSeconds = 1) => {
  const e = new DbaasError(429, "rate_limited", message);
  e.retryAfterSeconds = retryAfterSeconds;
  return e;
};
const unavailable = (message) => new DbaasError(503, "service_unavailable", message);
const duplicate = (message = "A document with this id already exists.") => new DbaasError(409, "duplicate_id", message);
const quotaExceeded = (quota, limit, message) => new DbaasError(403, "quota_exceeded", message || `Project quota "${quota}" reached (limit ${limit}).`, { quota, limit });
const payloadTooLarge = (message) => new DbaasError(413, "payload_too_large", message);

module.exports = { DbaasError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, unavailable, duplicate, quotaExceeded, payloadTooLarge };
