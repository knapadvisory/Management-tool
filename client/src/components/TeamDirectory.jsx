import React, { useState } from 'react';
import Avatar from './Avatar.jsx';

// A people directory — profiles, not chats. Clicking a card does not open a
// conversation; use the explicit Message button (which jumps to DMs).
export default function TeamDirectory({ user, users = [], onlineIds = [], onMessage }) {
  const [query, setQuery] = useState('');
  const isOnline = (id) => onlineIds.includes(id);

  const q = query.trim().toLowerCase();
  const people = users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q));

  return (
    <div className="team-page">
      <header className="team-head">
        <div>
          <h2>Team</h2>
          <p className="muted">{users.length} {users.length === 1 ? 'person' : 'people'} in your workspace</p>
        </div>
        <input className="team-search" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>

      <div className="team-grid">
        {people.map((u) => (
          <div key={u.id} className="team-card">
            <div className="team-card-top">
              <Avatar user={u} size={48} online={isOnline(u.id)} />
              <div className="team-card-id">
                <div className="team-card-name">
                  {u.name}
                  {u.role === 'admin' && <span className="role-badge admin">Admin</span>}
                  {u.id === user.id && <span className="role-badge you">You</span>}
                </div>
                {u.title && <div className="muted team-card-title">{u.title}</div>}
              </div>
            </div>
            <div className="team-card-meta">
              <span className={`presence-text ${isOnline(u.id) ? 'on' : 'off'}`}>
                {isOnline(u.id) ? '● Online' : '○ Offline'}
              </span>
              {u.email && <a className="team-card-email" href={`mailto:${u.email}`}>{u.email}</a>}
            </div>
            {u.id !== user.id && (
              <button className="btn btn-sm team-msg-btn" onClick={() => onMessage(u)}>💬 Message</button>
            )}
          </div>
        ))}
        {people.length === 0 && <div className="empty-hint">No one matches “{query}”.</div>}
      </div>
    </div>
  );
}
