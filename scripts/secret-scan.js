/*
 * Dependency-free secret scanner for the source tree / release ZIP.
 *   node scripts/secret-scan.js [dir]     exits 1 if anything suspicious is found
 * It is a safety net, not a replacement for gitleaks (CI runs both).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "backups", "uploads"]);
const SKIP_FILES = /(\.(png|jpg|jpeg|gif|ico|pptx|zip|woff2?|lock)$|package-lock\.json$)/i;
const RULES = [
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["MAESTRO API key", /\bpk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}\b/],
  ["credentials in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`$]+:(?!\$|<|\{|change|password|pass\b|secret|xxx|\*|\.\.\.)[^\s@/'"`$]{4,}@(?!\$)/i],
  ["hard-coded secret assignment", /\b(secret|token|api[_-]?key|password|passwd)\b\s*[:=]\s*["'](?!\s*["'])(?!change|your|example|<|\$\{|process\.env|xxx|\*+|test|dummy|placeholder|postgres["']|hunter2|secret["'])[A-Za-z0-9+/_\-]{20,}["']/i],
];
// Fixtures that are intentionally fake. Keep this list short and reviewed.
const ALLOW = [/(^|\/)tests\//, /(^|\/)benchmarks\//, /(^|\/)docs\//];
// Reviewed placeholder credentials that appear in legacy tutorial docs (not real secrets).
const ALLOW_LINE = [/ploy_user:ploy_password@localhost/];

const findings = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
    const full = path.join(dir, e.name); const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (SKIP_FILES.test(e.name) || fs.statSync(full).size > 2_000_000) continue;
    if (/^\.env(\..*)?$/.test(e.name) && !/example$/.test(e.name)) { findings.push({ rel, rule: "environment file must not be shipped", line: 0 }); continue; }
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      for (const [name, re] of RULES) if (re.test(line) && !ALLOW.some((a) => a.test(rel)) && !ALLOW_LINE.some((a) => a.test(line))) findings.push({ rel, rule: name, line: i + 1 });
    });
  }
})(ROOT);

if (findings.length) { console.error(`secret-scan: ${findings.length} finding(s)`); findings.forEach((f) => console.error(`  ${f.rel}:${f.line}  ${f.rule}`)); process.exit(1); }
console.log(`secret-scan: clean (${ROOT})`);
