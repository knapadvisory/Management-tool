import { randomUUID } from 'crypto';
import db from './db.js';
import { verifyToken, publicUser } from './auth.js';
import { serializeMessage, recordMentions, linkAttachments, serializeTaskMessage, linkTaskMessageAttachments } from './messages.js';
import { createNotification } from './notifications.js';

// userId -> Set of socket ids (a user can have multiple tabs open)
const onlineUsers = new Map();

// --- Multi-party call rooms (huddles / conferences) ---
// A "room" is a live group call. Media flows peer-to-peer in a mesh; the server
// only tracks who is in each room and relays WebRTC signaling between them.
//   roomId -> { kind, collab_id, call_type, by, members: Map<userId,{user,socketIds}> }
// Collab huddles use roomId `collab:<channelId>` (one per space); ad-hoc
// conferences use a random `conf:<uuid>` that acts as a join capability.
const callRooms = new Map();
const MAX_ROOM = 8; // mesh WebRTC stays comfortable up to ~8 participants

function roomPeers(room) {
  return [...room.members.values()].map((m) => m.user);
}

// Remove one socket from a room; when the user has no sockets left in it, they
// have truly left (announce it), and an empty room is torn down.
function leaveCallRoom(io, socket, roomId) {
  const room = callRooms.get(roomId);
  if (!room) return;
  const member = room.members.get(socket.user.id);
  if (member) {
    member.socketIds.delete(socket.id);
    if (member.socketIds.size === 0) {
      room.members.delete(socket.user.id);
      socket.to(`callroom:${roomId}`).emit('call:room:peer-left', { room_id: roomId, user_id: socket.user.id });
    }
  }
  socket.leave(`callroom:${roomId}`);
  socket.data.callRooms?.delete(roomId);
  if (room.members.size === 0) {
    callRooms.delete(roomId);
    if (room.kind === 'collab' && room.collab_id) {
      io.to(`channel:${room.collab_id}`).emit('call:room:ended', { room_id: roomId, collab_id: room.collab_id });
    }
  }
}

// Presence is per-workspace: broadcast only the online users who belong to the
// given workspace, and only to that workspace's room.
function emitPresence(io, workspaceId) {
  if (!workspaceId) return;
  const onlineIds = [...onlineUsers.keys()];
  let ids = [];
  if (onlineIds.length) {
    const placeholders = onlineIds.map(() => '?').join(',');
    ids = db.prepare(`SELECT id FROM users WHERE workspace_id = ? AND id IN (${placeholders})`)
      .all(workspaceId, ...onlineIds).map((r) => r.id);
  }
  io.to(`workspace:${workspaceId}`).emit('presence', { online_user_ids: ids });
}

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
    socket.join(`workspace:${socket.user.workspace_id}`);
    const channels = db.prepare('SELECT channel_id FROM channel_members WHERE user_id = ?').all(userId);
    for (const { channel_id } of channels) socket.join(`channel:${channel_id}`);

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    emitPresence(io, socket.user.workspace_id);

    socket.on('channel:subscribe', (channelId) => {
      const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .get(channelId, userId);
      if (member) socket.join(`channel:${channelId}`);
    });

    socket.on('message:send', ({ channel_id, content, parent_id = null, attachment_ids = [], mention_user_ids = [] }, ack) => {
      content = (content || '').trim();
      const hasFiles = Array.isArray(attachment_ids) && attachment_ids.length > 0;
      if (!content && !hasFiles) return ack?.({ error: 'Empty message' });
      const member = db.prepare('SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .get(channel_id, userId);
      if (!member) return ack?.({ error: 'Not a member of this channel' });

      // In a collab restricted to moderators, only owner/moderators may post.
      const chan = db.prepare('SELECT is_collab, is_dm, who_can_post, workspace_id FROM channels WHERE id = ?').get(channel_id);
      if (chan?.is_collab && chan.who_can_post === 'mods' && !['owner', 'moderator'].includes(member.role)) {
        return ack?.({ error: 'Only moderators can post in this collab' });
      }

      // A reply must point at a real message in the same channel.
      if (parent_id) {
        const parent = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(parent_id, channel_id);
        if (!parent) return ack?.({ error: 'Thread parent not found' });
      }

      const info = db.prepare('INSERT INTO messages (channel_id, user_id, content, parent_id, workspace_id) VALUES (?, ?, ?, ?, ?)')
        .run(channel_id, userId, content, parent_id, chan?.workspace_id);
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

      // Direct messages surface in the recipient's Activity feed (skip anyone
      // already notified via an @mention, and thread replies).
      if (chan?.is_dm && !parent_id) {
        const others = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ?').all(channel_id, userId);
        for (const { user_id } of others) {
          if (!notified.includes(user_id)) {
            createNotification(io, {
              user_id, type: 'dm', actor_id: userId, channel_id,
              text: `${socket.user.name}: ${content ? content.slice(0, 80) : '📎 sent a file'}`,
            });
          }
        }
      } else if (chan && !chan.is_dm && !parent_id) {
        // Group-chat (channel/collab) messages surface under "Chat messages".
        const chName = db.prepare('SELECT name FROM channels WHERE id = ?').get(channel_id)?.name || 'a channel';
        const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ?').all(channel_id, userId);
        for (const { user_id } of members) {
          if (!notified.includes(user_id)) {
            createNotification(io, {
              user_id, type: 'channel_msg', actor_id: userId, channel_id,
              text: `${socket.user.name} in ${chan.is_collab ? '' : '#'}${chName}: ${content ? content.slice(0, 80) : '📎 shared a file'}`,
            });
          }
        }
      }
      ack?.({ message: serializeMessage(messageId, userId) });
    });

    // --- Per-task real-time chat ---
    socket.on('task:chat:join', (taskId) => {
      if (db.prepare('SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, socket.user.workspace_id)) socket.join(`taskchat:${taskId}`);
    });
    socket.on('task:chat:leave', (taskId) => socket.leave(`taskchat:${taskId}`));
    socket.on('task:chat:send', ({ task_id, content, attachment_ids = [] }, ack) => {
      content = (content || '').trim();
      const hasFiles = Array.isArray(attachment_ids) && attachment_ids.length > 0;
      if (!content && !hasFiles) return ack?.({ error: 'Empty message' });
      const task = db.prepare('SELECT id, title FROM tasks WHERE id = ? AND workspace_id = ?').get(task_id, socket.user.workspace_id);
      if (!task) return ack?.({ error: 'Task not found' });

      const info = db.prepare('INSERT INTO task_messages (task_id, user_id, content) VALUES (?, ?, ?)')
        .run(task_id, userId, content);
      const tmId = info.lastInsertRowid;
      if (hasFiles) linkTaskMessageAttachments(tmId, userId, attachment_ids);
      db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(task_id, userId);
      const message = serializeTaskMessage(tmId);
      io.to(`taskchat:${task_id}`).emit('task:chat:new', { message });

      // Notify other watchers of the new chat message.
      const preview = content ? content.slice(0, 80) : '📎 sent a file';
      const watchers = db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task_id);
      for (const { user_id } of watchers) {
        if (user_id !== userId) {
          createNotification(io, {
            user_id, type: 'task_chat', actor_id: userId, task_id,
            text: `${socket.user.name} in "${task.title}": ${preview}`,
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

    // --- Multi-party call rooms (group huddles + ad-hoc conferences) ---

    // Join (or start) a call room. For a collab huddle pass kind:'collab' and
    // target_id; for a conference pass kind:'conference' (omit room_id to start
    // a fresh one, or pass an existing room_id to join). Replies with the
    // current peers so the newcomer can dial out to each of them (mesh).
    socket.on('call:room:join', ({ room_id, kind, target_id, call_type } = {}, ack) => {
      call_type = call_type === 'video' ? 'video' : 'audio';
      const resolvedKind = kind === 'collab' ? 'collab' : 'conference';
      let roomId = room_id;
      let collabId = null;

      if (resolvedKind === 'collab') {
        const cid = Number(target_id);
        const chan = db.prepare('SELECT id, is_collab, workspace_id FROM channels WHERE id = ?').get(cid);
        if (!chan || !chan.is_collab || chan.workspace_id !== socket.user.workspace_id) return ack?.({ error: 'Collab not found' });
        if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(cid, userId)) {
          return ack?.({ error: 'You are not a member of this collab' });
        }
        roomId = `collab:${cid}`;
        collabId = cid;
      } else if (!roomId) {
        roomId = `conf:${randomUUID()}`;
      } else if (!callRooms.has(roomId)) {
        return ack?.({ error: 'This call has already ended' });
      }

      let room = callRooms.get(roomId);
      const isNew = !room;
      if (!room) {
        room = { kind: resolvedKind, collab_id: collabId, call_type, by: publicUser(socket.user), members: new Map() };
        callRooms.set(roomId, room);
      }
      const alreadyIn = room.members.has(userId);
      if (!alreadyIn && room.members.size >= MAX_ROOM) {
        if (isNew) callRooms.delete(roomId);
        return ack?.({ error: `This call is full (max ${MAX_ROOM} people)` });
      }

      const peers = roomPeers(room); // captured before adding self
      if (alreadyIn) room.members.get(userId).socketIds.add(socket.id);
      else room.members.set(userId, { user: publicUser(socket.user), socketIds: new Set([socket.id]) });
      socket.join(`callroom:${roomId}`);
      (socket.data.callRooms ||= new Set()).add(roomId);

      if (!alreadyIn) socket.to(`callroom:${roomId}`).emit('call:room:peer-joined', { room_id: roomId, user: publicUser(socket.user) });
      // Let the whole collab know a huddle is live, so members see a Join banner.
      if (room.kind === 'collab' && isNew) {
        io.to(`channel:${collabId}`).emit('call:room:active', { room_id: roomId, collab_id: collabId, call_type: room.call_type, by: room.by });
      }
      ack?.({ room_id: roomId, kind: room.kind, collab_id: room.collab_id, call_type: room.call_type, peers });
    });

    socket.on('call:room:leave', ({ room_id } = {}) => leaveCallRoom(io, socket, room_id));

    // Relay WebRTC signaling (SDP/ICE) to one specific peer in the same room.
    socket.on('call:room:signal', ({ room_id, to_user_id, data } = {}) => {
      const room = callRooms.get(room_id);
      if (!room || !room.members.has(userId) || !room.members.has(to_user_id)) return;
      io.to(`user:${to_user_id}`).emit('call:room:signal', { room_id, from_user_id: userId, data });
    });

    // Ring a set of teammates into the caller's current room.
    socket.on('call:room:invite', ({ room_id, user_ids = [] } = {}, ack) => {
      const room = callRooms.get(room_id);
      if (!room || !room.members.has(userId)) return ack?.({ error: 'You are not in this call' });
      const title = room.kind === 'collab' && room.collab_id
        ? db.prepare('SELECT name FROM channels WHERE id = ?').get(room.collab_id)?.name || null
        : null;
      for (const targetId of user_ids) {
        if (targetId === userId) continue;
        const target = db.prepare('SELECT id FROM users WHERE id = ? AND workspace_id = ? AND active = 1').get(targetId, socket.user.workspace_id);
        if (!target) continue;
        io.to(`user:${targetId}`).emit('call:room:incoming', {
          room_id, kind: room.kind, collab_id: room.collab_id, call_type: room.call_type,
          from: publicUser(socket.user), title,
        });
      }
      ack?.({ ok: true });
    });

    // Ephemeral in-call chat: relayed to everyone in the room, never stored.
    socket.on('call:room:chat', ({ room_id, text } = {}) => {
      const room = callRooms.get(room_id);
      if (!room || !room.members.has(userId)) return;
      text = (text || '').toString().slice(0, 2000).trim();
      if (!text) return;
      io.to(`callroom:${room_id}`).emit('call:room:chat', { room_id, from: publicUser(socket.user), text, at: Date.now() });
    });

    // A rung teammate declined — let the room know (informational).
    socket.on('call:room:decline', ({ room_id } = {}) => {
      if (callRooms.has(room_id)) io.to(`callroom:${room_id}`).emit('call:room:declined', { room_id, user: publicUser(socket.user) });
    });

    // Is a collab's huddle currently live? Used to show a Join banner on open.
    // Only members of that collab (in the caller's own workspace) may ask.
    socket.on('call:room:status', ({ collab_id } = {}, ack) => {
      const cid = Number(collab_id);
      const chan = db.prepare('SELECT id, is_collab, workspace_id FROM channels WHERE id = ?').get(cid);
      if (!chan || !chan.is_collab || chan.workspace_id !== socket.user.workspace_id
        || !db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(cid, userId)) {
        return ack?.({ active: false });
      }
      const roomId = `collab:${cid}`;
      const room = callRooms.get(roomId);
      ack?.({
        active: !!room,
        room_id: room ? roomId : null,
        call_type: room?.call_type || null,
        peers: room ? roomPeers(room) : [],
      });
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) onlineUsers.delete(userId);
      }
      // Drop this socket from any call rooms it was in (announces a leave once
      // the user's last tab in the room disconnects).
      for (const roomId of [...(socket.data.callRooms || [])]) leaveCallRoom(io, socket, roomId);
      emitPresence(io, socket.user.workspace_id);
    });
  });
}
