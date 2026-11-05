/* Least-privilege API-key scopes. */
const { badRequest } = require("./errors");

const SCOPES = ["data:read", "data:write", "collections:manage", "import", "usage:read"];
const DEFAULT_SCOPES = [...SCOPES]; // keys created without scopes keep full project access (backwards compatible)

function validateScopes(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_SCOPES];
  if (!Array.isArray(raw) || !raw.length) throw badRequest(`"scopes" must be a non-empty array of: ${SCOPES.join(", ")}.`);
  const out = [...new Set(raw)];
  const bad = out.filter((s) => !SCOPES.includes(s));
  if (bad.length) throw badRequest(`Unknown scope(s): ${bad.map((b) => String(b).slice(0, 40)).join(", ")}. Valid scopes: ${SCOPES.join(", ")}.`);
  return out;
}

module.exports = { SCOPES, DEFAULT_SCOPES, validateScopes };
