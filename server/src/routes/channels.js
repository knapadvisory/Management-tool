import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';
import { serializeMessage, isChannelMember } from '../messages.js';

const router = Router();

function channelWithMeta(channel, userId) {
  const members = db.prepare(`
    SELECT u.*, cm.role AS channel_role FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ?
  `).all(channel.id).map((m) => ({ ...publicUser(m), channel_role: m.channel_role || 'member' }));
  const out = { ...channel, members, owner_id: channel.created_by };
  if (channel.is_dm) {
    const other = members.find((m) => m.id !== userId) || members[0];
    out.display_name = other ? other.name : 'Direct message';
    out.dm_user = other;
  } else {
    out.display_name = channel.name;
  }
  // Latest top-level message, for conversation-list previews and ordering.
  const last = db.prepare(`
    SELECT m.content, m.created_at, m.deleted_at, u.name AS user_name
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.parent_id IS NULL
    ORDER BY m.id DESC LIMIT 1
  `).get(channel.id);
  out.last_message = last
    ? { content: last.deleted_at ? '(message deleted)' : last.content, created_at: last.created_at, user_name: last.user_name }
    : null;
  out.last_activity = last ? last.created_at : channel.created_at;
  return out;
}

// Guests live only in their collab chats — they get no public/DM channels
// and cannot create, join, or open new ones.
const isGuest = (req) => req.user?.role === 'guest';

// Channels the current user belongs to, plus public channels they can join.
router.get('/', (req, res) => {
  if (isGuest(req)) return res.json({ channels: [], joinable: [] });
  const mine = db.prepare(`
    SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
    WHERE cm.user_id = ? AND c.is_collab = 0 ORDER BY c.is_dm, c.name
  `).all(req.user.id);
  const joinable = db.prepare(`
    SELECT c.* FROM channels c
    WHERE c.is_dm = 0 AND c.is_private = 0 AND c.is_collab = 0
      AND c.id NOT IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
    ORDER BY c.name
  `).all(req.user.id);
  res.json({
    channels: mine.map((c) => channelWithMeta(c, req.user.id)),
    joinable: joinable.map((c) => channelWithMeta(c, req.user.id)),
  });
});

router.post('/', (req, res) => {
  if (isGuest(req)) return res.status(403).json({ error: 'Guests cannot create channels' });
  const { name, description = '', is_private = false, member_ids = [] } = req.body;
  const clean = (name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  if (!clean) return res.status(400).json({ error: 'Channel name is required' });
  if (db.prepare('SELECT id FROM channels WHERE name = ? AND is_dm = 0').get(clean)) {
    return res.status(409).json({ error: 'A channel with this name already exists' });
  }
  const info = db.prepare('INSERT INTO channels (name, description, is_private, created_by) VALUES (?, ?, ?, ?)')
    .run(clean, description, is_private ? 1 : 0, req.user.id);
  const addMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  addMember.run(info.lastInsertRowid, req.user.id);
  for (const uid of member_ids) addMember.run(info.lastInsertRowid, uid);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(channelWithMeta(channel, req.user.id));
});

router.post('/:id/join', (req, res) => {
  if (isGuest(req)) return res.status(403).json({ error: 'Guests cannot join channels' });
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel || channel.is_dm) return res.status(404).json({ error: 'Channel not found' });
  if (channel.is_private) return res.status(403).json({ error: 'This channel is private' });
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channel.id, req.user.id);
  res.json(channelWithMeta(channel, req.user.id));
});

// Top-level channel messages (thread replies are fetched separately).
router.get('/:id/messages', (req, res) => {
  if (!isChannelMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  // In a collab where history isn't shared, members only see messages from
  // after they joined.
  const channel = db.prepare('SELECT is_collab, history_visible FROM channels WHERE id = ?').get(req.params.id);
  let since = null;
  if (channel?.is_collab && !channel.history_visible) {
    const m = db.prepare('SELECT joined_at FROM channel_members WHERE channel_id = ? AND user_id = ?').get(req.params.id, req.user.id);
    since = m?.joined_at || null;
  }
  const rows = db.prepare(`
    SELECT id FROM messages
    WHERE channel_id = ? AND parent_id IS NULL AND id < ?
      AND (? IS NULL OR created_at >= ?)
    ORDER BY id DESC LIMIT 50
  `).all(req.params.id, before, since, since).reverse();
  res.json({ messages: rows.map((r) => serializeMessage(r.id, req.user.id)) });
});

// Replies within a thread, plus the root message.
router.get('/:id/messages/:msgId/thread', (req, res) => {
  if (!isChannelMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }
  const root = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?')
    .get(req.params.msgId, req.params.id);
  if (!root) return res.status(404).json({ error: 'Message not found' });
  const replies = db.prepare('SELECT id FROM messages WHERE parent_id = ? ORDER BY id').all(root.id);
  res.json({
    root: serializeMessage(root.id, req.user.id),
    replies: replies.map((r) => serializeMessage(r.id, req.user.id)),
  });
});

function loadOwnedMessage(req, res) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?')
    .get(req.params.msgId, req.params.id);
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return null; }
  if (!isChannelMember(req.params.id, req.user.id)) {
    res.status(403).json({ error: 'Not a member of this channel' }); return null;
  }
  return msg;
}

router.patch('/:id/messages/:msgId', (req, res) => {
  const msg = loadOwnedMessage(req, res);
  if (!msg) return;
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (msg.deleted_at) return res.status(400).json({ error: 'Message was deleted' });
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message cannot be empty' });
  db.prepare(`UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?`).run(content, msg.id);
  const message = serializeMessage(msg.id, req.user.id);
  req.app.get('io')?.to(`channel:${msg.channel_id}`).emit('message:updated', { message });
  res.json(message);
});

router.delete('/:id/messages/:msgId', (req, res) => {
  const msg = loadOwnedMessage(req, res);
  if (!msg) return;
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare(`UPDATE messages SET deleted_at = datetime('now') WHERE id = ?`).run(msg.id);
  db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(msg.id);
  const message = serializeMessage(msg.id, req.user.id);
  req.app.get('io')?.to(`channel:${msg.channel_id}`).emit('message:updated', { message });
  res.json(message);
});

router.post('/:id/messages/:msgId/reactions', (req, res) => {
  const msg = loadOwnedMessage(req, res);
  if (!msg) return;
  const emoji = (req.body.emoji || '').trim();
  if (!emoji || emoji.length > 16) return res.status(400).json({ error: 'Invalid emoji' });
  db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)')
    .run(msg.id, req.user.id, emoji);
  broadcastReactions(req, msg);
  res.json(serializeMessage(msg.id, req.user.id));
});

router.delete('/:id/messages/:msgId/reactions/:emoji', (req, res) => {
  const msg = loadOwnedMessage(req, res);
  if (!msg) return;
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .run(msg.id, req.user.id, decodeURIComponent(req.params.emoji));
  broadcastReactions(req, msg);
  res.json(serializeMessage(msg.id, req.user.id));
});

function broadcastReactions(req, msg) {
  // Broadcast without a "mine" flag; each client recomputes its own.
  req.app.get('io')?.to(`channel:${msg.channel_id}`).emit('message:updated', {
    message: serializeMessage(msg.id, null),
  });
}

// Open (or find) a DM channel with another user.
router.post('/dm/:userId', (req, res) => {
  if (isGuest(req)) return res.status(403).json({ error: 'Guests cannot start direct messages' });
  const otherId = Number(req.params.userId);
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  if (otherId === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  const existing = db.prepare(`
    SELECT c.* FROM channels c
    WHERE c.is_dm = 1
      AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
      AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
  `).get(req.user.id, otherId);
  if (existing) return res.json(channelWithMeta(existing, req.user.id));

  const info = db.prepare(`INSERT INTO channels (name, is_dm, is_private, created_by) VALUES (?, 1, 1, ?)`)
    .run(`dm-${req.user.id}-${otherId}`, req.user.id);
  const addMember = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  addMember.run(info.lastInsertRowid, req.user.id);
  addMember.run(info.lastInsertRowid, otherId);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(channelWithMeta(channel, req.user.id));
});

export default router;
