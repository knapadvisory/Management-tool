#!/bin/sh
# Container entrypoint for TeamHub.
#
# If continuous off-site replication is configured (LITESTREAM_REPLICA_URL),
# litestream restores the database on a fresh box and then supervises the app
# while streaming every change off-site. If it's NOT configured, the app runs
# exactly as before — so this is a safe no-op for existing deployments.
set -e

DB="${DATA_DIR:-/data}/app.db"

# --- No replica configured: run the app directly (backward compatible) --------
if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
  exec node src/index.js
fi

# --- Replica configured: build a minimal litestream config from the env -------
CFG=/tmp/litestream.yml
{
  echo "dbs:"
  echo "  - path: ${DB}"
  echo "    replicas:"
  echo "      - url: ${LITESTREAM_REPLICA_URL}"
  if [ -n "${LITESTREAM_ENDPOINT:-}" ]; then
    echo "        endpoint: ${LITESTREAM_ENDPOINT}"
  fi
  if [ -n "${LITESTREAM_FORCE_PATH_STYLE:-}" ]; then
    echo "        force-path-style: ${LITESTREAM_FORCE_PATH_STYLE}"
  fi
} > "$CFG"

# --- Disaster recovery: if there's no local DB, restore the newest replica ----
# Safe no-op when the replica is empty (a brand-new install just creates the DB).
if [ ! -f "$DB" ]; then
  echo "[litestream] no local database — attempting restore from replica…"
  if litestream restore -if-replica-exists -config "$CFG" "$DB"; then
    echo "[litestream] restored ${DB} from off-site replica."
  else
    echo "[litestream] no replica to restore — starting with a fresh database."
  fi
fi

# --- Run the app under litestream (it replicates while the app runs) -----------
echo "[litestream] replicating ${DB} → ${LITESTREAM_REPLICA_URL}"
exec litestream replicate -config "$CFG" -exec "node src/index.js"
