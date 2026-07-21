import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import { getPrefs } from '../prefs.js';
import { localeArg } from '../prefs.js';
import Avatar from './Avatar.jsx';
import Message from './Message.jsx';
import MessageComposer from './MessageComposer.jsx';

// Day-separator label: Today / Yesterday / weekday + date.
function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(localeArg(), { weekday: 'long', day: 'numeric', month: 'short' });
}
const dayKey = (iso) => (iso ? new Date(iso.replace(' ', 'T') + 'Z').toDateString() : '');

export default function ChatView({ channel, user, users = [], onlineIds, canPost = true }) {
  const [showInfo, setShowInfo] = useState(false);
  // Who you can @-mention: the people in this conversation (DM: the two of you,
  // group: its members). Falls back to the whole directory if a channel hasn't
  // loaded its member list yet.
  const mentionMembers = channel.is_dm
    ? (channel.members || [])
    : (channel.members?.length ? channel.members : users);
  const [messages, setMessages] = useState([]);
  const [typingUser, setTypingUser] = useState(null);
  const [replyTo, setReplyTo] = useState(null); // message being replied to (WhatsApp-style)
  const [dragOver, setDragOver] = useState(false);
  const bottomRef = useRef(null);
  const typingTimeout = useRef(null);
  const composerRef = useRef(null);
  const dragDepth = useRef(0);

  function onDrop(e) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files || []);
    if (dropped.length) composerRef.current?.addFiles(dropped);
  }
  function onDragEnter(e) {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  useEffect(() => {
    setReplyTo(null);
    api(`/channels/${channel.id}/messages`).then((d) => setMessages(d.messages));

    const socket = getSocket();
    if (!socket) return;
    const onNew = ({ message }) => {
      if (message.channel_id !== channel.id) return;
      setMessages((m) => (m.some((x) => x.id === message.id) ? m : [...m, message]));
      // We're looking at this conversation, so a message from someone else is
      // read the moment it arrives — tell the server so their tick goes blue.
      if (message.user_id !== user.id) socket.emit('channel:read', { channel_id: channel.id });
    };
    // Delivery/read marks changed — restatus our own messages (blue when read).
    const onReceipts = ({ channel_id, read_up_to, delivered_up_to }) => {
      if (channel_id !== channel.id) return;
      setMessages((ms) => ms.map((x) => {
        if (x.user_id !== user.id) return x;
        const status = read_up_to && x.created_at <= read_up_to ? 'read'
          : delivered_up_to && x.created_at <= delivered_up_to ? 'delivered' : 'sent';
        return x.status === status ? x : { ...x, status };
      }));
    };
    const onUpdated = ({ message }) => {
      if (message.channel_id !== channel.id) return;
      setMessages((m) => m.map((x) => (x.id === message.id ? message : x)));
    };
    const onTyping = ({ channel_id, user: who }) => {
      if (channel_id !== channel.id || who.id === user.id) return;
      setTypingUser(who.name);
      clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => setTypingUser(null), 2500);
    };
    const onCleared = ({ channel_id }) => { if (channel_id === channel.id) setMessages([]); };
    socket.on('message:new', onNew);
    socket.on('message:updated', onUpdated);
    socket.on('typing', onTyping);
    socket.on('conversation:cleared', onCleared);
    socket.on('channel:receipts', onReceipts);
    // Opening the conversation marks it read (so senders' ticks turn blue).
    socket.emit('channel:read', { channel_id: channel.id });
    return () => {
      socket.off('message:new', onNew);
      socket.off('message:updated', onUpdated);
      socket.off('typing', onTyping);
      socket.off('conversation:cleared', onCleared);
      socket.off('channel:receipts', onReceipts);
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

  // Tapping a quoted reply jumps to (and briefly highlights) the original.
  function jumpToMessage(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  function startReply(msg) {
    setReplyTo(msg);
    composerRef.current?.focus?.();
  }

  const dmOnline = channel.is_dm && channel.dm_user && onlineIds.includes(channel.dm_user.id);
  const roomMembers = channel.members || [];
  const memberCount = channel.is_dm ? 0 : roomMembers.length;
  const memberNames = channel.is_dm ? '' : roomMembers.slice(0, 3).map((m) => m.name.split(' ')[0]).join(', ');
  const filesShared = messages.reduce((n, m) => n + (m.attachments?.length || 0), 0);

  return (
    <div className="chat-layout">
      <div className="chat" onDrop={onDrop} onDragEnter={onDragEnter} onDragOver={(e) => e.preventDefault()} onDragLeave={onDragLeave}>
        {dragOver && (
          <div className="drop-overlay">
            <div className="drop-card">📎 Drop files to share them here</div>
          </div>
        )}
        <header className="chat-header">
          <div className="chat-title">
            {channel.is_dm ? (
              <>
                <Avatar user={channel.dm_user} size={30} online={dmOnline} />
                <div className="chat-title-text">
                  <strong>{channel.display_name}</strong>
                  <span className="chat-subtitle">{dmOnline ? 'Active now' : 'Offline'}</span>
                </div>
              </>
            ) : (
              <div className="chat-title-text">
                <strong>{channel.is_collab ? '👥 ' : '# '}{channel.name}</strong>
                <span className="chat-subtitle">
                  {memberCount ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : ''}
                  {memberNames && ` · ${memberNames}`}
                  {channel.description && !memberNames && channel.description}
                </span>
              </div>
            )}
          </div>
          <div className="chat-actions">
            {!!channel.is_dm && channel.dm_user && (
              <>
                <button className="btn" onClick={() => startCall('audio')} disabled={!dmOnline}
                  title={dmOnline ? 'Start audio call' : `${channel.display_name} is offline`}>📞 Call</button>
                <button className="btn" onClick={() => startCall('video')} disabled={!dmOnline}
                  title={dmOnline ? 'Start video call' : `${channel.display_name} is offline`}>🎥 Video</button>
              </>
            )}
            <button className={`icon-btn ${showInfo ? 'active' : ''}`} title="About this conversation" onClick={() => setShowInfo((s) => !s)}>ℹ️</button>
          </div>
        </header>

        <div className="messages">
          {messages.length === 0 && <div className="empty-hint">No messages yet. Say hello 👋</div>}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.user_id === m.user_id && !prev.is_deleted && !m.is_deleted && dayKey(prev.created_at) === dayKey(m.created_at);
            const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
            return (
              <React.Fragment key={m.id}>
                {newDay && <div className="day-divider"><span>{dayLabel(m.created_at)}</span></div>}
                <Message
                  message={m}
                  currentUser={user}
                  channelId={channel.id}
                  grouped={grouped}
                  onReply={startReply}
                  onJumpTo={jumpToMessage}
                />
              </React.Fragment>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="typing-indicator">{typingUser && getPrefs().showTyping ? `${typingUser} is typing…` : ' '}</div>

        {canPost ? (
          <MessageComposer
            ref={composerRef}
            channel={channel}
            members={mentionMembers}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            placeholder={channel.is_dm ? `Message ${channel.display_name}` : `Message ${channel.is_collab ? '' : '#'}${channel.name}`}
          />
        ) : (
          <div className="composer-locked">🔒 Only moderators can post in this collab.</div>
        )}
      </div>

      {showInfo && (
        <aside className="chat-info">
          <div className="chat-info-head">
            <strong>About this {channel.is_dm ? 'conversation' : channel.is_collab ? 'collab' : 'channel'}</strong>
            <button className="icon-btn" onClick={() => setShowInfo(false)}>✕</button>
          </div>
          {channel.description && <p className="chat-info-desc muted">{channel.description}</p>}
          <div className="chat-info-stat"><span className="muted">Files shared</span><strong>{filesShared}</strong></div>

          <div className="chat-info-section-title">{channel.is_dm ? 'Participants' : `Members${memberCount ? ` · ${memberCount}` : ''}`}</div>
          <div className="chat-info-members">
            {(channel.is_dm ? [channel.dm_user, user].filter(Boolean) : roomMembers).map((m) => (
              <div key={m.id} className="chat-info-member">
                <Avatar user={m} size={30} online={onlineIds.includes(m.id)} />
                <div className="chat-info-member-meta">
                  <span className="chat-info-member-name">
                    {m.name}{m.id === user.id ? ' (you)' : ''}
                    {m.role === 'guest' && <span className="guest-badge">Guest</span>}
                  </span>
                  {(m.title || m.channel_role) && <span className="muted">{m.title || (m.channel_role !== 'member' ? m.channel_role : '')}</span>}
                </div>
              </div>
            ))}
            {!channel.is_dm && roomMembers.length === 0 && <p className="muted">No members listed.</p>}
          </div>
        </aside>
      )}

    </div>
  );
}
