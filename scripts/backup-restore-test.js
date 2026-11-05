/* End-to-end proof: data -> backup -> destroy -> restore -> data is back and usable. */
const { execSync } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path");
const { startServer, waitReady, admin, keyed } = require("./_harness");
const PORT = 3700 + Math.floor(Math.random() * 90); const BASE = `http://127.0.0.1:${PORT}`;
const sh = (c, o = {}) => execSync(c, { stdio: "pipe", env: { ...process.env, PGHOST: process.env.PG_HOST || "localhost", PGPORT: process.env.PG_PORT || "5432", PGPASSWORD: process.env.PG_PASSWORD || "postgres", PGUSER: process.env.PG_USER || "postgres" }, ...o }).toString();
const ok = (name, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${name}${d ? " — " + d : ""}`); if (!c) process.exitCode = 1; };
const CONTROL = process.env.MAESTRO_CONTROL_DB || "maestro_control_harness";
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-bk-"));
  let server = startServer(PORT, { MAESTRO_AUTH_CACHE_TTL_MS: "0", MAESTRO_USAGE_FLUSH_MS: "0" });
  await waitReady(BASE);
  const A = admin(BASE);
  const p = (await A("POST", "/v1/projects", { name: "Backup me" })).body;
  const api = keyed(BASE, p.apiKey);
  for (let i = 0; i < 25; i += 1) await api("POST", "/v1/data", { collection: "orders", data: { n: i, label: `order-${i}` } });
  const before = (await api("POST", "/v1/query", { collection: "orders", queryType: "count" })).body.resultCount;
  server.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 800));

  const out = sh(`./scripts/backup.sh ${dir}`).trim().split("\n").pop();
  const backupDir = out.replace("backup complete: ", "");
  ok("backup created with checksums", fs.existsSync(path.join(backupDir, "SHA256SUMS")), fs.readdirSync(backupDir).length + " files");

  // simulate disaster: drop the project's database AND the control database
  const projDb = `maestro_${p.projectId}`;
  sh(`psql -q -d postgres -c 'DROP DATABASE "${projDb}" WITH (FORCE)'`);
  sh(`psql -q -d postgres -c 'DROP DATABASE "${CONTROL}" WITH (FORCE)'`);

  let refused = false; try { sh(`./scripts/restore.sh ${backupDir}`); } catch (e) { refused = true; }
  ok("restore refuses to run without --yes", refused);
  fs.appendFileSync(path.join(backupDir, `${CONTROL}.dump`), "x");
  let corrupt = false; try { sh(`./scripts/restore.sh ${backupDir} --yes`); } catch (e) { corrupt = true; }
  ok("restore refuses a corrupted backup (checksum mismatch)", corrupt);
  fs.writeFileSync(path.join(backupDir, `${CONTROL}.dump`), fs.readFileSync(path.join(backupDir, `${CONTROL}.dump`)).subarray(0, -1));

  sh(`./scripts/restore.sh ${backupDir} --yes`);
  server = startServer(PORT, { MAESTRO_AUTH_CACHE_TTL_MS: "0" }); await waitReady(BASE);
  const api2 = keyed(BASE, p.apiKey);
  const after = (await api2("POST", "/v1/query", { collection: "orders", queryType: "count" })).body.resultCount;
  ok("after restore: the SAME API key works (control plane restored)", (await api2("GET", "/v1/project")).status === 200);
  ok("after restore: all documents are back", after === before, `${after}/${before}`);
  ok("after restore: writes work", (await api2("POST", "/v1/data", { collection: "orders", data: { n: 999, label: "post-restore" } })).status === 201);
  await A("DELETE", `/v1/projects/${p.projectId}?purge=true`); server.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
