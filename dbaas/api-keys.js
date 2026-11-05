/*
 * API keys look like:   pk_<12-hex keyId>_<43-char base64url secret>
 *
 * Only a hash of the full key is stored. The keyId is a public lookup
 * handle (so we don't have to hash-compare against every row); the
 * secret part is 256 bits of CSPRNG output, so a fast keyed hash is
 * appropriate (slow password hashes are for low-entropy secrets).
 * The full key is returned exactly once, at creation.
 */
const crypto = require("crypto");
const { getConfig } = require("./config");

const KEY_FORMAT = /^pk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

function generateApiKey() {
  const keyId = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  const key = `pk_${keyId}_${secret}`;
  return { keyId, key, hash: hashApiKey(key), prefix: `pk_${keyId}_${secret.slice(0, 4)}…` };
}

function hashApiKey(key) {
  const { keyPepper } = getConfig();
  return keyPepper
    ? crypto.createHmac("sha256", keyPepper).update(key).digest("hex")
    : crypto.createHash("sha256").update(key).digest("hex");
}

function parseApiKey(key) {
  const m = KEY_FORMAT.exec(String(key || ""));
  return m ? { keyId: m[1] } : null;
}

function verifyApiKey(key, storedHash) {
  if (typeof storedHash !== "string") return false;
  const a = Buffer.from(hashApiKey(key), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extractBearer(headerValue) {
  if (typeof headerValue !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return m ? m[1] : null;
}

module.exports = { generateApiKey, hashApiKey, parseApiKey, verifyApiKey, extractBearer, KEY_FORMAT };
