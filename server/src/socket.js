import db from './db.js';
import { verifyToken, publicUser } from './auth.js';
import { serializeMessage, recordMentions, linkAttachments } from './messages.js';
import { createNotification } from './notifications.js';

// userId -> Set of socket ids (a user can have multiple tabs open)
const onlineUsers = new Map();

export default function setupSocket(io) {
  io.use((socket, next) => {
    try {
      const payload = verifyToken(socket.handshake.auth?.token);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
      if (!user) return next(new Error('Unknown user'));
      if (!user.active) return next(new Error('Account deactivated'));
      socket.user = user;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;

    socket.join(`user:${userId}`);
    const channels = db.prepare('SELECT channel_id FROM channel_members WHERE user_id = ?').all(userId);
    for (const { channel_id } of channels) socket.join(`channel:${channel_id}`);

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    io.emit('presence', { online_user_ids: [...onlineUsers.keys()] });

    socket.on('channel:subscribe', (channelId) => {
      const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .get(channelId, userId);
      if (member) socket.join(`channel:${channelId}`);
    });

    socket.on('message:send', ({ channel_id, content, parent_id = null, attachment_ids = [], mention_user_ids = [] }, ack) => {
      content = (content || '').trim();
      const hasFiles = Array.isArray(attachment_ids) && attachment_ids.length > 0;
      if (!content && !hasFiles) return ack?.({ error: 'Empty message' });
      const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .get(channel_id, userId);
      if (!member) return ack?.({ error: 'Not a member of this channel' });

      // A reply must point at a real message in the same channel.
      if (parent_id) {
        const parent = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(parent_id, channel_id);
        if (!parent) return ack?.({ error: 'Thread parent not found' });
      }

      const info = db.prepare('INSERT INTO messages (channel_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)')
        .run(channel_id, userId, content, parent_id);
      const messageId = info.lastInsertRowid;
      linkAttachments(messageId, userId, attachment_ids);
      const notified = recordMentions(messageId, channel_id, mention_user_ids);

      const message = serializeMessage(messageId, null);
      io.to(`channel:${channel_id}`).emit('message:new', { message });

      // If this is a reply, nudge the channel to refresh the root's reply count.
      if (parent_id) {
        io.to(`channel:${channel_id}`).emit('message:updated', { message: serializeMessage(parent_id, null) });
      }

      // Notify mentioned users who aren't the author.
      for (const uid of notified) {
        if (uid !== userId) {
          io.to(`user:${uid}`).emit('mention', {
            channel_id,
            message_id: messageId,
            from: publicUser(socket.user),
            preview: content.slice(0, 120),
          });
          createNotification(io, {
            user_id: uid, type: 'mention', actor_id: userId, channel_id,
            text: `${socket.user.name} mentioned you: "${content.slice(0, 80)}"`,
          });
        }
      }
      ack?.({ message: serializeMessage(messageId, userId) });
    });

    // --- Per-task real-time chat ---
    socket.on('task:chat:join', (taskId) => {
      if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) socket.join(`taskchat:${taskId}`);
    });
    socket.on('task:chat:leave', (taskId) => socket.leave(`taskchat:${taskId}`));
    socket.on('task:chat:send', ({ task_id, content }, ack) => {
      content = (content || '').trim();
      if (!content) return ack?.({ error: 'Empty message' });
      const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(task_id);
      if (!task) return ack?.({ error: 'Task not found' });

      const info = db.prepare('INSERT INTO task_messages (task_id, user_id, content) VALUES (?, ?, ?)')
        .run(task_id, userId, content);
      db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(task_id, userId);
      const message = db.prepare(`
        SELECT tm.*, u.name AS user_name, u.avatar_color FROM task_messages tm
        JOIN users u ON u.id = tm.user_id WHERE tm.id = ?
      `).get(info.lastInsertRowid);
      io.to(`taskchat:${task_id}`).emit('task:chat:new', { message });

      // Notify other watchers of the new chat message.
      const watchers = db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task_id);
      for (const { user_id } of watchers) {
        if (user_id !== userId) {
          createNotification(io, {
            user_id, type: 'task_chat', actor_id: userId, task_id,
            text: `${socket.user.name} in "${task.title}": ${content.slice(0, 80)}`,
          });
        }
      }
      ack?.({ message });
    });

    socket.on('typing', ({ channel_id }) => {
      socket.to(`channel:${channel_id}`).emit('typing', { channel_id, user: publicUser(socket.user) });
    });

    // --- WebRTC call signaling (1:1). The server only relays; media is peer-to-peer. ---
    socket.on('call:invite', ({ to_user_id, call_type }) => {
      io.to(`user:${to_user_id}`).emit('call:incoming', {
        from: publicUser(socket.user),
        call_type: call_type === 'video' ? 'video' : 'audio',
      });
    });
    socket.on('call:accept', ({ to_user_id }) => {
      io.to(`user:${to_user_id}`).emit('call:accepted', { from: publicUser(socket.user) });
    });
    socket.on('call:reject', ({ to_user_id }) => {
      io.to(`user:${to_user_id}`).emit('call:rejected', { from: publicUser(socket.user) });
    });
    socket.on('call:signal', ({ to_user_id, data }) => {
      io.to(`user:${to_user_id}`).emit('call:signal', { from_user_id: userId, data });
    });
    socket.on('call:end', ({ to_user_id }) => {
      io.to(`user:${to_user_id}`).emit('call:ended', { from: publicUser(socket.user) });
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) onlineUsers.delete(userId);
      }
      io.emit('presence', { online_user_ids: [...onlineUsers.keys()] });
    });
  });
}
