import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { publicUser } from '../auth.js';
import { serializeMessage } from '../messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'uploads');

const router = Router();
const AVATAR_COLORS = ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e', '#7c3aed', '#f97316', '#0ea5e9', '#db2777'];

// Every route here is already behind requireAuth + requireAdmin (see index.js).

// Full roster including deactivated accounts, so the admin can supervise everyone.
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY active DESC, name').all().map((u) => ({
    ...publicUser(u),
    created_at: u.created_at,
  }));
  res.json({ users });
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
    'INSERT INTO users (name, email, password_hash, avatar_color, title, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), normalizedEmail, bcrypt.hashSync(password, 10), color, title.trim(), chosenRole);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Everyone joins #general automatically.
  const general = db.prepare(`SELECT id FROM channels WHERE name = 'general' AND is_dm = 0`).get();
  if (general) db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(general.id, user.id);

  req.app.get('io')?.emit('directory:changed');
  res.status(201).json(publicUser(user));
});

// Change role and/or title. Guard against removing the last active admin.
router.patch('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role, title } = req.body;

  if (role && role !== target.role) {
    if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'Invalid role' });
    if (target.role === 'admin' && role === 'member' && lastActiveAdmin(target.id)) {
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
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  if (target.role === 'admin' && lastActiveAdmin(target.id)) {
    return res.status(400).json({ error: 'Cannot deactivate the only remaining admin' });
  }
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(target.id);
  req.app.get('io')?.emit('directory:changed');
  // Boot any live sessions belonging to the deactivated user.
  req.app.get('io')?.to(`user:${target.id}`).emit('account:deactivated');
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

router.post('/users/:id/reactivate', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(target.id);
  req.app.get('io')?.emit('directory:changed');
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

// Reset a teammate's password (e.g. they're locked out).
router.post('/users/:id/reset-password', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
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
    WHERE a.archived_at IS NOT NULL
    ORDER BY a.archived_at DESC
  `).all();
  res.json({ files: rows });
});

// Restore an archived file back into chat / Files.
router.post('/files/:id/restore', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
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
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'File not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  try { fs.unlinkSync(path.join(uploadDir, att.stored_name)); } catch { /* already gone */ }
  res.json({ ok: true });
});

// True when `excludingId` is the only active admin left.
function lastActiveAdmin(excludingId) {
  const others = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`)
    .get(excludingId).n;
  return others === 0;
}

export default router;
