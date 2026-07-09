import React, { useState, useRef, useLayoutEffect, forwardRef, useImperativeHandle } from 'react';
import { uploadFiles } from '../api.js';
import { getSocket } from '../socket.js';
import { formatBytes } from '../format.js';
import EmojiPicker from './EmojiPicker.jsx';

// Icon + human label for a selected (not-yet-uploaded) File.
function fileGlyph(f) {
  const mime = f.type || '';
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/')) return { icon: '🖼️', label: 'Image' };
  if (mime.startsWith('video/')) return { icon: '🎬', label: 'Video' };
  if (mime.startsWith('audio/')) return { icon: '🎵', label: 'Audio' };
  if (mime === 'application/pdf' || ext === 'pdf') return { icon: '📕', label: 'PDF' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { icon: '📊', label: 'Spreadsheet' };
  if (['doc', 'docx'].includes(ext)) return { icon: '📘', label: 'Word document' };
  if (['ppt', 'pptx'].includes(ext)) return { icon: '📙', label: 'Presentation' };
  if (['zip', 'rar', '7z'].includes(ext)) return { icon: '🗜️', label: 'Archive' };
  return { icon: '📄', label: ext ? `${ext.toUpperCase()} file` : 'File' };
}

/**
 * Message input shared by the main channel view and the thread panel.
 * Handles @mention autocomplete, file selection/upload, and Enter-to-send
 * (Shift+Enter for a newline). Mentions are tracked by user id so the
 * server can notify exactly the right people.
 */
const MessageComposer = forwardRef(function MessageComposer({ channel, members, parentId = null, placeholder, autoFocus }, ref) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [mentioned, setMentioned] = useState({}); // name -> id
  const [suggest, setSuggest] = useState(null); // { query }
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiPos, setEmojiPos] = useState({ top: 0, left: 0 });
  const inputRef = useRef(null);
  const pendingCaret = useRef(null);
  const emojiBtnRef = useRef(null);

  function openEmoji() {
    const r = emojiBtnRef.current?.getBoundingClientRect();
    if (r) {
      const W = 312, H = 380;
      const left = Math.min(window.innerWidth - W - 8, Math.max(8, r.left));
      const above = r.top - H - 6;
      setEmojiPos({ top: above > 8 ? above : r.bottom + 6, left });
    }
    setEmojiOpen((o) => !o);
  }
  function insertEmoji(emoji) {
    const el = inputRef.current;
    const caret = el ? el.selectionStart : text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    pendingCaret.current = (before + emoji).length;
    setText(before + emoji + after);
    setEmojiOpen(false);
  }

  // Wrap the current selection with a markdown marker (or insert the marker
  // pair at the caret if nothing is selected).
  function wrapSelection(marker, end = marker) {
    const el = inputRef.current;
    const s = el ? el.selectionStart : text.length;
    const e = el ? el.selectionEnd : text.length;
    const sel = text.slice(s, e);
    pendingCaret.current = s + marker.length + sel.length;
    setText(text.slice(0, s) + marker + sel + end + text.slice(e));
    el?.focus();
  }
  function insertLink() {
    const el = inputRef.current;
    const s = el ? el.selectionStart : text.length;
    const e = el ? el.selectionEnd : text.length;
    const label = text.slice(s, e) || 'text';
    const snippet = `[${label}](url)`;
    pendingCaret.current = s + snippet.length - 4; // land on "url"
    setText(text.slice(0, s) + snippet + text.slice(e));
    el?.focus();
  }
  function insertAt(str) {
    const el = inputRef.current;
    const caret = el ? el.selectionStart : text.length;
    pendingCaret.current = caret + str.length;
    setText(text.slice(0, caret) + str + text.slice(caret));
    el?.focus();
  }
  function startMention() {
    insertAt('@');
    setSuggest({ query: '' });
  }

  // Let the parent (ChatView) hand us files dropped anywhere on the chat.
  useImperativeHandle(ref, () => ({
    addFiles(list) {
      if (list && list.length) { setFiles((fs) => [...fs, ...list]); inputRef.current?.focus(); }
    },
  }));

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
        <div className="composer-format">
          <button type="button" title="Bold" onClick={() => wrapSelection('**')}><b>B</b></button>
          <button type="button" title="Italic" onClick={() => wrapSelection('_')}><i>I</i></button>
          <button type="button" title="Strikethrough" onClick={() => wrapSelection('~~')}><s>S</s></button>
          <button type="button" title="Inline code" className="mono" onClick={() => wrapSelection('`')}>{'</>'}</button>
          <button type="button" title="Code block" className="mono" onClick={() => wrapSelection('```\n', '\n```')}>{'{ }'}</button>
          <button type="button" title="Link" onClick={insertLink}>🔗</button>
          <button type="button" title="Bulleted list" onClick={() => insertAt('\n- ')}>≔</button>
        </div>

        <textarea
          ref={inputRef}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />

        {files.length > 0 && (
          <div className="composer-attachments">
            {files.map((f, i) => {
              const g = fileGlyph(f);
              return (
                <div key={i} className="attach-card">
                  <span className="attach-card-icon">{g.icon}</span>
                  <div className="attach-card-main">
                    <div className="attach-card-name" title={f.name}>{f.name}</div>
                    <div className="attach-card-sub muted">{g.label} · {formatBytes(f.size)}</div>
                  </div>
                  <button type="button" className="attach-card-x" title="Remove" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>✕</button>
                </div>
              );
            })}
          </div>
        )}

        <div className="composer-bar">
          <label className="composer-tool" title="Attach files">
            📎
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => { setFiles((fs) => [...fs, ...Array.from(e.target.files)]); e.target.value = ''; }}
            />
          </label>
          <button type="button" ref={emojiBtnRef} className="composer-tool" title="Emoji" onClick={openEmoji}>😊</button>
          <button type="button" className="composer-tool" title="Mention someone" onClick={startMention}>@</button>
          <div className="composer-spacer" />
          <button className="composer-send" title="Send (Enter)" disabled={uploading || (!text.trim() && !files.length)}>
            {uploading ? '…' : '➤'}
          </button>
        </div>
      </form>
      {emojiOpen && <EmojiPicker position={emojiPos} onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
    </div>
  );
});

export default MessageComposer;
