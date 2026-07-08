import React, { useState, useRef, useLayoutEffect } from 'react';
import { uploadFiles } from '../api.js';
import { getSocket } from '../socket.js';
import { formatBytes } from '../format.js';

/**
 * Message input shared by the main channel view and the thread panel.
 * Handles @mention autocomplete, file selection/upload, and Enter-to-send
 * (Shift+Enter for a newline). Mentions are tracked by user id so the
 * server can notify exactly the right people.
 */
export default function MessageComposer({ channel, members, parentId = null, placeholder, autoFocus }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [mentioned, setMentioned] = useState({}); // name -> id
  const [suggest, setSuggest] = useState(null); // { query }
  const inputRef = useRef(null);
  const pendingCaret = useRef(null);

  const others = members.filter((m) => m.name);

  // Apply the caret position after React has committed the new text, so
  // typing right after picking a mention isn't scrambled by a race.
  useLayoutEffect(() => {
    if (pendingCaret.current != null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  function onChange(e) {
    const value = e.target.value;
    setText(value);
    getSocket()?.emit('typing', { channel_id: channel.id });
    // Detect an in-progress @mention right before the caret.
    const caret = e.target.selectionStart;
    const upto = value.slice(0, caret);
    const match = upto.match(/@([\w ]*)$/);
    setSuggest(match ? { query: match[1].toLowerCase() } : null);
  }

  function pickMention(user) {
    const el = inputRef.current;
    const caret = el ? el.selectionStart : text.length;
    const match = text.slice(0, caret).match(/@([\w ]*)$/);
    const start = match ? caret - match[0].length : caret;
    const before = text.slice(0, start);
    const after = text.slice(caret);
    const insert = `@${user.name} `;
    pendingCaret.current = (before + insert).length;
    setText(before + insert + after);
    setMentioned((m) => ({ ...m, [user.name]: user.id }));
    setSuggest(null);
  }

  async function send() {
    const content = text.trim();
    if (!content && files.length === 0) return;
    let attachment_ids = [];
    if (files.length) {
      setUploading(true);
      try {
        const uploaded = await uploadFiles(files);
        attachment_ids = uploaded.map((a) => a.id);
      } catch (err) {
        alert(err.message);
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    // Only keep mentions whose @name still appears in the final text.
    const mention_user_ids = Object.entries(mentioned)
      .filter(([name]) => content.includes(`@${name}`))
      .map(([, id]) => id);

    getSocket()?.emit('message:send', {
      channel_id: channel.id,
      content,
      parent_id: parentId,
      attachment_ids,
      mention_user_ids,
    });
    setText('');
    setFiles([]);
    setMentioned({});
    setSuggest(null);
  }

  function onKeyDown(e) {
    if (suggest && suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pickMention(suggestions[0]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const suggestions = suggest
    ? others.filter((m) => m.name.toLowerCase().includes(suggest.query)).slice(0, 6)
    : [];

  return (
    <div className="composer-wrap">
      {files.length > 0 && (
        <div className="attach-tray">
          {files.map((f, i) => (
            <span key={i} className="attach-chip">
              📎 {f.name} <span className="muted">({formatBytes(f.size)})</span>
              <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mention-menu">
          {suggestions.map((m) => (
            <button key={m.id} className="mention-option" onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}>
              <span className="mention-avatar" style={{ background: m.avatar_color }}>
                {m.name[0]}
              </span>
              {m.name}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label className="attach-btn" title="Attach files">
          📎
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => { setFiles((fs) => [...fs, ...Array.from(e.target.files)]); e.target.value = ''; }}
          />
        </label>
        <textarea
          ref={inputRef}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        <button className="btn btn-primary" disabled={uploading || (!text.trim() && !files.length)}>
          {uploading ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
