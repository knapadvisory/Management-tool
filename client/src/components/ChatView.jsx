import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';
import Message from './Message.jsx';
import MessageComposer from './MessageComposer.jsx';
import ThreadPanel from './ThreadPanel.jsx';

export default function ChatView({ channel, user, users = [], onlineIds }) {
  // In a public/named channel anyone can be mentioned; in a DM, just the two of you.
  const mentionMembers = channel.is_dm ? (channel.members || []) : users;
  const [messages, setMessages] = useState([]);
  const [typingUser, setTypingUser] = useState(null);
  const [threadRoot, setThreadRoot] = useState(null);
  const bottomRef = useRef(null);
  const typingTimeout = useRef(null);

  useEffect(() => {
    setThreadRoot(null);
    api(`/channels/${channel.id}/messages`).then((d) => setMessages(d.messages));

    const socket = getSocket();
    if (!socket) return;
    const onNew = ({ message }) => {
      if (message.channel_id !== channel.id) return;
      if (message.parent_id) return; // thread replies live in the panel
      setMessages((m) => (m.some((x) => x.id === message.id) ? m : [...m, message]));
    };
    const onUpdated = ({ message }) => {
      if (message.channel_id !== channel.id) return;
      setMessages((m) => m.map((x) => (x.id === message.id ? message : x)));
      setThreadRoot((r) => (r && r.id === message.id ? message : r));
    };
    const onTyping = ({ channel_id, user: who }) => {
      if (channel_id !== channel.id || who.id === user.id) return;
      setTypingUser(who.name);
      clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => setTypingUser(null), 2500);
    };
    socket.on('message:new', onNew);
    socket.on('message:updated', onUpdated);
    socket.on('typing', onTyping);
    return () => {
      socket.off('message:new', onNew);
      socket.off('message:updated', onUpdated);
      socket.off('typing', onTyping);
      clearTimeout(typingTimeout.current);
    };
  }, [channel.id, user.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function startCall(type) {
    window.dispatchEvent(new CustomEvent('teamhub:start-call', {
      detail: { user: channel.dm_user, call_type: type },
    }));
  }

  const dmOnline = channel.is_dm && channel.dm_user && onlineIds.includes(channel.dm_user.id);

  return (
    <div className="chat-layout">
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
          {messages.length === 0 && <div className="empty-hint">No messages yet. Say hello 👋</div>}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.user_id === m.user_id && !prev.is_deleted && !m.is_deleted;
            return (
              <Message
                key={m.id}
                message={m}
                currentUser={user}
                channelId={channel.id}
                grouped={grouped}
                onOpenThread={(msg) => setThreadRoot(msg)}
              />
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="typing-indicator">{typingUser ? `${typingUser} is typing…` : ' '}</div>

        <MessageComposer
          channel={channel}
          members={mentionMembers}
          placeholder={channel.is_dm ? `Message ${channel.display_name}` : `Message #${channel.name}`}
        />
      </div>

      {threadRoot && (
        <ThreadPanel
          channel={channel}
          rootId={threadRoot.id}
          currentUser={user}
          members={mentionMembers}
          onClose={() => setThreadRoot(null)}
        />
      )}
    </div>
  );
}
