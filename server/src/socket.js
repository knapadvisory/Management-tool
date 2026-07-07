import db from './db.js';
import { verifyToken, publicUser } from './auth.js';

// userId -> Set of socket ids (a user can have multiple tabs open)
const onlineUsers = new Map();

export default function setupSocket(io) {
  io.use((socket, next) => {
    try {
      const payload = verifyToken(socket.handshake.auth?.token);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
      if (!user) return next(new Error('Unknown user'));
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

    socket.on('message:send', ({ channel_id, content }, ack) => {
      content = (content || '').trim();
      if (!content) return ack?.({ error: 'Empty message' });
      const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .get(channel_id, userId);
      if (!member) return ack?.({ error: 'Not a member of this channel' });
      const info = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)')
        .run(channel_id, userId, content);
      const message = db.prepare(`
        SELECT m.*, u.name AS user_name, u.avatar_color FROM messages m
        JOIN users u ON u.id = m.user_id WHERE m.id = ?
      `).get(info.lastInsertRowid);
      io.to(`channel:${channel_id}`).emit('message:new', { message });
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
