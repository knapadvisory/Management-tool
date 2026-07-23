import React, { useEffect, useState, useRef } from 'react';
import { api } from '../api.js';

function highlight(text, q) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text.slice(0, 140);
  const start = Math.max(0, idx - 30);
  return (
    <>
      {start > 0 && '…'}
      {text.slice(start, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length, idx + q.length + 80)}
    </>
  );
}

// Global search across clients, tasks, and messages.
export default function SearchModal({ onSelect, onSelectClient, onSelectTask, onClose }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState({ results: [], clients: [], tasks: [] });
  const [searched, setSearched] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setData({ results: [], clients: [], tasks: [] }); setSearched(false); return; }
    timer.current = setTimeout(async () => {
      const d = await api(`/search?q=${encodeURIComponent(q.trim())}`);
      setData({ results: d.results || [], clients: d.clients || [], tasks: d.tasks || [] });
      setSearched(true);
    }, 220);
    return () => clearTimeout(timer.current);
  }, [q]);

  const term = q.trim();
  const nothing = searched && !data.clients.length && !data.tasks.length && !data.results.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="search-input"
          placeholder="Search clients, tasks, messages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <div className="search-results">
          {nothing && <div className="empty-hint">No matches.</div>}

          {data.clients.length > 0 && (
            <div className="search-section">
              <div className="search-section-head">Clients</div>
              {data.clients.map((c) => (
                <button key={`c${c.id}`} className="search-result srow" onClick={() => onSelectClient?.(c.id)}>
                  <span className="srow-icon">{c.type === 'individual' ? '👤' : '🏢'}</span>
                  <span className="srow-main">{highlight(c.name, term)}</span>
                  <span className="srow-meta muted">{[c.client_code, c.gstin].filter(Boolean)[0] || c.status}</span>
                </button>
              ))}
            </div>
          )}

          {data.tasks.length > 0 && (
            <div className="search-section">
              <div className="search-section-head">Tasks</div>
              {data.tasks.map((t) => (
                <button key={`t${t.id}`} className="search-result srow" onClick={() => onSelectTask?.(t.id)}>
                  <span className="srow-icon">{t.is_done ? '✓' : '☑'}</span>
                  <span className="srow-main">{highlight(t.title, term)}
                    {t.client_name && <span className="muted"> · {t.client_name}</span>}
                  </span>
                  <span className="srow-meta muted">{t.archived_at ? 'archived' : t.stage}</span>
                </button>
              ))}
            </div>
          )}

          {data.results.length > 0 && (
            <div className="search-section">
              <div className="search-section-head">Messages</div>
              {data.results.map((r) => (
                <button key={`m${r.id}`} className="search-result" onClick={() => onSelect(r.channel_id)}>
                  <div className="search-result-head">
                    <span className="search-channel">{r.channel_label}</span>
                    <strong>{r.user_name}</strong>
                  </div>
                  <div className="search-snippet">{highlight(r.content, term)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
