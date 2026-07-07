import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();

function channelWithMeta(channel, userId) {
  const members = db.prepare(`
    SELECT u.* FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ?
  `).all(channel.id).map(publicUser);
  const out = { ...channel, members };
  if (channel.is_dm) {
    const other = members.find((m) => m.id !== userId) || members[0];
    out.display_name = other ? other.name : 'Direct message';
    out.dm_user = other;
  } else {
    out.display_name = channel.name;
  }
  return out;
}

// Channels the current user belongs to, plus public channels they can join.
router.get('/', (req, res) => {
  const mine = db.prepare(`
    SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
    WHERE cm.user_id = ? ORDER BY c.is_dm, c.name
  `).all(req.user.id);
  const joinable = db.prepare(`
    SELECT c.* FROM channels c
    WHERE c.is_dm = 0 AND c.is_private = 0
      AND c.id NOT IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
    ORDER BY c.name
  `).all(req.user.id);
  res.json({
    channels: mine.map((c) => channelWithMeta(c, req.user.id)),
    joinable: joinable.map((c) => channelWithMeta(c, req.user.id)),
  });
});

router.post('/', (req, res) => {
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
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel || channel.is_dm) return res.status(404).json({ error: 'Channel not found' });
  if (channel.is_private) return res.status(403).json({ error: 'This channel is private' });
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channel.id, req.user.id);
  res.json(channelWithMeta(channel, req.user.id));
});

router.get('/:id/messages', (req, res) => {
  const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Not a member of this channel' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const messages = db.prepare(`
    SELECT m.*, u.name AS user_name, u.avatar_color FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.id < ?
    ORDER BY m.id DESC LIMIT 50
  `).all(req.params.id, before).reverse();
  res.json({ messages });
});

// Open (or find) a DM channel with another user.
router.post('/dm/:userId', (req, res) => {
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
