import React, { useEffect, useRef, useState } from 'react';
import { api, uploadFiles } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';
import { AttachmentView } from './Message.jsx';
import FilePreviewModal from './FilePreviewModal.jsx';

function formatTime(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function TaskChat({ taskId, user }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState([]); // uploaded-but-unsent attachments
  const [uploading, setUploading] = useState(false);
  const [previewAtt, setPreviewAtt] = useState(null);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    api(`/tasks/${taskId}/chat`).then((d) => setMessages(d.messages));
    const socket = getSocket();
    if (!socket) return;
    socket.emit('task:chat:join', taskId);
    const onNew = ({ message }) => {
      if (message.task_id === taskId) setMessages((m) => (m.some((x) => x.id === message.id) ? m : [...m, message]));
    };
    socket.on('task:chat:new', onNew);
    return () => {
      socket.emit('task:chat:leave', taskId);
      socket.off('task:chat:new', onNew);
    };
  }, [taskId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function onFiles(e) {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(files);
      setPending((p) => [...p, ...uploaded]);
    } catch (err) { alert(err.message); }
    setUploading(false);
  }

  function send(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content && pending.length === 0) return;
    getSocket()?.emit('task:chat:send', { task_id: taskId, content, attachment_ids: pending.map((a) => a.id) });
    setDraft('');
    setPending([]);
  }

  return (
    <div className="task-chat">
      <div className="task-chat-messages">
        {messages.length === 0 && <div className="empty-hint">No messages yet. Start the conversation for this task.</div>}
        {messages.map((m, i) => {
          const grouped = i > 0 && messages[i - 1].user_id === m.user_id;
          return (
            <div key={m.id} className={`tc-message ${grouped ? 'grouped' : ''}`}>
              {!grouped ? <Avatar user={{ name: m.user_name, avatar_color: m.avatar_color }} size={28} /> : <span className="tc-gutter" />}
              <div className="tc-body">
                {!grouped && (
                  <div className="tc-meta"><strong>{m.user_name}</strong><span className="tc-time">{formatTime(m.created_at)}</span></div>
                )}
                {m.content && <div className="tc-text">{m.content}</div>}
                {m.attachments?.length > 0 && (
                  <div className="attachments">
                    {m.attachments.map((a) => <AttachmentView key={a.id} att={a} onOpen={() => setPreviewAtt(a)} />)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {pending.length > 0 && (
        <div className="tc-pending">
          {pending.map((a) => (
            <span key={a.id} className="tc-pending-chip">
              📎 {a.original_name}
              <button type="button" onClick={() => setPending((p) => p.filter((x) => x.id !== a.id))}>✕</button>
            </span>
          ))}
        </div>
      )}

      <form className="tc-composer" onSubmit={send}>
        <button type="button" className="tc-attach" title="Attach a file" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? '⏳' : '📎'}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={onFiles} />
        <input value={draft} placeholder="Message about this task…" onChange={(e) => setDraft(e.target.value)} />
        <button className="btn btn-primary" disabled={!draft.trim() && pending.length === 0}>Send</button>
      </form>

      {previewAtt && <FilePreviewModal file={previewAtt} onClose={() => setPreviewAtt(null)} />}
    </div>
  );
}
