import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

function formatTime(iso) {
  // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatView({ channel, user, onlineIds }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [typingUser, setTypingUser] = useState(null);
  const bottomRef = useRef(null);
  const typingTimeout = useRef(null);

  useEffect(() => {
    api(`/channels/${channel.id}/messages`).then((d) => setMessages(d.messages));

    const socket = getSocket();
    if (!socket) return;
    const onNew = ({ message }) => {
      if (message.channel_id === channel.id) setMessages((m) => [...m, message]);
    };
    const onTyping = ({ channel_id, user: who }) => {
      if (channel_id !== channel.id || who.id === user.id) return;
      setTypingUser(who.name);
      clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => setTypingUser(null), 2500);
    };
    socket.on('message:new', onNew);
    socket.on('typing', onTyping);
    return () => {
      socket.off('message:new', onNew);
      socket.off('typing', onTyping);
      clearTimeout(typingTimeout.current);
    };
  }, [channel.id, user.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function send(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    getSocket()?.emit('message:send', { channel_id: channel.id, content });
    setDraft('');
  }

  function startCall(type) {
    window.dispatchEvent(new CustomEvent('teamhub:start-call', {
      detail: { user: channel.dm_user, call_type: type },
    }));
  }

  const dmOnline = channel.is_dm && channel.dm_user && onlineIds.includes(channel.dm_user.id);

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-title">
          {channel.is_dm ? (
            <>
              <Avatar user={channel.dm_user} size={24} online={dmOnline} />
              <strong>{channel.display_name}</strong>
            </>
          ) : (
            <>
              <strong># {channel.name}</strong>
              {channel.description && <span className="chat-desc">{channel.description}</span>}
            </>
          )}
        </div>
        {!!channel.is_dm && channel.dm_user && (
          <div className="chat-actions">
            <button className="btn" onClick={() => startCall('audio')} disabled={!dmOnline}
              title={dmOnline ? 'Start audio call' : `${channel.display_name} is offline`}>📞 Call</button>
            <button className="btn" onClick={() => startCall('video')} disabled={!dmOnline}
              title={dmOnline ? 'Start video call' : `${channel.display_name} is offline`}>🎥 Video</button>
          </div>
        )}
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-hint">No messages yet. Say hello 👋</div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.user_id === m.user_id;
          return (
            <div key={m.id} className={`message ${grouped ? 'grouped' : ''}`}>
              {!grouped && <Avatar user={{ name: m.user_name, avatar_color: m.avatar_color }} size={34} />}
              <div className="message-body">
                {!grouped && (
                  <div className="message-meta">
                    <strong>{m.user_name}</strong>
                    <span className="message-time">{formatTime(m.created_at)}</span>
                  </div>
                )}
                <div className="message-text">{m.content}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="typing-indicator">{typingUser ? `${typingUser} is typing…` : ' '}</div>

      <form className="composer" onSubmit={send}>
        <input
          value={draft}
          placeholder={channel.is_dm ? `Message ${channel.display_name}` : `Message #${channel.name}`}
          onChange={(e) => {
            setDraft(e.target.value);
            getSocket()?.emit('typing', { channel_id: channel.id });
          }}
        />
        <button className="btn btn-primary" disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  );
}
