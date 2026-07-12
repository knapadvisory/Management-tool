import React, { useState, useRef } from 'react';
import { api, fileUrl } from '../api.js';
import { renderMarkdown, formatBytes } from '../format.js';
import { localeArg, dateOpts } from '../prefs.js';
import Avatar from './Avatar.jsx';
import ForwardModal from './ForwardModal.jsx';
import TaskFromMessageModal from './TaskFromMessageModal.jsx';
import FilePreviewModal from './FilePreviewModal.jsx';
import EmojiPicker from './EmojiPicker.jsx';

function formatTime(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString(localeArg(), dateOpts({ hour: '2-digit', minute: '2-digit' }));
}

function AttachmentView({ att, onOpen }) {
  const url = fileUrl(att.id);
  if (att.mime_type?.startsWith('image/')) {
    return (
      <button type="button" className="attach-image-link" onClick={onOpen}>
        <img src={url} alt={att.original_name} className="attach-image" />
      </button>
    );
  }
  return (
    <button type="button" className="attach-file" onClick={onOpen}>
      <span className="attach-file-icon">📄</span>
      <span className="attach-file-meta">
        <span className="attach-file-name">{att.original_name}</span>
        <span className="muted">{formatBytes(att.size)}</span>
      </span>
    </button>
  );
}

export default function Message({ message, currentUser, channelId, grouped, onOpenThread, inThread }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [showPicker, setShowPicker] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [forwardOpen, setForwardOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [previewAtt, setPreviewAtt] = useState(null);
  const [pickerPos, setPickerPos] = useState({ top: 0, left: 0 });
  const moreBtnRef = useRef(null);
  const reactBtnRef = useRef(null);
  const isMine = message.user_id === currentUser.id;

  function openPicker() {
    const r = reactBtnRef.current?.getBoundingClientRect();
    if (r) {
      const W = 312, H = 380;
      const left = Math.min(window.innerWidth - W - 8, Math.max(8, r.left));
      const top = Math.min(window.innerHeight - H - 8, r.bottom + 4);
      setPickerPos({ top: Math.max(8, top), left });
    }
    setShowPicker((s) => !s);
  }
  function pickReaction(emoji) {
    const mine = (message.reactions.find((r) => r.emoji === emoji)?.user_ids || []).includes(currentUser.id);
    toggleReaction(emoji, mine);
    setShowPicker(false);
  }
  const hasFiles = (message.attachments || []).length > 0;

  function openMenu() {
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) {
      const W = 190;
      const left = Math.min(window.innerWidth - W - 8, Math.max(8, r.right - W));
      const top = Math.min(window.innerHeight - 340, r.bottom + 4);
      setMenuPos({ top, left });
    }
    setMenuOpen((o) => !o);
  }

  function downloadFiles() {
    for (const a of message.attachments) {
      const link = document.createElement('a');
      link.href = fileUrl(a.id);
      link.download = a.original_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    setMenuOpen(false);
  }
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
      <div className={`message deleted-row ${grouped ? 'grouped' : ''}`}>
        <div className="message-inner">
          <span className="msg-gutter" />
          <div className="message-body">
            <div className="message-text deleted">This message was deleted</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`message ${grouped ? 'grouped' : ''}`}>
      <div className="message-inner">
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
            {message.attachments.map((a) => <AttachmentView key={a.id} att={a} onOpen={() => setPreviewAtt(a)} />)}
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
            <button ref={reactBtnRef} className="msg-action" title="Add reaction" onClick={openPicker}>😊</button>
          </div>
          <div className="menu-wrap">
            <button ref={moreBtnRef} className="msg-action" title="More" onClick={openMenu}>⋯</button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="msg-menu" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}>
                  {!inThread && <button onClick={() => { onOpenThread(message); setMenuOpen(false); }}><span>↩</span> Reply</button>}
                  <button onClick={() => { navigator.clipboard?.writeText(message.content || ''); setMenuOpen(false); }}><span>⧉</span> Copy</button>
                  {isMine && <button onClick={() => { setDraft(message.content); setEditing(true); setMenuOpen(false); }}><span>✏️</span> Edit</button>}
                  <button onClick={() => { setForwardOpen(true); setMenuOpen(false); }}><span>➦</span> Forward</button>
                  <button onClick={() => { setTaskOpen(true); setMenuOpen(false); }}><span>☑</span> Create task</button>
                  {hasFiles && <button onClick={downloadFiles}><span>⬇</span> Download</button>}
                  {isMine && <button className="danger" onClick={() => { setMenuOpen(false); remove(); }}><span>🗑</span> Delete</button>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </div>

      {forwardOpen && <ForwardModal message={message} onClose={() => setForwardOpen(false)} />}
      {taskOpen && <TaskFromMessageModal message={message} onClose={() => setTaskOpen(false)} />}
      {previewAtt && <FilePreviewModal file={previewAtt} onClose={() => setPreviewAtt(null)} />}
      {showPicker && <EmojiPicker position={pickerPos} onPick={pickReaction} onClose={() => setShowPicker(false)} />}
    </div>
  );
}
