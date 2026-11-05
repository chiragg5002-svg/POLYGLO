/*
 * Every HTTP route is registered through a registry that records how it
 * is protected. tests/security/route-inventory.test.js walks the real
 * Express app and fails if any route is missing from (or extra in) the
 * registry, and then calls every non-public route WITHOUT credentials to
 * prove it is rejected.
 *
 * access: "public"   - no credentials (health/readiness, UI assets, docs)
 *         "operator" - MAESTRO_ADMIN_TOKEN (control plane + internal tools)
 *         "key"      - project API key (+ optional scope)
 */
const entries = [];

function register(entry) {
  const dup = entries.find((e) => e.method === entry.method && e.path === entry.path);
  if (!dup) entries.push(entry);
  return entry;
}

const list = () => entries.map((e) => ({ ...e }));
module.exports = { register, list };
