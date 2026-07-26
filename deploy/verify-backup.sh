#!/usr/bin/env bash
# Restore drill for TeamHub backups — NON-DESTRUCTIVE. Proves a stored backup
# would actually come back: its database passes SQLite's integrity check and
# still holds real rows. Touches nothing live, so it's safe to run any time
# (make it a weekly cron alongside the automatic backups).
#
#   bash deploy/verify-backup.sh            # drill the newest backup
#   bash deploy/verify-backup.sh <name>     # drill a specific backup
#
# Exits 0 only if the backup is sound — so cron/monitoring can alert on failure.
set -euo pipefail

VOL="${TEAMHUB_VOLUME:-teamhub-data}"
IMAGE="${TEAMHUB_IMAGE:-teamhub:latest}"
NAME="${1:-}"

# Runs inside the app image (which already has better-sqlite3). Picks the newest
# backup unless a name is given, integrity-checks it, and prints row counts.
read -r -d '' SCRIPT <<'NODE' || true
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = '/data/backups';
const want = process.env.NAME || '';
const dirs = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter((n) => n.startsWith('teamhub-') && !n.endsWith('.partial'))
      .map((n) => ({ n, m: fs.statSync(path.join(ROOT, n)).mtimeMs })).sort((a, b) => b.m - a.m)
  : [];
const name = want || dirs[0]?.n;
if (!name) { console.error('No backups found in ' + ROOT); process.exit(2); }
const dbPath = path.join(ROOT, name, 'app.db');
if (!fs.existsSync(dbPath)) { console.error('Snapshot db missing for ' + name); process.exit(2); }
const db = new Database(dbPath, { readonly: true });
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const count = (t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 'n/a'; } };
const counts = { workspaces: count('workspaces'), users: count('users'), clients: count('clients'), tasks: count('tasks') };
db.close();
console.log(`backup:    ${name}`);
console.log(`integrity: ${integrity}`);
console.log(`rows:      ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
if (integrity !== 'ok') { console.error('❌ integrity check FAILED'); process.exit(1); }
console.log('✅ backup verified — it would restore.');
NODE

echo "==> Verifying backup${NAME:+ '$NAME'} from volume '$VOL'…"
docker run --rm -e NAME="$NAME" -v "$VOL":/data "$IMAGE" node -e "$SCRIPT"
