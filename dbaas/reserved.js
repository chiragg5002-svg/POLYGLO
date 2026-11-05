/*
 * Physical names owned by the DBaaS layer. The legacy (unauthenticated)
 * import/create routes must never be able to write into these, or the
 * tenant-isolation guarantee could be bypassed through them.
 */
const RESERVED_PHYSICAL_NAME = /^(maestro_proj_|maestro_control|proj_[0-9a-f]{12}(_|$))/i;

function isReservedPhysicalName(name) {
  return RESERVED_PHYSICAL_NAME.test(String(name == null ? "" : name).trim());
}

module.exports = { isReservedPhysicalName, RESERVED_PHYSICAL_NAME };
