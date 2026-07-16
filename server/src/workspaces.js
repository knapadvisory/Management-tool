import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { seedWorkspace } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');

// Turn a company name into a URL-safe slug, guaranteeing uniqueness.
export function slugify(name) {
  const base = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
  let slug = base, n = 2;
  while (db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function workspaceBySlug(slug) {
  return db.prepare('SELECT * FROM workspaces WHERE slug = ?').get((slug || '').trim().toLowerCase()) || null;
}
export function workspaceById(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
}

// Public-safe view of a workspace (for the client).
export function publicWorkspace(w) {
  if (!w) return null;
  return { id: w.id, name: w.name, slug: w.slug };
}

// Create a brand-new workspace and seed its starter content (#general + a
// default workflow). Returns the workspace row.
export function createWorkspace({ name }) {
  if (!name?.trim()) throw Object.assign(new Error('Workspace name is required'), { status: 400 });
  const slug = slugify(name);
  const info = db.prepare('INSERT INTO workspaces (name, slug) VALUES (?, ?)').run(name.trim(), slug);
  seedWorkspace(info.lastInsertRowid);
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(info.lastInsertRowid);
}

// Permanently remove a workspace and everything inside it — users, channels,
// messages, tasks, files (rows + on-disk uploads). Irreversible. Returns the
// number of upload files removed. Caller must guard (platform admin, not the
// platform workspace, name confirmed, and — recommended — a backup first).
export function deleteWorkspace(id) {
  const files = db.prepare('SELECT stored_name FROM attachments WHERE workspace_id = ?').all(id).map((r) => r.stored_name);
  db.pragma('foreign_keys = OFF');
  try {
    const purge = db.transaction(() => {
      const run = (sql) => db.prepare(sql).run({ w: id });
      const msgs = 'SELECT id FROM messages WHERE workspace_id = @w';
      const att = 'SELECT id FROM attachments WHERE workspace_id = @w';
      const tasks = 'SELECT id FROM tasks WHERE workspace_id = @w';
      const tpl = 'SELECT id FROM task_templates WHERE workspace_id = @w';
      const wf = 'SELECT id FROM workflows WHERE workspace_id = @w';
      const ch = 'SELECT id FROM channels WHERE workspace_id = @w';
      const usr = 'SELECT id FROM users WHERE workspace_id = @w';
      // Children first (subqueries reference the still-present parents)…
      run(`DELETE FROM message_reactions WHERE message_id IN (${msgs})`);
      run(`DELETE FROM mentions WHERE message_id IN (${msgs})`);
      run(`DELETE FROM drive_file_shares WHERE attachment_id IN (${att})`);
      run(`DELETE FROM task_comments WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_activity WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_tags WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_checklist WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_watchers WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_assignees WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_messages WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_reminders WHERE task_id IN (${tasks})`);
      run(`DELETE FROM task_template_steps WHERE template_id IN (${tpl})`);
      run(`DELETE FROM task_template_tags WHERE template_id IN (${tpl})`);
      run(`DELETE FROM workflow_stages WHERE workflow_id IN (${wf})`);
      run(`DELETE FROM channel_members WHERE channel_id IN (${ch})`);
      run(`DELETE FROM notifications WHERE user_id IN (${usr})`);
      // …then the parents.
      run('DELETE FROM messages WHERE workspace_id = @w');
      run('DELETE FROM attachments WHERE workspace_id = @w');
      run('DELETE FROM tasks WHERE workspace_id = @w');
      run('DELETE FROM task_templates WHERE workspace_id = @w');
      run('DELETE FROM workflows WHERE workspace_id = @w');
      run('DELETE FROM projects WHERE workspace_id = @w');
      run('DELETE FROM drive_folders WHERE workspace_id = @w');
      run('DELETE FROM channels WHERE workspace_id = @w');
      run('DELETE FROM workspace_invite_codes WHERE workspace_id = @w');
      run('DELETE FROM company_registration_codes WHERE used_by_workspace = @w');
      run('DELETE FROM users WHERE workspace_id = @w');
      run('DELETE FROM workspaces WHERE id = @w');
    });
    purge();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  // Remove the workspace's uploaded files from disk.
  for (const name of files) { try { fs.unlinkSync(path.join(UPLOADS_DIR, name)); } catch { /* already gone */ } }
  return files.length;
}
