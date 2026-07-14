import React, { useState, useMemo } from 'react';
import Avatar from './Avatar.jsx';
import ChatView from './ChatView.jsx';

function shortTime(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// Bitrix-style unified messenger: a conversation list on the left, the open
// chat (or an empty prompt) on the right.
export default function Messenger({ user, users = [], channels = [], onlineIds = [], onEnsureDm }) {
  const [selectedId, setSelectedId] = useState(null);
  const [pending, setPending] = useState(null); // a just-created DM not yet in `channels`
  const [query, setQuery] = useState('');

  const isOnline = (id) => onlineIds.includes(id);

  // Existing conversations (named channels + DMs), most-recent first.
  const conversations = useMemo(() => {
    return [...channels].sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
  }, [channels]);

  // Team members you haven't started a DM with yet.
  const dmUserIds = new Set(channels.filter((c) => c.is_dm).map((c) => c.dm_user?.id));
  const startable = users.filter((u) => u.id !== user.id && !dmUserIds.has(u.id));

  const q = query.trim().toLowerCase();
  const match = (name) => !q || (name || '').toLowerCase().includes(q);
  const visibleConversations = conversations.filter((c) => match(c.display_name));
  const visibleStartable = startable.filter((u) => match(u.name));

  const activeChannel = channels.find((c) => c.id === selectedId) || (pending?.id === selectedId ? pending : null);

  async function startChat(teammate) {
    const channel = await onEnsureDm(teammate);
    if (channel) { setPending(channel); setSelectedId(channel.id); }
  }

  return (
    <div className={`messenger ${activeChannel ? 'show-detail' : ''}`}>
      <div className="msgr-list">
        <div className="msgr-search">
          <input placeholder="Find employee or chat" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {visibleConversations.map((c) => (
          <button
            key={c.id}
            className={`msgr-row ${selectedId === c.id ? 'active' : ''}`}
            onClick={() => { setSelectedId(c.id); }}
          >
            {c.is_dm
              ? <Avatar user={c.dm_user} size={40} online={c.dm_user ? isOnline(c.dm_user.id) : false} />
              : <span className="msgr-hash">#</span>}
            <div className="msgr-row-body">
              <div className="msgr-row-top">
                <span className="msgr-name">{c.display_name}</span>
                <span className="msgr-time">{shortTime(c.last_activity)}</span>
              </div>
              <div className="msgr-preview">
                {c.last_message
                  ? `${c.is_dm ? '' : c.last_message.user_name + ': '}${c.last_message.content}`
                  : 'No messages yet'}
              </div>
            </div>
          </button>
        ))}

        {visibleStartable.length > 0 && (
          <>
            <div className="msgr-section">Team members</div>
            {visibleStartable.map((u) => (
              <button key={`u${u.id}`} className="msgr-row" onClick={() => startChat(u)}>
                <Avatar user={u} size={40} online={isOnline(u.id)} />
                <div className="msgr-row-body">
                  <div className="msgr-row-top"><span className="msgr-name">{u.name}</span></div>
                  <div className="msgr-preview muted">Start a chat</div>
                </div>
              </button>
            ))}
          </>
        )}

        {visibleConversations.length === 0 && visibleStartable.length === 0 && (
          <div className="empty-hint" style={{ padding: 16 }}>No people or chats match “{query}”.</div>
        )}
      </div>

      <div className="msgr-pane">
        {activeChannel ? (
          <>
            <button className="mobile-back" onClick={() => setSelectedId(null)}>← Chats</button>
            <ChatView key={activeChannel.id} channel={activeChannel} user={user} users={users} onlineIds={onlineIds} />
          </>
        ) : (
          <div className="msgr-empty">
            <div className="msgr-empty-art">💬</div>
            <p className="msgr-empty-title">Select a chat to start communicating</p>
            <p className="muted">Pick a conversation on the left, or start a new one with a teammate.</p>
          </div>
        )}
      </div>
    </div>
  );
}
