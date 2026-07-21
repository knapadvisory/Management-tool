import db from './db.js';

/**
 * Shared message serialization used by both the REST routes and the
 * socket layer, so every client sees the same shape: author info,
 * attachments, grouped reactions, mention list, and reply count.
 */
// Per-task chat message with its author info and any attached files.
export function serializeTaskMessage(id) {
  const m = db.prepare(`
    SELECT tm.*, u.name AS user_name, u.avatar_color FROM task_messages tm
    JOIN users u ON u.id = tm.user_id WHERE tm.id = ?
  `).get(id);
  if (!m) return null;
  m.attachments = db.prepare(`
    SELECT id, original_name, mime_type, size FROM attachments
    WHERE task_message_id = ? AND archived_at IS NULL ORDER BY id
  `).all(m.id);
  return m;
}

// Attach uploaded files to a task-chat message (only the uploader's own,
// not-yet-linked files). Mirrors linkAttachments for channel messages.
export function linkTaskMessageAttachments(taskMessageId, uploaderId, attachmentIds = []) {
  const link = db.prepare(`
    UPDATE attachments SET task_message_id = ?
    WHERE id = ? AND uploader_id = ? AND message_id IS NULL AND task_id IS NULL AND task_message_id IS NULL
  `);
  for (const aid of attachmentIds) link.run(taskMessageId, aid, uploaderId);
}

// Read/delivered high-water marks for a channel from a sender's point of view:
// the OLDEST read/delivered position among all OTHER members, so a group
// message counts as read only once everyone has read it (like WhatsApp).
// COALESCE(...,'') makes a member who never read/received sort before every
// real timestamp, so MIN doesn't skip their NULL and wrongly report "all read".
export function channelReceipts(channelId, senderId) {
  const row = db.prepare(`
    SELECT MIN(COALESCE(last_read_at, '')) AS read_up_to,
           MIN(COALESCE(last_delivered_at, '')) AS delivered_up_to
    FROM channel_members WHERE channel_id = ? AND user_id != ?
  `).get(channelId, senderId) || {};
  return { read_up_to: row.read_up_to || null, delivered_up_to: row.delivered_up_to || null };
}

export function messageStatus(createdAt, receipts) {
  if (receipts.read_up_to && createdAt <= receipts.read_up_to) return 'read';
  if (receipts.delivered_up_to && createdAt <= receipts.delivered_up_to) return 'delivered';
  return 'sent';
}

// Tell every member of a channel the current receipt marks for THEIR own
// messages (each member's marks exclude themselves), so senders' ticks update
// live. Cheap for small teams; one targeted emit per member.
export function broadcastReceipts(io, channelId) {
  if (!io) return;
  const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channelId);
  for (const { user_id } of members) {
    io.to(`user:${user_id}`).emit('channel:receipts', { channel_id: channelId, ...channelReceipts(channelId, user_id) });
  }
}

export function serializeMessage(id, currentUserId = null, receipts = undefined) {
  const m = db.prepare(`
    SELECT m.*, u.name AS user_name, u.avatar_color, u.role AS user_role
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.id = ?
  `).get(id);
  if (!m) return null;

  const deleted = !!m.deleted_at;
  const attachments = deleted ? [] : db.prepare(`
    SELECT id, original_name, mime_type, size FROM attachments WHERE message_id = ? AND archived_at IS NULL ORDER BY id
  `).all(m.id);

  const reactionRows = db.prepare(`
    SELECT emoji, user_id FROM message_reactions WHERE message_id = ?
  `).all(m.id);
  const byEmoji = new Map();
  for (const r of reactionRows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, { emoji: r.emoji, count: 0, mine: false, user_ids: [] });
    const entry = byEmoji.get(r.emoji);
    entry.count += 1;
    entry.user_ids.push(r.user_id);
    if (r.user_id === currentUserId) entry.mine = true;
  }

  const mentions = db.prepare(`
    SELECT u.id, u.name FROM mentions mn JOIN users u ON u.id = mn.user_id WHERE mn.message_id = ?
  `).all(m.id);

  const replyCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ? AND deleted_at IS NULL').get(m.id).n;
  const lastReply = db.prepare(`
    SELECT MAX(created_at) AS t FROM messages WHERE parent_id = ? AND deleted_at IS NULL
  `).get(m.id).t;

  // Delivery/read tick, only for the viewer's own messages.
  let status;
  if (currentUserId != null && m.user_id === currentUserId && !deleted) {
    status = messageStatus(m.created_at, receipts || channelReceipts(m.channel_id, m.user_id));
  }

  // WhatsApp-style quoted reply: a small preview of the message this one
  // replies to, shown inline above the reply.
  let reply_to = null;
  if (m.parent_id) {
    const p = db.prepare(`
      SELECT p.id, p.content, p.deleted_at, pu.name AS user_name
      FROM messages p JOIN users pu ON pu.id = p.user_id WHERE p.id = ?
    `).get(m.parent_id);
    if (p) reply_to = { id: p.id, user_name: p.user_name, content: p.deleted_at ? '' : (p.content || ''), is_deleted: !!p.deleted_at };
  }

  return {
    id: m.id,
    channel_id: m.channel_id,
    user_id: m.user_id,
    user_name: m.user_name,
    user_role: m.user_role,
    avatar_color: m.avatar_color,
    content: deleted ? '' : m.content,
    parent_id: m.parent_id,
    created_at: m.created_at,
    edited_at: m.edited_at,
    is_deleted: deleted,
    attachments,
    reactions: [...byEmoji.values()],
    mentions,
    reply_count: replyCount,
    last_reply_at: lastReply,
    status,
    reply_to,
  };
}

// Record @mentions supplied by the client, keeping only users who are
// members of the channel. Returns the list of notified user ids.
export function recordMentions(messageId, channelId, mentionUserIds = []) {
  if (!Array.isArray(mentionUserIds) || mentionUserIds.length === 0) return [];
  const insert = db.prepare('INSERT OR IGNORE INTO mentions (message_id, user_id) VALUES (?, ?)');
  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?');
  const notified = [];
  for (const uid of [...new Set(mentionUserIds)]) {
    if (isMember.get(channelId, uid)) {
      insert.run(messageId, uid);
      notified.push(uid);
    }
  }
  return notified;
}

// Attach previously-uploaded, still-unattached files to a message,
// but only files the sender uploaded themselves.
export function linkAttachments(messageId, uploaderId, attachmentIds = []) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return;
  const link = db.prepare(`
    UPDATE attachments SET message_id = ?
    WHERE id = ? AND uploader_id = ? AND message_id IS NULL
  `);
  for (const aid of attachmentIds) link.run(messageId, aid, uploaderId);
}

export function isChannelMember(channelId, userId) {
  return !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
}
