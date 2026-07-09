import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';

// Forward a message's text into another conversation the user belongs to.
export default function ForwardModal({ message, onClose }) {
  const [channels, setChannels] = useState([]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => { api('/channels').then((d) => setChannels(d.channels)).catch(() => {}); }, []);

  function forward(ch) {
    const content = (message.content || '').trim();
    if (!content) { setResult({ error: 'This message has no text to forward.' }); return; }
    getSocket()?.emit('message:send', { channel_id: ch.id, content }, (ack) => {
      if (ack?.error) setResult({ error: ack.error });
      else { setResult({ ok: ch }); setTimeout(onClose, 700); }
    });
  }

  const q = query.trim().toLowerCase();
  const list = channels.filter((c) => (c.is_dm ? c.display_name : c.name).toLowerCase().includes(q));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Forward message</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <blockquote className="forward-preview">{message.content || '(no text)'}</blockquote>
        <input className="auth-input" placeholder="Search conversations…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="forward-list">
          {list.map((c) => (
            <button key={c.id} className="forward-row" onClick={() => forward(c)}>
              {c.is_dm ? `💬 ${c.display_name}` : `# ${c.name}`}
            </button>
          ))}
          {list.length === 0 && <div className="empty-hint">No conversations found.</div>}
        </div>
        {result?.ok && <div className="auth-notice">Forwarded to {result.ok.is_dm ? result.ok.display_name : '#' + result.ok.name} ✓</div>}
        {result?.error && <div className="form-error">{result.error}</div>}
      </div>
    </div>
  );
}
