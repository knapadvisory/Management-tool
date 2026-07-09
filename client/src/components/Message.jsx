import React, { useState } from 'react';
import { api, fileUrl } from '../api.js';
import { renderMarkdown, formatBytes } from '../format.js';
import Avatar from './Avatar.jsx';
import ForwardModal from './ForwardModal.jsx';
import TaskFromMessageModal from './TaskFromMessageModal.jsx';

const QUICK_EMOJIS = ['👍', '❤️', '😄', '🎉', '✅', '👀', '🙏'];

function formatTime(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AttachmentView({ att }) {
  const url = fileUrl(att.id);
  if (att.mime_type?.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="attach-image-link">
        <img src={url} alt={att.original_name} className="attach-image" />
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="attach-file">
      <span className="attach-file-icon">📄</span>
      <span className="attach-file-meta">
        <span className="attach-file-name">{att.original_name}</span>
        <span className="muted">{formatBytes(att.size)}</span>
      </span>
    </a>
  );
}

export default function Message({ message, currentUser, channelId, grouped, onOpenThread, inThread }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [showPicker, setShowPicker] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const isMine = message.user_id === currentUser.id;
  const base = `/channels/${channelId}/messages/${message.id}`;

  async function toggleReaction(emoji, mine) {
    try {
      if (mine) await api(`${base}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
      else await api(`${base}/reactions`, { method: 'POST', body: { emoji } });
    } catch (e) { /* another client's update will reconcile */ }
    setShowPicker(false);
  }

  async function saveEdit() {
    const content = draft.trim();
    if (!content || content === message.content) { setEditing(false); return; }
    await api(base, { method: 'PATCH', body: { content } });
    setEditing(false);
  }

  async function remove() {
    if (!confirm('Delete this message?')) return;
    await api(base, { method: 'DELETE' });
  }

  if (message.is_deleted) {
    return (
      <div className={`message ${grouped ? 'grouped' : ''}`}>
        {!grouped && <span className="msg-gutter" />}
        <div className="message-body">
          <div className="message-text deleted">This message was deleted</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`message ${grouped ? 'grouped' : ''}`}>
      {grouped ? (
        <span className="msg-gutter"><span className="gutter-time">{formatTime(message.created_at)}</span></span>
      ) : (
        <Avatar user={{ name: message.user_name, avatar_color: message.avatar_color }} size={36} />
      )}
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <strong>{message.user_name}</strong>
            <span className="message-time">{formatTime(message.created_at)}</span>
          </div>
        )}

        {editing ? (
          <div className="edit-box">
            <textarea value={draft} rows={2} autoFocus onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') setEditing(false); }} />
            <div className="edit-actions">
              <button className="btn btn-primary" onClick={saveEdit}>Save</button>
              <button className="btn" onClick={() => { setDraft(message.content); setEditing(false); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            {message.content && (
              <div className="message-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content, message.mentions) }} />
            )}
            {message.edited_at && <span className="edited-tag">(edited)</span>}
          </>
        )}

        {message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((a) => <AttachmentView key={a.id} att={a} />)}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((r) => {
              const mine = (r.user_ids || []).includes(currentUser.id);
              return (
                <button
                  key={r.emoji}
                  className={`reaction ${mine ? 'mine' : ''}`}
                  onClick={() => toggleReaction(r.emoji, mine)}
                >
                  {r.emoji} {r.count}
                </button>
              );
            })}
          </div>
        )}

        {!inThread && message.reply_count > 0 && (
          <button className="thread-summary" onClick={() => onOpenThread(message)}>
            💬 {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>

      {!editing && (
        <div className="msg-actions">
          <div className="react-wrap">
            <button className="msg-action" title="Add reaction" onClick={() => setShowPicker((s) => !s)}>😊</button>
            {showPicker && (
              <div className="emoji-picker" onMouseLeave={() => setShowPicker(false)}>
                {QUICK_EMOJIS.map((e) => (
                  <button key={e} onClick={() => toggleReaction(e, (message.reactions.find((r) => r.emoji === e)?.user_ids || []).includes(currentUser.id))}>{e}</button>
                ))}
              </div>
            )}
          </div>
          <div className="menu-wrap">
            <button className="msg-action" title="More" onClick={() => setMenuOpen((o) => !o)}>⋯</button>
            {menuOpen && (
              <div className="msg-menu" onMouseLeave={() => setMenuOpen(false)}>
                {!inThread && <button onClick={() => { onOpenThread(message); setMenuOpen(false); }}><span>↩</span> Reply</button>}
                <button onClick={() => { navigator.clipboard?.writeText(message.content || ''); setMenuOpen(false); }}><span>⧉</span> Copy</button>
                {isMine && <button onClick={() => { setDraft(message.content); setEditing(true); setMenuOpen(false); }}><span>✏️</span> Edit</button>}
                <button onClick={() => { setForwardOpen(true); setMenuOpen(false); }}><span>➦</span> Forward</button>
                <button onClick={() => { setTaskOpen(true); setMenuOpen(false); }}><span>☑</span> Create task</button>
                {isMine && <button className="danger" onClick={() => { setMenuOpen(false); remove(); }}><span>🗑</span> Delete</button>}
              </div>
            )}
          </div>
        </div>
      )}

      {forwardOpen && <ForwardModal message={message} onClose={() => setForwardOpen(false)} />}
      {taskOpen && <TaskFromMessageModal message={message} onClose={() => setTaskOpen(false)} />}
    </div>
  );
}
