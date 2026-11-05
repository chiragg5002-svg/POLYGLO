#!/usr/bin/env bash
# Backs up MAESTRO's PostgreSQL data: the control plane database and every
# per-project database (names starting with "maestro_"), plus MongoDB when
# `mongodump` is available. Elasticsearch needs a snapshot repository —
# see BACKUP_RESTORE.md.
#
#   PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=... ./scripts/backup.sh [dest-dir]
#
# Output: <dest>/maestro-backup-<UTC timestamp>/{*.dump, SHA256SUMS, MANIFEST.txt}
set -euo pipefail
export PGHOST="${PGHOST:-${PG_HOST:-localhost}}" PGPORT="${PGPORT:-${PG_PORT:-5432}}" PGUSER="${PGUSER:-${PG_USER:-postgres}}" PGPASSWORD="${PGPASSWORD:-${PG_PASSWORD:-}}"
DEST_ROOT="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$DEST_ROOT/maestro-backup-$STAMP"
mkdir -p "$DEST"; chmod 700 "$DEST"

DBS=$(psql -At -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'maestro\_%' ESCAPE '\' ORDER BY 1")
[ -n "$DBS" ] || { echo "No maestro_* databases found." >&2; exit 1; }
for db in $DBS; do
  echo "dumping $db"
  pg_dump --format=custom --no-owner --file="$DEST/$db.dump" "$db"
done

if command -v mongodump >/dev/null 2>&1 && [ -n "${MONGO_URI:-}" ]; then
  echo "dumping MongoDB"
  mongodump --uri="$MONGO_URI" --archive="$DEST/mongodb.archive.gz" --gzip
fi

( cd "$DEST" && sha256sum * > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS )
{ echo "created: $STAMP"; echo "databases: $(echo $DBS | tr '\n' ' ')"; } > "$DEST/MANIFEST.txt"
echo "backup complete: $DEST"
