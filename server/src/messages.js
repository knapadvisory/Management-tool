import db from './db.js';

/**
 * Shared message serialization used by both the REST routes and the
 * socket layer, so every client sees the same shape: author info,
 * attachments, grouped reactions, mention list, and reply count.
 */
export function serializeMessage(id, currentUserId = null) {
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
