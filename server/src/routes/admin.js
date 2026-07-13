import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { publicUser, joinGeneral } from '../auth.js';
import { createNotification } from '../notifications.js';
import { serializeMessage } from '../messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'uploads');

const router = Router();
const AVATAR_COLORS = ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e', '#7c3aed', '#f97316', '#0ea5e9', '#db2777'];

// Every route here is already behind requireAuth + requireAdmin (see index.js).
// An admin governs only their OWN workspace, so all lookups are scoped to it.
const wsUser = (req) => db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);

// How long an account must sit deactivated before it can be permanently
// deleted — a safety window in case the deactivation was a mistake.
const DELETE_GRACE_DAYS = 7;

// Full roster (this workspace) of approved, non-deleted accounts including
// deactivated ones, but not external guests or pending join requests.
router.get('/users', (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE workspace_id = ? AND role != 'guest' AND approved = 1 AND deleted = 0 ORDER BY active DESC, name`).all(req.workspaceId).map((u) => ({
    ...publicUser(u),
    created_at: u.created_at,
    delete_grace_days: DELETE_GRACE_DAYS,
  }));
  res.json({ users });
});

// Permanently-deleted accounts, kept for the admin's records (their content —
// tasks, messages, files — stays attributed to them).
router.get('/users/deleted', (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE workspace_id = ? AND deleted = 1 ORDER BY deactivated_at DESC, name`).all(req.workspaceId)
    .map((u) => ({ ...publicUser(u), created_at: u.created_at }));
  res.json({ users });
});

// People who self-registered via the join link and are awaiting approval.
router.get('/users/pending', (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE workspace_id = ? AND approved = 0 AND role != 'guest' ORDER BY created_at`).all(req.workspaceId)
    .map((u) => ({ ...publicUser(u), created_at: u.created_at }));
  res.json({ users });
});

// Approve a pending join request: the member can now sign in and is added to #general.
router.post('/users/:id/approve', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ? AND approved = 0').get(req.params.id, req.workspaceId);
  if (!target) return res.status(404).json({ error: 'Pending request not found' });
  db.prepare('UPDATE users SET approved = 1 WHERE id = ?').run(target.id);
  joinGeneral(req.workspaceId, target.id);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('directory:changed');
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('approvals:changed');
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

// Reject (and remove) a pending join request.
router.post('/users/:id/reject', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ? AND approved = 0').get(req.params.id, req.workspaceId);
  if (!target) return res.status(404).json({ error: 'Pending request not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('approvals:changed');
  res.json({ ok: true });
});

// Create a teammate directly (no access code needed — the admin is vouching).
router.post('/users', (req, res) => {
  const { name, email, password, title = '', role = 'member' } = req.body;
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    return res.status(400).json({ error: 'Name, email and a password of 6+ characters are required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const chosenRole = role === 'admin' ? 'admin' : 'member';
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db.prepare(
    'INSERT INTO users (name, email, password_hash, avatar_color, title, role, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), normalizedEmail, bcrypt.hashSync(password, 10), color, title.trim(), chosenRole, req.workspaceId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Everyone joins this workspace's #general automatically.
  const general = db.prepare(`SELECT id FROM channels WHERE name = 'general' AND is_dm = 0 AND workspace_id = ?`).get(req.workspaceId);
  if (general) db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(general.id, user.id);

  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('directory:changed');
  res.status(201).json(publicUser(user));
});

// Change role and/or title. Guard against removing the last active admin.
router.patch('/users/:id', (req, res) => {
  const target = wsUser(req);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role, title } = req.body;

  if (role && role !== target.role) {
    if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'Invalid role' });
    if (target.role === 'admin' && role === 'member' && lastActiveAdmin(target.id, req.workspaceId)) {
      return res.status(400).json({ error: 'Cannot demote the only remaining admin' });
    }
  }
  db.prepare('UPDATE users SET role = COALESCE(?, role), title = COALESCE(?, title) WHERE id = ?')
    .run(role === 'admin' || role === 'member' ? role : null, title ?? null, target.id);

  req.app.get('io')?.emit('directory:changed');
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

// Deactivate ("delete") — reversible, preserves all their tasks/messages/history.
router.post('/users/:id/deactivate', (req, res) => {
  const target = wsUser(req);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  if (target.role === 'admin' && lastActiveAdmin(target.id, req.workspaceId)) {
    return res.status(400).json({ error: 'Cannot deactivate the only remaining admin' });
  }
  db.prepare(`UPDATE users SET active = 0, deactivated_at = datetime('now') WHERE id = ?`).run(target.id);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('directory:changed');
  // Boot any live sessions belonging to the deactivated user.
  req.app.get('io')?.to(`user:${target.id}`).emit('account:deactivated');
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

router.post('/users/:id/reactivate', (req, res) => {
  const target = wsUser(req);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.deleted) return res.status(400).json({ error: 'A deleted account cannot be restored' });
  db.prepare('UPDATE users SET active = 1, deactivated_at = NULL WHERE id = ?').run(target.id);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('directory:changed');
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

// Permanently delete an account. Only allowed after it has been deactivated
// for the full grace period. The person can never log in again (password
// cleared, removed from every channel), but the row and their content stay so
// the admin keeps a complete record.
router.post('/users/:id/delete', (req, res) => {
  const target = wsUser(req);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (target.deleted) return res.status(400).json({ error: 'This account is already deleted' });
  if (target.active || !target.deactivated_at) {
    return res.status(400).json({ error: 'Deactivate the account first, then delete it after the grace period.' });
  }
  const days = daysSince(target.deactivated_at);
  if (days < DELETE_GRACE_DAYS) {
    return res.status(400).json({ error: `This account can be permanently deleted ${DELETE_GRACE_DAYS - days} more day(s) from now (${DELETE_GRACE_DAYS}-day safety window).` });
  }
  if (target.role === 'admin' && lastActiveAdmin(target.id, req.workspaceId)) {
    return res.status(400).json({ error: 'Cannot delete the only remaining admin' });
  }
  const purge = db.transaction(() => {
    // Their login is gone for good, and they leave every conversation…
    db.prepare(`UPDATE users SET deleted = 1, active = 0, password_hash = '' WHERE id = ?`).run(target.id);
    db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(target.id);
    // …but their tasks, messages and files stay attributed to their record.
  });
  purge();
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('directory:changed');
  req.app.get('io')?.to(`user:${target.id}`).emit('account:deactivated'); // boot any live session
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

// Whole days elapsed since a SQLite UTC timestamp.
function daysSince(ts) {
  const then = db.prepare('SELECT (julianday(?) ) AS j').get(ts).j;
  const now = db.prepare(`SELECT julianday('now') AS j`).get().j;
  return Math.floor(now - then);
}

// Reset a teammate's password (e.g. they're locked out).
router.post('/users/:id/reset-password', (req, res) => {
  const target = wsUser(req);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), target.id);
  res.json({ ok: true });
});

// --- File archive (deleted files) — admin oversight ---

// Every file a teammate has deleted, still recoverable.
router.get('/files/archived', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.archived_at,
           up.name AS uploader_name, up.avatar_color AS uploader_color,
           del.name AS deleted_by_name
    FROM attachments a
    JOIN users up ON up.id = a.uploader_id
    LEFT JOIN users del ON del.id = a.archived_by
    WHERE a.archived_at IS NOT NULL AND a.workspace_id = ?
    ORDER BY a.archived_at DESC
  `).all(req.workspaceId);
  res.json({ files: rows });
});

// Restore an archived file back into chat / Files.
router.post('/files/:id/restore', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  db.prepare('UPDATE attachments SET archived_at = NULL, archived_by = NULL WHERE id = ?').run(att.id);
  if (att.message_id) {
    const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(att.message_id);
    if (msg) req.app.get('io')?.to(`channel:${msg.channel_id}`).emit('message:updated', { message: serializeMessage(att.message_id, null) });
  }
  if (att.is_drive) req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
});

// Permanently remove an archived file (from disk too).
router.delete('/files/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  try { fs.unlinkSync(path.join(uploadDir, att.stored_name)); } catch { /* already gone */ }
  res.json({ ok: true });
});

// --- Workspace settings (this admin's own workspace) ---

// Signup policy + the shareable join link for this workspace.
router.get('/settings', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  res.json({
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    allowed_signup_domains: ws.allowed_signup_domains || '',
    guest_count: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'guest' AND workspace_id = ?`).get(req.workspaceId).n,
  });
});

// Update this workspace's allowed signup domains (comma/space separated).
router.patch('/settings', (req, res) => {
  const { allowed_signup_domains, workspace_name } = req.body;
  if (allowed_signup_domains !== undefined) {
    const cleaned = String(allowed_signup_domains)
      .split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean).join(', ');
    db.prepare('UPDATE workspaces SET allowed_signup_domains = ? WHERE id = ?').run(cleaned, req.workspaceId);
  }
  if (workspace_name !== undefined && String(workspace_name).trim()) {
    db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(String(workspace_name).trim(), req.workspaceId);
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  res.json({ workspace: { id: ws.id, name: ws.name, slug: ws.slug }, allowed_signup_domains: ws.allowed_signup_domains || '' });
});

// True when `excludingId` is the only active admin left IN THIS WORKSPACE.
function lastActiveAdmin(excludingId, workspaceId) {
  const others = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND workspace_id = ? AND id != ?`)
    .get(workspaceId, excludingId).n;
  return others === 0;
}

export default router;
