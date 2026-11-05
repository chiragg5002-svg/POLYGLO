#!/usr/bin/env bash
# Restores a backup produced by scripts/backup.sh. DESTRUCTIVE for the
# databases it restores (they are dropped and recreated), so it requires
# an explicit --yes. Stop the API first (or restore to a fresh server).
#
#   ./scripts/restore.sh <backup-dir> --yes [--only maestro_control]
set -euo pipefail
export PGHOST="${PGHOST:-${PG_HOST:-localhost}}" PGPORT="${PGPORT:-${PG_PORT:-5432}}" PGUSER="${PGUSER:-${PG_USER:-postgres}}" PGPASSWORD="${PGPASSWORD:-${PG_PASSWORD:-}}"
SRC="${1:?usage: restore.sh <backup-dir> --yes [--only <db>]}"; shift
CONFIRM=no; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --yes) CONFIRM=yes;; --only) ONLY="$2"; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
[ "$CONFIRM" = yes ] || { echo "Refusing to restore without --yes (this drops and recreates the restored databases)." >&2; exit 2; }
( cd "$SRC" && sha256sum --check --quiet SHA256SUMS ) || { echo "Checksum verification FAILED; refusing to restore." >&2; exit 1; }
for f in "$SRC"/*.dump; do
  db="$(basename "$f" .dump)"
  [ -z "$ONLY" ] || [ "$ONLY" = "$db" ] || continue
  echo "restoring $db"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
  psql -q -d postgres -c "CREATE DATABASE \"$db\""
  pg_restore --no-owner --exit-on-error -d "$db" "$f"
done
if [ -f "$SRC/mongodb.archive.gz" ] && command -v mongorestore >/dev/null 2>&1 && [ -n "${MONGO_URI:-}" ] && [ -z "$ONLY" ]; then
  echo "restoring MongoDB"; mongorestore --uri="$MONGO_URI" --archive="$SRC/mongodb.archive.gz" --gzip --drop
fi
echo "restore complete"
