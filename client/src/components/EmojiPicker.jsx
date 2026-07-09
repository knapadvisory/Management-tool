import React, { useState, useMemo } from 'react';
import { EMOJI_CATEGORIES } from '../emojiData.js';

// A searchable, categorized emoji picker. Rendered at a fixed position
// (computed by the caller) with a click-away backdrop, so it never clips.
export default function EmojiPicker({ onPick, onClose, position }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState(0);
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return null;
    const out = [];
    for (const c of EMOJI_CATEGORIES) {
      for (const [emoji, kw] of c.emojis) {
        if (kw.includes(q)) out.push(emoji);
      }
    }
    return out;
  }, [q]);

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="emoji-panel" style={{ position: 'fixed', top: position?.top, left: position?.left }}>
        <input className="emoji-search" autoFocus placeholder="Search emoji…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!q && (
          <div className="emoji-tabs">
            {EMOJI_CATEGORIES.map((c, i) => (
              <button key={c.name} className={`emoji-tab ${cat === i ? 'active' : ''}`} title={c.name} onClick={() => setCat(i)}>{c.icon}</button>
            ))}
          </div>
        )}
        <div className="emoji-grid">
          {q ? (
            results.length ? results.map((e, i) => <button key={e + i} className="emoji-btn" onClick={() => onPick(e)}>{e}</button>)
              : <div className="emoji-empty">No emoji found</div>
          ) : (
            EMOJI_CATEGORIES[cat].emojis.map(([e], i) => <button key={e + i} className="emoji-btn" onClick={() => onPick(e)}>{e}</button>)
          )}
        </div>
      </div>
    </>
  );
}
