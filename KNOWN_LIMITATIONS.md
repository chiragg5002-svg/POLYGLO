# Known limitations (read before production use)

**Verification gaps in the build environment**
* **Real MongoDB: not tested.** The Mongo adapter passes the full conformance suite and the live DBaaS flow against **FerretDB 1.24 (a MongoDB-wire-compatible server on PostgreSQL), which is not MongoDB**. Unscoped `$text` search (needs MongoDB's wildcard text index) is untested on a real server. The CI workflow runs real `mongo:7`.
* **Elasticsearch: not tested against a real cluster.** Only fake-client tests. The ES adapter's visibility semantics (refresh/eventual consistency) are unverified.
* **Ollama/LLM routing accuracy: not measured** (safety is tested, accuracy is not).
* **Docker/Compose: not executed** (reviewed + YAML-linted only). **Real browser: no** (jsdom DOM tests only; no CSS/layout/e2e coverage; the legacy analysis UI `public/app.js` has no DOM tests). **GitHub Actions: not run.**
* Benchmarks ran on a single vCPU with everything co-located.

**Product limits**
* Legacy internal tools (`/database/*`, `/metadata*`, federated query …) are **operator-only and not tenant-scoped**; do not expose the operator token to tenants.
* Quotas on documents/storage are *soft*: counts are cached ~10 s, so a burst can overshoot by the burst size. Rate limiters are per instance.
* Import: JSON arrays are parsed in one piece (hence the 10 MB cap); CSV/NDJSON stream. Re-uploading without `idField` duplicates rows. No resumable/background imports; a crash leaves a partial import (safe to re-run with `idField`).
* PostgreSQL columns are inferred from the first document: later documents with a different type for a column get 400. Numbers are `double precision` (integers > 2^53 lose precision). Collections cannot be altered/re-routed after creation.
* Search semantics differ per store (PostgreSQL/ES substring/analysed vs MongoDB `$text` words). Offset pagination only; Elasticsearch limited to offset+limit ≤ 10 000.
* Cross-store operations are not transactional. Project purge across stores is retry-safe but not atomic.
* Audit log has no built-in retention/rotation and stores client IPs.
* Dependency vulnerabilities listed in `SECURITY.md` are **not fixed** (project rule: no `npm audit fix`).
* Jest needs `--forceExit` (an unidentified open handle remains when the whole legacy integration group runs together; every file exits cleanly on its own).
