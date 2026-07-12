import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();

// Guests may only read/post in their own collabs — never create or manage.
function blockGuest(req, res, next) {
  if (req.user?.role === 'guest') return res.status(403).json({ error: 'Guests cannot manage collabs' });
  next();
}
const INVITE = ['all', 'mods'];
const POST = ['all', 'mods'];

// A collab, with its members (each carrying a channel role), owner and settings.
export function collabWithMeta(collab, userId) {
  const members = db.prepare(`
    SELECT u.*, cm.role AS channel_role FROM channel_members cm
    JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ?
  `).all(collab.id).map((m) => ({ ...publicUser(m), channel_role: m.channel_role || 'member' }));
  const last = db.prepare(`
    SELECT m.content, m.created_at, m.deleted_at, u.name AS user_name
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.parent_id IS NULL ORDER BY m.id DESC LIMIT 1
  `).get(collab.id);
  const myRole = memberRole(collab.id, userId) || (collab.created_by === userId ? 'owner' : null);
  return {
    ...collab,
    is_dm: 0,
    display_name: collab.name,
    members,
    owner_id: collab.created_by,
    my_role: myRole,
    // Only managers see the raw invite token (anyone with it can join).
    guest_token: ['owner', 'moderator'].includes(myRole) ? (collab.guest_token || null) : undefined,
    has_guests: members.some((m) => m.role === 'guest'),
    last_message: last ? { content: last.deleted_at ? '(message deleted)' : last.content, created_at: last.created_at, user_name: last.user_name } : null,
    last_activity: last ? last.created_at : collab.created_at,
  };
}

function loadCollab(req, res) {
  const c = db.prepare('SELECT * FROM channels WHERE id = ? AND is_collab = 1').get(req.params.id);
  if (!c) { res.status(404).json({ error: 'Collab not found' }); return null; }
  return c;
}
function memberRole(channelId, userId) {
  return db.prepare('SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId)?.role || null;
}
function isMember(channelId, userId) {
  return !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
}
// Owner, a moderator, or a super admin may administer a collab.
export function canManageCollab(collab, user) {
  return user.role === 'admin' || collab.created_by === user.id || memberRole(collab.id, user.id) === 'moderator';
}

// List collabs the current user belongs to.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
    WHERE c.is_collab = 1 AND cm.user_id = ? ORDER BY c.id DESC
  `).all(req.user.id);
  res.json({ collabs: rows.map((c) => collabWithMeta(c, req.user.id)) });
});

router.get('/:id', (req, res) => {
  const collab = loadCollab(req, res);
  if (!collab) return;
  if (!isMember(collab.id, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You are not a member of this collab' });
  }
  res.json({ collab: collabWithMeta(collab, req.user.id) });
});

router.post('/', blockGuest, (req, res) => {
  const {
    name, description = '', member_ids = [], moderator_ids = [],
    history_visible = true, who_can_invite = 'all', who_can_post = 'all',
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Collab name is required' });
  if (!INVITE.includes(who_can_invite) || !POST.includes(who_can_post)) {
    return res.status(400).json({ error: 'Invalid permission setting' });
  }
  const info = db.prepare(`
    INSERT INTO channels (name, description, is_dm, is_private, is_collab, created_by, history_visible, who_can_invite, who_can_post)
    VALUES (?, ?, 0, 1, 1, ?, ?, ?, ?)
  `).run(name.trim(), description, req.user.id, history_visible ? 1 : 0, who_can_invite, who_can_post);
  const collabId = info.lastInsertRowid;

  const add = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)');
  add.run(collabId, req.user.id, 'owner');
  const mods = new Set((moderator_ids || []).map(Number));
  for (const uid of new Set([...member_ids, ...moderator_ids].map(Number))) {
    if (uid === req.user.id) continue;
    if (db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(uid)) {
      add.run(collabId, uid, mods.has(uid) ? 'moderator' : 'member');
    }
  }

  const collab = db.prepare('SELECT * FROM channels WHERE id = ?').get(collabId);
  notifyMembers(req, collab);
  res.status(201).json(collabWithMeta(collab, req.user.id));
});

// Update settings / description / owner / moderators (managers only).
router.patch('/:id', blockGuest, (req, res) => {
  const collab = loadCollab(req, res);
  if (!collab) return;
  if (!canManageCollab(collab, req.user)) return res.status(403).json({ error: 'Only the owner or a moderator can change this collab' });
  const { name, description, history_visible, who_can_invite, who_can_post, owner_id, moderator_ids } = req.body;
  if (who_can_invite !== undefined && !INVITE.includes(who_can_invite)) return res.status(400).json({ error: 'Invalid invite setting' });
  if (who_can_post !== undefined && !POST.includes(who_can_post)) return res.status(400).json({ error: 'Invalid post setting' });

  // Transfer ownership (owner or admin only), keeping roles consistent.
  if (owner_id !== undefined && owner_id !== collab.created_by) {
    if (req.user.role !== 'admin' && req.user.id !== collab.created_by) {
      return res.status(403).json({ error: 'Only the current owner can transfer ownership' });
    }
    if (!isMember(collab.id, owner_id)) return res.status(400).json({ error: 'New owner must be a member' });
    db.prepare(`UPDATE channel_members SET role = 'member' WHERE channel_id = ? AND role = 'owner'`).run(collab.id);
    db.prepare(`UPDATE channel_members SET role = 'owner' WHERE channel_id = ? AND user_id = ?`).run(collab.id, owner_id);
    db.prepare('UPDATE channels SET created_by = ? WHERE id = ?').run(owner_id, collab.id);
  }

  db.prepare(`
    UPDATE channels SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      history_visible = CASE WHEN ? THEN ? ELSE history_visible END,
      who_can_invite = COALESCE(?, who_can_invite),
      who_can_post = COALESCE(?, who_can_post)
    WHERE id = ?
  `).run(
    name?.trim() || null, description ?? null,
    history_visible !== undefined ? 1 : 0, history_visible ? 1 : 0,
    who_can_invite ?? null, who_can_post ?? null, collab.id
  );

  // Replace the moderator set if provided (members named become moderators; the rest revert to member; owner untouched).
  if (Array.isArray(moderator_ids)) {
    const mods = new Set(moderator_ids.map(Number));
    const roster = db.prepare(`SELECT user_id, role FROM channel_members WHERE channel_id = ?`).all(collab.id);
    for (const { user_id, role } of roster) {
      if (role === 'owner') continue;
      const want = mods.has(user_id) ? 'moderator' : 'member';
      if (want !== role) db.prepare('UPDATE channel_members SET role = ? WHERE channel_id = ? AND user_id = ?').run(want, collab.id, user_id);
    }
  }

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(collab.id);
  notifyMembers(req, updated);
  res.json(collabWithMeta(updated, req.user.id));
});

// Generate (or rotate) the guest invite link — managers only.
router.post('/:id/invite', blockGuest, (req, res) => {
  const collab = loadCollab(req, res);
  if (!collab) return;
  if (!canManageCollab(collab, req.user)) return res.status(403).json({ error: 'Only the owner or a moderator can invite guests' });
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE channels SET guest_token = ? WHERE id = ?').run(token, collab.id);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(collab.id);
  res.status(201).json(collabWithMeta(updated, req.user.id));
});

// Revoke the guest invite link — managers only. Existing guests keep access.
router.delete('/:id/invite', blockGuest, (req, res) => {
  const collab = loadCollab(req, res);
  if (!collab) return;
  if (!canManageCollab(collab, req.user)) return res.status(403).json({ error: 'Only the owner or a moderator can revoke invites' });
  db.prepare('UPDATE channels SET guest_token = NULL WHERE id = ?').run(collab.id);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(collab.id);
  res.json(collabWithMeta(updated, req.user.id));
});

// Add members (respects who_can_invite).
router.post('/:id/members', blockGuest, (req, res) => {
  const collab = loadCollab(req, res);
  if (!collab) return;
  const canInvite = canManageCollab(collab, req.user) || (collab.who_can_invite === 'all' && isMember(collab.id, req.user.id));
  if (!canInvite) return res.status(403).json({ error: 'You are not allowed to invite members to this collab' });
  const { user_ids = [] } = req.body;
  const add = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)');
  for (const uid of user_ids.map(Number)) {
    if (db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(uid)) add.run(collab.id, uid, 'member');
  }
  notifyMembers(req, collab);
  res.status(201).json(collabWithMeta(collab, req.user.id));
});

// Remove a member (managers can remove anyone but the owner; anyone can remove themselves).
router.delete('/:id/members/:userId', (req, res) => {
  const collab = loadCollab(req, res);
  if (!collab) return;
  const targetId = Number(req.params.userId);
  const isSelf = targetId === req.user.id;
  if (!isSelf && !canManageCollab(collab, req.user)) return res.status(403).json({ error: 'Only the owner or a moderator can remove members' });
  if (targetId === collab.created_by) return res.status(400).json({ error: 'The owner cannot be removed' });
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(collab.id, targetId);
  notifyMembers(req, collab);
  req.app.get('io')?.to(`user:${targetId}`).emit('collabs:changed');
  res.json(collabWithMeta(collab, req.user.id));
});

// Look up a collab by its guest invite token (public — used by the join page).
export function collabByInviteToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM channels WHERE guest_token = ? AND is_collab = 1').get(token) || null;
}

// Add a freshly-created guest to a collab as a plain member, and nudge the room.
export function addGuestToCollab(io, collab, userId) {
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(collab.id, userId, 'guest');
  if (!io) return;
  for (const { user_id } of db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(collab.id)) {
    io.to(`user:${user_id}`).emit('collabs:changed');
  }
}

// Nudge every current member to refresh (and pick up new membership/rooms).
function notifyMembers(req, collab) {
  const io = req.app.get('io');
  if (!io) return;
  for (const { user_id } of db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(collab.id)) {
    io.to(`user:${user_id}`).emit('collabs:changed');
  }
}

export default router;
