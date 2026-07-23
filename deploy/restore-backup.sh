#!/usr/bin/env bash
# Restore TeamHub from one of its automatic backups.
#
# Backups live inside the "teamhub-data" Docker volume at /data/backups and are
# created automatically every day (see server/src/backup.js). This script lists
# them and restores a chosen one over the live database + uploads.
#
#   bash deploy/restore-backup.sh            # list available backups
#   bash deploy/restore-backup.sh <name>     # restore that backup
set -euo pipefail

VOL="${TEAMHUB_VOLUME:-teamhub-data}"
CONTAINER="${TEAMHUB_CONTAINER:-teamhub}"
HELPER_IMAGE="alpine"

list() {
  echo "Available backups (newest last):"
  docker run --rm -v "$VOL":/data "$HELPER_IMAGE" sh -c \
    'ls -1 /data/backups 2>/dev/null | grep "^teamhub-" | sort || echo "  (none yet)"' | sed 's/^/  /'
  echo
  echo "Restore one with:  bash deploy/restore-backup.sh <backup-name>"
}

if [ "${1:-list}" = "list" ]; then list; exit 0; fi
NAME="$1"

if ! docker run --rm -v "$VOL":/data "$HELPER_IMAGE" sh -c "[ -d /data/backups/$NAME ]"; then
  echo "❌ Backup '$NAME' not found."; echo; list; exit 1
fi

echo "⚠️  This REPLACES the current database and uploaded files with backup:"
echo "      $NAME"
echo "   Everything created since that backup will be lost."
read -rp "Type 'yes' to proceed: " ok
[ "$ok" = "yes" ] || { echo "Aborted."; exit 1; }

echo "==> Stopping $CONTAINER..."
docker stop "$CONTAINER" >/dev/null 2>&1 || true

echo "==> Restoring $NAME..."
docker run --rm -v "$VOL":/data "$HELPER_IMAGE" sh -c "
  set -e
  cp /data/backups/$NAME/app.db /data/app.db
  rm -f /data/app.db-wal /data/app.db-shm
  rm -rf /data/uploads && mkdir -p /data/uploads
  if [ -d /data/backups/$NAME/uploads ]; then cp -a /data/backups/$NAME/uploads/. /data/uploads/ 2>/dev/null || true; fi
"

echo "==> Starting $CONTAINER..."
docker start "$CONTAINER" >/dev/null 2>&1 || echo "   Could not start '$CONTAINER' — run: sudo bash deploy/vps-setup.sh"

echo "✅ Restored $NAME."
