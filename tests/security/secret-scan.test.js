const fs = require("fs"); const os = require("os"); const path = require("path");
const { spawnSync } = require("child_process");
const scan = (dir) => spawnSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "secret-scan.js"), dir], { encoding: "utf8" });
const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "scan-")); for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), c); } return d; };

test("detects real-looking secrets", () => {
  const cases = {
    "a.js": "const k = 'pk_" + "0123456789ab_" + "A".repeat(43) + "';",
    "b.js": "-----BEGIN RSA PRIVATE KEY-----",
    "c.js": "const u = 'mongodb://admin:Sup3rS3cretPw@db.example.com:27017';",
    "d.js": "const password = 'Zk39dkQpLmN48sd0Xv72abQw';",
    "e.js": "const key = 'AKIAIOSFODNN7EXAMPLE';",
    ".env": "PG_PASSWORD=real",
  };
  for (const [n, c] of Object.entries(cases)) {
    const r = scan(mk({ [n]: c }));
    expect({ n, code: r.status }).toEqual({ n, code: 1 });
  }
});
test("passes clean code, placeholders and env examples", () => {
  const r = scan(mk({ "x.js": "const url = `postgres://${user}:${pw}@host/db`; const t = process.env.TOKEN; const password = '';", ".env.example": "PG_PASSWORD=change-me", "doc.md": "mongodb://user:<password>@host" }));
  expect(r.status).toBe(0);
});
