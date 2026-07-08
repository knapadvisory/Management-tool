import { Router } from 'express';
import db from '../db.js';
import { serializeNotification, unreadCount } from '../notifications.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json({ notifications: rows.map(serializeNotification), unread_count: unreadCount(req.user.id) });
});

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
  res.json({ unread_count: 0 });
});

router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ unread_count: unreadCount(req.user.id) });
});

export default router;
