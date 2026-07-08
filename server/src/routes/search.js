import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Full-text-ish search over messages in channels the user belongs to.
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.channel_id,
           u.name AS user_name, u.avatar_color,
           c.name AS channel_name, c.is_dm
    FROM messages m
    JOIN users u ON u.id = m.user_id
    JOIN channels c ON c.id = m.channel_id
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
    WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'
    ORDER BY m.id DESC LIMIT 50
  `).all(req.user.id, like);

  const results = rows.map((r) => {
    let label = `#${r.channel_name}`;
    if (r.is_dm) {
      const other = db.prepare(`
        SELECT u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = ? AND cm.user_id != ? LIMIT 1
      `).get(r.channel_id, req.user.id);
      label = other ? `DM · ${other.name}` : 'Direct message';
    }
    return { ...r, channel_label: label };
  });
  res.json({ results });
});

export default router;
