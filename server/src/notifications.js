import db from './db.js';
import { publicUser } from './auth.js';

export function serializeNotification(n) {
  const actor = n.actor_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(n.actor_id) : null;
  return { ...n, is_read: !!n.is_read, actor: publicUser(actor) };
}

export function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;
}

/**
 * Persist a notification for one user and push it live via socket.
 * Never notifies the actor about their own action.
 */
export function createNotification(io, { user_id, type, actor_id = null, task_id = null, channel_id = null, text }) {
  if (!user_id || user_id === actor_id) return null;
  const info = db.prepare(`
    INSERT INTO notifications (user_id, type, actor_id, task_id, channel_id, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user_id, type, actor_id, task_id, channel_id, text);
  const notification = serializeNotification(db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid));
  io?.to(`user:${user_id}`).emit('notification:new', { notification, unread_count: unreadCount(user_id) });
  return notification;
}
