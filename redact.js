/*
 * Strips anything shaped like embedded basic-auth credentials
 * (protocol://user:pass@host) or a password/secret/token/api-key
 * assignment out of a string before it's returned in any API
 * response or rendered in the UI.
 *
 * None of the errors this project currently throws are expected to
 * contain either — database drivers generally report connection
 * failures without echoing the credentials used — but requirement
 * "never expose passwords, secrets, or connection details" is a
 * guarantee, not an assumption about what today's error messages
 * happen to look like. Applied at the source (database-service.js,
 * query-engine.js, federation-engine.js) wherever a raw driver error
 * message becomes part of a response, and again in server.js's
 * sendError() as a second, independent layer.
 */
function redactSensitive(text) {
  if (!text) return text;
  return String(text)
    // user:pass@host, with or without a protocol:// prefix (some
    // driver error messages omit the scheme entirely).
    .replace(/(\w+:\/\/)?[^\s/:@'"]+:[^\s/:@'"]+@/g, (match, protocol) => `${protocol || ""}[REDACTED]@`)
    .replace(/((?:password|pwd|passwd|secret|token|api[-_]?key)\s*[:=]\s*)([^\s,;'"]+)/gi, "$1[REDACTED]");
}

module.exports = { redactSensitive };
