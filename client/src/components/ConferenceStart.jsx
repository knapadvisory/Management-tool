import React, { useState } from 'react';
import Avatar from './Avatar.jsx';

// The "Conference call" tab: pick teammates, choose audio or video, and start
// an ad-hoc call that rings everyone selected. No collab space needed.
export default function ConferenceStart({ user, users = [], onlineIds = [] }) {
  const [sel, setSel] = useState([]);
  const [query, setQuery] = useState('');

  const online = new Set(onlineIds);
  const candidates = users
    .filter((u) => u.id !== user.id && u.role !== 'guest')
    .filter((u) => !query.trim() || u.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (online.has(b.id) ? 1 : 0) - (online.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  function start(callType) {
    window.dispatchEvent(new CustomEvent('teamhub:start-room-call', {
      detail: { kind: 'conference', call_type: callType, title: 'Conference call', invite_user_ids: sel },
    }));
    setSel([]);
  }

  return (
    <div className="conference-start">
      <div className="conf-head">
        <div className="collab-promo-badge">📞</div>
        <h2>Conference call</h2>
        <p className="muted">Pick who to ring, then start an audio or video call. Everyone you select gets an incoming-call invite.</p>
      </div>

      <div className="conf-picker">
        <input className="conf-search" placeholder="Search people" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="conf-list">
          {candidates.length === 0 && <div className="muted" style={{ padding: 12 }}>No teammates to add.</div>}
          {candidates.map((u) => (
            <label key={u.id} className="invite-row">
              <input type="checkbox" checked={sel.includes(u.id)} onChange={() => toggle(u.id)} />
              <Avatar user={u} size={30} />
              <span className="conf-name">{u.name}</span>
              <span className={`presence-dot ${online.has(u.id) ? 'on' : ''}`} title={online.has(u.id) ? 'Online' : 'Offline'} />
            </label>
          ))}
        </div>
      </div>

      <div className="conf-actions">
        <span className="muted">{sel.length ? `${sel.length} selected` : 'Select at least one person'}</span>
        <div className="conf-buttons">
          <button className="btn" disabled={!sel.length} onClick={() => start('audio')}>📞 Start call</button>
          <button className="btn btn-primary" disabled={!sel.length} onClick={() => start('video')}>🎥 Start video</button>
        </div>
      </div>
    </div>
  );
}
