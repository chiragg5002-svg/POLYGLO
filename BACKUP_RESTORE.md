# Backup & restore

## PostgreSQL (control plane + every PostgreSQL-backed project database) — **tested end to end**
```bash
export PGHOST=... PGUSER=... PGPASSWORD=...
./scripts/backup.sh ./backups                      # one custom-format dump per maestro_* database + SHA256SUMS + MANIFEST
./scripts/restore.sh ./backups/maestro-backup-<UTC> --yes [--only maestro_control]
```
* `restore.sh` refuses without `--yes`, **verifies SHA-256 checksums first** (a corrupted dump aborts before anything is dropped), then drops/recreates each restored database.
* Stop the API (or restore to a fresh server) while restoring.
* Backups contain **hashed** API keys and all tenant data — store them encrypted with restricted access; the directory is created `0700`.
* The restore requires the same `MAESTRO_KEY_PEPPER` as the backup's source, otherwise restored keys will not authenticate.

`npm run test:backup` proves the loop on a live system: create project + 25 documents → backup → **drop the project database and control database** → restore → the *same API key* works, all 25 documents are back, writes succeed; also asserts the no-`--yes` and corrupted-backup refusals.

## MongoDB — *script path written, NOT verified against real MongoDB*
`backup.sh` runs `mongodump --archive --gzip` when `mongodump` and `MONGO_URI` are present; `restore.sh` runs `mongorestore --drop`. Rehearse on your own MongoDB before relying on it.

## Elasticsearch — *procedure only, not scripted or tested*
Register a snapshot repository (`PUT _snapshot/maestro_repo`), then `PUT _snapshot/maestro_repo/snap-<date>` for indices `maestro_*`; restore with `POST _snapshot/maestro_repo/<snap>/_restore`.

## Redis
Cache only; never needs backup. After a restore, flushing it is optional (cache versions are time-seeded, stale entries cannot be served).

## Consistency caveat
Dumps of different databases are taken sequentially, not atomically. For a consistent point-in-time across the control plane and project databases, quiesce writes (stop the API) or use storage-level snapshots.

## Disaster recovery targets
Not defined by this software. RPO = your backup interval; RTO ≈ restore time + container start (restore of a 25-document project took seconds in the test; size scales with data).
