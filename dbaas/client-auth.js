const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "maestro_client_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DUMMY_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${Buffer.from("maestro-client-dummy").toString("base64url")}$${crypto.scryptSync("dummy-password", "maestro-client-dummy", SCRYPT_KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }).toString("base64url")}`;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password, encoded = DUMMY_HASH) {
  const parts = String(encoded).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(SCRYPT_N) ||
      parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_BYTES) return false;
  const actual = await scrypt(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionCookie(token, req, maxAge = SESSION_TTL_MS / 1000) {
  const secure = process.env.NODE_ENV === "production" || req.secure || req.get("x-forwarded-proto") === "https";
  return `${SESSION_COOKIE}=${token}; Path=/v1/client; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function readSessionCookie(req) {
  const cookie = req.get("cookie") || "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!entry) return null;
  const token = entry.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function sameOrigin(req) {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.get("origin");
  if (!origin) return true;
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  return origin === `${protocol}://${req.get("host")}`;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  DUMMY_HASH,
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  sessionCookie,
  readSessionCookie,
  sameOrigin,
};
