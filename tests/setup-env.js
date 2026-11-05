/*
 * Per-test-file environment (jest `setupFiles`).
 *
 * - Logs are silenced; runtime data/upload dirs point at a throw-away temp
 *   dir so tests never touch data/metadata.json or uploads/.
 * - Real-server integration tests use a non-secret, test-only operator
 *   credential. DBaaS unit apps inject their own scoped operator middleware.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MAESTRO_LOG_LEVEL = process.env.MAESTRO_LOG_LEVEL || "silent";
if (!process.env.MAESTRO_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-test-"));
  process.env.MAESTRO_DATA_DIR = path.join(dir, "data");
  process.env.MAESTRO_UPLOAD_DIR = path.join(dir, "uploads");
  process.env.MAESTRO_IMPORT_TMP = path.join(dir, "imports"); // per test file: parallel suites must not share it
}
process.env.MAESTRO_ADMIN_TOKEN = "maestro-test-only-operator-token";
process.env.MAESTRO_INSECURE_DEV = "false";
