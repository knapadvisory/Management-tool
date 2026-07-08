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

export default function SearchModal({ onSelect, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); setSearched(false); return; }
    timer.current = setTimeout(async () => {
      const d = await api(`/search?q=${encodeURIComponent(q.trim())}`);
      setResults(d.results);
      setSearched(true);
    }, 250);
    return () => clearTimeout(timer.current);
  }, [q]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="search-input"
          placeholder="Search messages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <div className="search-results">
          {searched && results.length === 0 && <div className="empty-hint">No messages found.</div>}
          {results.map((r) => (
            <button key={r.id} className="search-result" onClick={() => onSelect(r.channel_id)}>
              <div className="search-result-head">
                <span className="search-channel">{r.channel_label}</span>
                <strong>{r.user_name}</strong>
              </div>
              <div className="search-snippet">{highlight(r.content, q.trim())}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
