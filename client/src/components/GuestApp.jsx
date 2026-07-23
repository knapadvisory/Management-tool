import React, { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import ChatView from './ChatView.jsx';
import { getSocket } from '../socket.js';

// Minimal shell for external guests: they see only the collab chat(s) they
// were invited into — no dashboard, tasks, directory, files or admin.
export default function GuestApp({ user, collabs, onlineIds, onLogout, onRefresh }) {
  const [activeId, setActiveId] = useState(collabs[0]?.id || null);

  // Follow the collab list as it loads / changes; keep a valid selection.
  useEffect(() => {
    if (!collabs.some((c) => c.id === activeId)) setActiveId(collabs[0]?.id || null);
  }, [collabs, activeId]);

  // Make sure we're subscribed to the room for live messages.
  useEffect(() => {
    const socket = getSocket();
    for (const c of collabs) socket?.emit('channel:subscribe', c.id);
  }, [collabs]);

  const active = collabs.find((c) => c.id === activeId) || null;
  const canPost = active ? active.who_can_post !== 'mods' : false;

  return (
    <div className="app guest-app">
      <aside className="guest-rail">
        <div className="guest-rail-brand"><span className="auth-logo">✓</span> TeamHub</div>
        <div className="guest-rail-label">Your conversations</div>
        <div className="guest-rail-list">
          {collabs.length === 0 && <p className="muted guest-rail-empty">No conversations yet.</p>}
          {collabs.map((c) => (
            <button
              key={c.id}
              className={`guest-rail-item ${c.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <span className="guest-rail-item-icon">👥</span>
              <span className="guest-rail-item-name">{c.name}</span>
            </button>
          ))}
        </div>
        <div className="guest-rail-foot">
          <div className="guest-rail-me">
            <Avatar user={user} size={28} />
            <div className="guest-rail-me-meta">
              <span className="guest-rail-me-name">{user.name}</span>
              <span className="muted">Guest</span>
            </div>
          </div>
          <button className="btn btn-sm" onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {active ? (
          <ChatView key={active.id} channel={active} user={user} users={active.members || []} onlineIds={onlineIds} canPost={canPost} />
        ) : (
          <div className="guest-empty">
            <div className="guest-empty-card">
              <h2>Welcome, {user.name.split(' ')[0]} 👋</h2>
              <p className="muted">You'll see your conversation here once it's ready. If you were just invited, try refreshing.</p>
              <button className="btn" onClick={onRefresh}>Refresh</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
