import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const INTERVAL_HOURS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24));
// A shell command the operator sets to push each new backup OFF the box (the
// single most important DR gap — on-box backups die with the box). It runs
// after a verified snapshot with BACKUP_PATH / BACKUP_NAME / BACKUP_ROOT in the
// environment, e.g. `rclone copy "$BACKUP_PATH" remote:teamhub/$BACKUP_NAME`.
const SYNC_CMD = process.env.BACKUP_SYNC_CMD || '';
const OFFSITE_STATE = path.join(BACKUP_DIR, 'offsite-state.json');

// Open a snapshot read-only and confirm SQLite considers it sound. A backup
// that fails this is worse than useless — it hides the fact that you're
// unprotected — so we refuse to keep it.
function integrityOf(dbPath) {
  const snap = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = snap.prepare('PRAGMA integrity_check').get();
    return row?.integrity_check || 'unknown';
  } finally { snap.close(); }
}

// Timestamp like 20260713-173042 (local server time). Safe in server code
// (the Date.now()/new Date() restriction only applies to workflow scripts).
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Copy the uploads folder into the backup. Uploaded files are immutable, so we
// hard-link them (near-zero extra disk); fall back to a real copy if linking
// isn't possible (e.g. a different filesystem).
function mirrorUploads(destDir) {
  if (!fs.existsSync(UPLOADS_DIR)) return { files: 0, bytes: 0 };
  fs.mkdirSync(destDir, { recursive: true });
  let files = 0, bytes = 0;
  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    const src = path.join(UPLOADS_DIR, name), dst = path.join(destDir, name);
    let st;
    try { st = fs.statSync(src); } catch { continue; }
    if (!st.isFile()) continue;
    try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    files++; bytes += st.size;
  }
  return { files, bytes };
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else total += st.size;
    }
  };
  try { walk(dir); } catch { /* */ }
  return total;
}

// Take a consistent snapshot of the database (safe while the app is running —
// better-sqlite3's online backup handles WAL) plus the uploaded files.
export async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `teamhub-${stamp()}`;
  const dest = path.join(BACKUP_DIR, name);
  const tmp = `${dest}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  await db.backup(path.join(tmp, 'app.db'));
  // Verify the snapshot before we trust it — a corrupt backup is discarded.
  const integrity = integrityOf(path.join(tmp, 'app.db'));
  if (integrity !== 'ok') {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`backup integrity check failed (${integrity})`);
  }
  const up = mirrorUploads(path.join(tmp, 'uploads'));
  const dbSize = fs.statSync(path.join(tmp, 'app.db')).size;
  fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({
    created_at: new Date().toISOString(), db_size: dbSize, files: up.files, upload_bytes: up.bytes, integrity,
  }, null, 2));

  fs.renameSync(tmp, dest); // atomic: a backup dir only appears once complete
  prune();
  const total = dirSize(dest);
  console.log(`[backup] ${name} — db ${(dbSize / 1024).toFixed(0)} KB, ${up.files} files, ${(total / 1048576).toFixed(1)} MB total, integrity ok`);
  await syncOffsite(name, dest); // push off-box if configured (best-effort; never fails the backup)
  return { name, created_at: new Date().toISOString(), db_size: dbSize, files: up.files, size: total, integrity };
}

// Push a completed backup off the box using the operator's configured command.
// Best-effort: a sync failure is recorded and logged loudly but never rolls
// back the (already-safe on-box) backup. The last result feeds the admin status
// so a silently-failing off-site pipeline is visible, not assumed-working.
function writeOffsiteState(state) {
  try { fs.writeFileSync(OFFSITE_STATE, JSON.stringify(state, null, 2)); } catch { /* */ }
}
async function syncOffsite(name, dest) {
  if (!SYNC_CMD) return;
  await new Promise((resolve) => {
    execFile('sh', ['-c', SYNC_CMD], {
      env: { ...process.env, BACKUP_PATH: dest, BACKUP_NAME: name, BACKUP_ROOT: BACKUP_DIR },
      timeout: 10 * 60 * 1000,
    }, (err) => {
      if (err) {
        console.error(`[backup] off-site sync FAILED for ${name}: ${err.message}`);
        writeOffsiteState({ last_at: new Date().toISOString(), name, ok: false, error: err.message });
      } else {
        console.log(`[backup] off-site sync ok for ${name}`);
        writeOffsiteState({ last_at: new Date().toISOString(), name, ok: true });
      }
      resolve();
    });
  });
}

// A non-destructive restore drill: confirm a stored backup would actually come
// back — its db passes an integrity check and still holds real rows. Defaults
// to the newest backup. This is what turns "we have backups" into "we know they
// restore".
export function verifyBackup(name) {
  const target = name || listDirs()[0]?.name;
  if (!target) return { ok: false, error: 'No backups exist yet.' };
  const dbPath = path.join(BACKUP_DIR, target, 'app.db');
  if (!fs.existsSync(dbPath)) return { ok: false, name: target, error: 'Snapshot database is missing.' };
  try {
    const integrity = integrityOf(dbPath);
    const snap = new Database(dbPath, { readonly: true });
    let counts = {};
    try {
      counts = {
        workspaces: snap.prepare('SELECT COUNT(*) n FROM workspaces').get().n,
        users: snap.prepare('SELECT COUNT(*) n FROM users').get().n,
        clients: snap.prepare('SELECT COUNT(*) n FROM clients').get().n,
        tasks: snap.prepare('SELECT COUNT(*) n FROM tasks').get().n,
      };
    } finally { snap.close(); }
    return { ok: integrity === 'ok', name: target, integrity, counts };
  } catch (e) {
    return { ok: false, name: target, error: e.message };
  }
}

function offsiteState() {
  try { return JSON.parse(fs.readFileSync(OFFSITE_STATE, 'utf8')); } catch { return null; }
}

// Keep only the newest KEEP backups.
function prune() {
  const dirs = listDirs();
  for (const b of dirs.slice(KEEP)) {
    fs.rmSync(path.join(BACKUP_DIR, b.name), { recursive: true, force: true });
  }
}

function listDirs() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith('teamhub-') && !n.endsWith('.partial'))
    .map((n) => ({ name: n, mtime: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

// A public-facing list of backups with sizes, for the admin panel.
export function listBackups() {
  return listDirs().map(({ name }) => {
    const dir = path.join(BACKUP_DIR, name);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* */ }
    return {
      name,
      created_at: meta.created_at || new Date(fs.statSync(dir).mtime).toISOString(),
      size: dirSize(dir),
      files: meta.files ?? null,
      db_size: meta.db_size ?? null,
    };
  });
}

export function backupStatus() {
  const backups = listBackups();
  return {
    enabled: !process.env.BACKUP_DISABLED,
    interval_hours: INTERVAL_HOURS,
    keep: KEEP,
    dir: BACKUP_DIR,
    count: backups.length,
    latest: backups[0] || null,
    offsite: { configured: !!SYNC_CMD, last: offsiteState() },
    backups,
  };
}

// The newest backup's database file, for an off-site download.
export function latestDbPath() {
  const [newest] = listDirs();
  if (!newest) return null;
  const p = path.join(BACKUP_DIR, newest.name, 'app.db');
  return fs.existsSync(p) ? p : null;
}

// Run a backup on boot (if the newest is stale) and then hourly, taking one
// whenever the newest backup is older than the configured interval.
export function startBackupScheduler() {
  if (process.env.BACKUP_DISABLED) { console.log('[backup] disabled via BACKUP_DISABLED'); return; }
  const dueMs = INTERVAL_HOURS * 3600 * 1000;
  const tick = async () => {
    try {
      const [newest] = listDirs();
      if (!newest || (Date.now() - newest.mtime) >= dueMs) await runBackup();
    } catch (e) {
      console.error('[backup] failed:', e.message);
    }
  };
  setTimeout(tick, 30_000);          // shortly after boot
  setInterval(tick, 60 * 60 * 1000); // re-check hourly
}
