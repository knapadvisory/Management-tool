import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

function formatTime(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function TaskChat({ taskId, user }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef(null);

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

  function send(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    getSocket()?.emit('task:chat:send', { task_id: taskId, content });
    setDraft('');
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
                <div className="tc-text">{m.content}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <form className="tc-composer" onSubmit={send}>
        <input value={draft} placeholder="Message about this task…" onChange={(e) => setDraft(e.target.value)} />
        <button className="btn btn-primary" disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  );
}
