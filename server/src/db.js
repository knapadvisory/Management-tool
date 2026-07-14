import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- Each tenant is a workspace (a company). Every user, channel, task, file …
-- belongs to exactly one workspace, and all queries are scoped to it.
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  allowed_signup_domains TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  title TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_private INTEGER NOT NULL DEFAULT 0,
  is_dm INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Folders for the shared team Drive. parent_id NULL = a top-level folder.
CREATE TABLE IF NOT EXISTS drive_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES drive_folders(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drive_folders_parent ON drive_folders(parent_id);

-- People a Drive file is tagged / "shared with" (informational — the Drive is
-- team-wide; this records who a file is meant for).
CREATE TABLE IF NOT EXISTS drive_file_shares (
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (attachment_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stages_workflow ON workflow_stages(workflow_id, position);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL REFERENCES workflow_stages(id),
  assignee_id INTEGER REFERENCES users(id),
  creator_id INTEGER NOT NULL REFERENCES users(id),
  priority TEXT NOT NULL DEFAULT 'medium',
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT NOT NULL DEFAULT '#4f46e5',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);

CREATE TABLE IF NOT EXISTS task_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checklist_task ON task_checklist(task_id, position);

CREATE TABLE IF NOT EXISTS task_watchers (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- Reusable task blueprints for repeatable client processes.
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  default_priority TEXT NOT NULL DEFAULT 'medium',
  default_workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_template_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_template_steps ON task_template_steps(template_id, position);

CREATE TABLE IF NOT EXISTS task_template_tags (
  template_id INTEGER NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (template_id, tag)
);

-- Time-based reminders for a task. A background scheduler fires each one
-- once (sent=1) as a notification to the assignee + watchers.
CREATE TABLE IF NOT EXISTS task_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON task_reminders(sent, remind_at);

-- Real-time chat scoped to a single task (distinct from async "Notes").
CREATE TABLE IF NOT EXISTS task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_messages ON task_messages(task_id, id);

-- Persistent notification inbox (bell). channel_id / task_id point at
-- wherever clicking the notification should navigate.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

-- Device tokens for mobile push (FCM). One row per device; a token belongs to
-- whoever last registered it (device handoff re-points it).
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- Simple key/value store for workspace-wide settings the admin controls
-- (e.g. which email domains may self-register as members).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Single-use codes an admin generates so a specific person can join their
-- workspace via the join link. One code per joinee; spent once used.
CREATE TABLE IF NOT EXISTS workspace_invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  used_by INTEGER REFERENCES users(id),
  used_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ws_invite_codes ON workspace_invite_codes(workspace_id);

-- Single-use codes the platform owner (KNAP) gives a new company so it can
-- register its own workspace. Spent once the workspace is created.
CREATE TABLE IF NOT EXISTS company_registration_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  used_by_workspace INTEGER REFERENCES workspaces(id),
  used_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use, time-limited tokens for self-service password reset by email.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Add columns to tables created before these features existed.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('messages', 'parent_id', 'INTEGER REFERENCES messages(id)');
ensureColumn('messages', 'edited_at', 'TEXT');
ensureColumn('messages', 'deleted_at', 'TEXT');
ensureColumn('attachments', 'task_id', 'INTEGER REFERENCES tasks(id)');
// A file attached to a single per-task chat message (distinct from task_id,
// which is a file attached to the task itself / its Files tab).
ensureColumn('attachments', 'task_message_id', 'INTEGER REFERENCES task_messages(id)');
// Soft-delete (archive): a file the uploader deletes is hidden everywhere but
// kept for the admin's archive. archived_by records who removed it.
ensureColumn('attachments', 'archived_at', 'TEXT');
ensureColumn('attachments', 'archived_by', 'INTEGER REFERENCES users(id)');
// Team Drive: a file uploaded straight to the shared Drive (not tied to a
// message or task) is flagged here so everyone on the team can see it.
ensureColumn('attachments', 'is_drive', 'INTEGER NOT NULL DEFAULT 0');
// Which Drive folder a file lives in (NULL = the Drive root).
ensureColumn('attachments', 'drive_folder_id', 'INTEGER REFERENCES drive_folders(id)');
ensureColumn('tasks', 'project_id', 'INTEGER REFERENCES projects(id)');
// Repeat rule: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'. When a
// recurring task is completed, the next occurrence is generated automatically.
ensureColumn('tasks', 'recurrence', "TEXT NOT NULL DEFAULT 'none'");
// Lifecycle status (independent of the workflow stage / Kanban column):
// 'in_progress' | 'completed' | 'hold' | 'cancelled'. Hold/cancelled carry a
// mandatory reason in status_reason.
ensureColumn('tasks', 'status', "TEXT NOT NULL DEFAULT 'in_progress'");
ensureColumn('tasks', 'status_reason', "TEXT NOT NULL DEFAULT ''");
// completed_at is stamped when a task becomes "done" (completed status or a
// done stage); archived_at hides finished tasks from the active board/list.
ensureColumn('tasks', 'completed_at', 'TEXT');
ensureColumn('tasks', 'archived_at', 'TEXT');
// Org roles: 'admin' (super admin — full oversight + user management) or 'member'.
// 'active' gates access; deactivating revokes login without destroying data.
ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'member'");
ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
// Account deletion is a two-stage, reversible-then-permanent flow: an account
// is first deactivated (active=0, deactivated_at set), and only after a grace
// period may an admin permanently delete it (deleted=1) — their login is gone
// but their record and content stay for the admin's records.
ensureColumn('users', 'deactivated_at', 'TEXT');
ensureColumn('users', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
// Members who self-register via a workspace join link start unapproved and
// cannot log in until an admin approves them. Existing rows default to 1 so
// current accounts (and admin-created / guest ones) stay usable.
ensureColumn('users', 'approved', 'INTEGER NOT NULL DEFAULT 1');
// Per-user appearance: colour mode ('light'|'dark'|'system') and accent hex.
ensureColumn('users', 'theme', "TEXT NOT NULL DEFAULT 'light'");
ensureColumn('users', 'accent', "TEXT NOT NULL DEFAULT '#4f46e5'");
// Collabs are private group spaces (a specialised channel) with their own
// owner/moderators and permission settings.
ensureColumn('channels', 'is_collab', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('channels', 'history_visible', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('channels', 'who_can_invite', "TEXT NOT NULL DEFAULT 'all'"); // 'all' | 'mods'
ensureColumn('channels', 'who_can_post', "TEXT NOT NULL DEFAULT 'all'"); // 'all' | 'mods'
// A per-collab invite link that lets an outside guest join just that collab.
ensureColumn('channels', 'guest_token', 'TEXT');
// When on, joining this workspace requires a valid single-use invite code.
ensureColumn('workspaces', 'require_invite_code', 'INTEGER NOT NULL DEFAULT 0');
// Per-channel membership role: 'owner' | 'moderator' | 'member'.
ensureColumn('channel_members', 'role', "TEXT NOT NULL DEFAULT 'member'");
// When a member hides a conversation from their list. It stays hidden until a
// newer message arrives (or they re-open it), so history is never lost.
ensureColumn('channel_members', 'hidden_at', 'TEXT');
// "Clear chat": messages at or before this time are hidden from THIS member's
// view only (the other participant keeps their copy).
ensureColumn('channel_members', 'cleared_before', 'TEXT');

// --- Multi-tenancy: every root entity belongs to a workspace ---
// Added as plain columns (nullable at the DB level) and always set in code;
// existing rows are backfilled into a default workspace just below.
for (const table of ['users', 'channels', 'messages', 'attachments', 'drive_folders', 'workflows', 'tasks', 'projects', 'task_templates']) {
  ensureColumn(table, 'workspace_id', 'INTEGER REFERENCES workspaces(id)');
}

// Indexes on migration-added columns must come after the columns exist,
// otherwise upgrading an existing database fails on startup.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_drive ON attachments(is_drive);
  CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id);
`);

// Backfill: if a database predates workspaces, move all existing data into a
// single default workspace so nothing is orphaned. Runs once.
if (!db.prepare('SELECT 1 FROM workspaces LIMIT 1').get() && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const legacyDomains = db.prepare(`SELECT value FROM app_settings WHERE key = 'allowed_signup_domains'`).get()?.value || '';
  const migrate = db.transaction(() => {
    const ws = db.prepare('INSERT INTO workspaces (name, slug, allowed_signup_domains) VALUES (?, ?, ?)')
      .run('KNAP Advisory', 'knap', legacyDomains);
    const id = ws.lastInsertRowid;
    for (const table of ['users', 'channels', 'messages', 'attachments', 'drive_folders', 'workflows', 'tasks', 'projects', 'task_templates']) {
      db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`).run(id);
    }
  });
  migrate();
}

// Ensure the backfilled workspace has a super admin. If none exists yet
// (a database created before roles existed), promote its earliest account.
if (!db.prepare(`SELECT 1 FROM users WHERE role = 'admin' AND active = 1`).get()) {
  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (first) db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(first.id);
}

// Backfill completed_at for tasks that are already "done" (so the 7-day
// auto-archive can act on them), using their last-updated time as an estimate.
db.prepare(`
  UPDATE tasks SET completed_at = updated_at
  WHERE completed_at IS NULL
    AND (status = 'completed' OR stage_id IN (SELECT id FROM workflow_stages WHERE is_done = 1))
`).run();

// Give a freshly-created workspace its starter content: a #general channel and
// a default task workflow. Called when a new workspace is provisioned.
export function seedWorkspace(workspaceId) {
  const t = db.transaction(() => {
    if (!db.prepare(`SELECT id FROM channels WHERE name = 'general' AND is_dm = 0 AND workspace_id = ?`).get(workspaceId)) {
      db.prepare(`INSERT INTO channels (name, description, workspace_id) VALUES ('general', 'Company-wide announcements and chatter', ?)`).run(workspaceId);
    }
    if (!db.prepare(`SELECT id FROM workflows WHERE workspace_id = ? LIMIT 1`).get(workspaceId)) {
      const wf = db.prepare(`INSERT INTO workflows (name, description, workspace_id) VALUES ('Default', 'Standard task flow', ?)`).run(workspaceId);
      const stage = db.prepare(`INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, ?)`);
      ['To Do', 'In Progress', 'Review'].forEach((name, i) => stage.run(wf.lastInsertRowid, name, i, 0));
      stage.run(wf.lastInsertRowid, 'Done', 3, 1);
    }
  });
  t();
}

// Make sure the backfilled (legacy) workspace has its starter content wired to
// its workspace_id — older installs seeded #general/workflow before workspaces
// existed, and the backfill above stamped them; nothing to do if already set.
const legacyWs = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get();
if (legacyWs) seedWorkspace(legacyWs.id);

// --- Global platform settings (key/value) — not per-workspace ---
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value ?? '');
}

export default db;
