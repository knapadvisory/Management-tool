/**
 * Upgrade/migration test: builds a database with an OLDER schema (one
 * that predates later columns like attachments.task_id, tasks.project_id,
 * and the message thread columns), then boots the current server against
 * it and confirms it starts and serves. Guards against migrations that
 * only work on a fresh database — the exact failure mode where an index
 * referenced a not-yet-added column and crashed startup for existing users.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MIGRATION_PORT || 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-migrate-'));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

// --- Build an "old" database by hand (schema before task-depth / threads) ---
const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL, title TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
    is_private INTEGER NOT NULL DEFAULT 0, is_dm INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE channel_members (channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (channel_id, user_id));
  -- messages WITHOUT parent_id/edited_at/deleted_at (pre-threads)
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  -- attachments WITHOUT task_id (pre-task-attachments)
  CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, uploader_id INTEGER NOT NULL,
    stored_name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE workflow_stages (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, is_done INTEGER NOT NULL DEFAULT 0);
  -- tasks WITHOUT project_id (pre-projects)
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
    workflow_id INTEGER NOT NULL, stage_id INTEGER NOT NULL, assignee_id INTEGER, creator_id INTEGER NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium', due_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, user_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE task_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
const wf = db.prepare(`INSERT INTO workflows (name, description) VALUES ('Default', 'x')`).run();
['To Do', 'In Progress', 'Review', 'Done'].forEach((n, i) =>
  db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, ?)').run(wf.lastInsertRowid, n, i, i === 3 ? 1 : 0));
const gen = db.prepare(`INSERT INTO channels (name, description) VALUES ('general', 'x')`).run();
db.prepare('INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)')
  .run('Existing User', 'existing@old.test', bcrypt.hashSync('secret123', 10), '#4f46e5');
db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(gen.lastInsertRowid, 1);
db.prepare('INSERT INTO tasks (title, workflow_id, stage_id, creator_id) VALUES (?, ?, ?, ?)').run('Legacy task', 1, 1, 1);
db.close();

// --- Boot the CURRENT server against that old database ---
const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'migrate-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (d) => { stderr += d; });

async function main() {
  let started = false;
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/auth/me'); started = true; break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server starts against an old-schema database', started);
  if (!started) { console.error(stderr); return; }

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'existing@old.test', password: 'secret123' }),
  });
  check('existing user can still log in after upgrade', login.status === 200);
  const loginBody = await login.json();
  const { token } = loginBody;
  check('earliest existing user promoted to admin on upgrade', loginBody.user?.role === 'admin');

  // The migrated admin should reach admin-only routes.
  const roster = await fetch(BASE + '/api/admin/users', { headers: { Authorization: `Bearer ${token}` } });
  check('migrated admin can reach admin routes', roster.status === 200);

  const tasks = await (await fetch(BASE + '/api/tasks?workflow_id=1', { headers: { Authorization: `Bearer ${token}` } })).json();
  const legacy = tasks.tasks?.find((t) => t.title === 'Legacy task');
  check('legacy task migrated with new fields', !!legacy && Array.isArray(legacy.tags) && legacy.project === null);

  const proj = await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Post-upgrade project' }),
  });
  check('new task-depth features work after upgrade', proj.status === 201);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} migration check(s) FAILED` : '\nMigration test passed');
    process.exit(failures ? 1 : 0);
  });
