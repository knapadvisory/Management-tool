import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { uploadFiles } from '../api.js';
import { getSocket } from '../socket.js';
import { getPrefs } from '../prefs.js';
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

// Convert the editor's rich HTML into the markdown we store/send.
function nodeToMarkdown(node) {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) { out += child.nodeValue; return; }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const inner = nodeToMarkdown(child);
    switch (child.nodeName) {
      case 'B': case 'STRONG': out += inner.trim() ? `**${inner}**` : inner; break;
      case 'I': case 'EM': out += inner.trim() ? `_${inner}_` : inner; break;
      case 'S': case 'STRIKE': case 'DEL': out += inner.trim() ? `~~${inner}~~` : inner; break;
      case 'CODE': out += inner.trim() ? '`' + inner + '`' : inner; break;
      case 'A': out += `[${inner}](${child.getAttribute('href') || ''})`; break;
      case 'BR': out += '\n'; break;
      case 'DIV': case 'P': out += (out && !out.endsWith('\n') ? '\n' : '') + inner; break;
      case 'SPAN': {
        // Some browsers apply formatting as inline styles rather than tags.
        const st = child.getAttribute('style') || '';
        let s = inner;
        if (s.trim() && /font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) s = `**${s}**`;
        if (s.trim() && /font-style\s*:\s*italic/i.test(st)) s = `_${s}_`;
        if (s.trim() && /line-through/i.test(st)) s = `~~${s}~~`;
        out += s;
        break;
      }
      default: out += inner;
    }
  });
  return out;
}

const MessageComposer = forwardRef(function MessageComposer({ channel, members, parentId = null, replyTo = null, onClearReply, placeholder, autoFocus }, ref) {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [mentioned, setMentioned] = useState({}); // name -> id
  const [suggest, setSuggest] = useState(null); // { query, node, offset, matchLen }
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiPos, setEmojiPos] = useState({ top: 0, left: 0 });
  const editorRef = useRef(null);
  const emojiBtnRef = useRef(null);

  const others = members.filter((m) => m.name);

  useEffect(() => {
    try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* older browsers */ }
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  useImperativeHandle(ref, () => ({
    addFiles(list) { if (list && list.length) setFiles((fs) => [...fs, ...list]); editorRef.current?.focus(); },
    focus() { editorRef.current?.focus(); },
  }));

  // When a reply target is picked, jump focus to the editor.
  useEffect(() => { if (replyTo) editorRef.current?.focus(); }, [replyTo]);

  function syncState() {
    const editor = editorRef.current;
    setEmpty(!editor || !editor.textContent.replace(/\u200B/g, "").trim());
    getSocket()?.emit('typing', { channel_id: channel.id });
    // Detect an in-progress @mention just before the caret.
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode && sel.anchorNode.nodeType === Node.TEXT_NODE && editor?.contains(sel.anchorNode)) {
      const before = sel.anchorNode.nodeValue.slice(0, sel.anchorOffset);
      const m = before.match(/@([\w ]*)$/);
      setSuggest(m ? { query: m[1].toLowerCase(), node: sel.anchorNode, offset: sel.anchorOffset, matchLen: m[0].length } : null);
    } else {
      setSuggest(null);
    }
  }

  // Wrap the current selection in a tag and drop the caret OUTSIDE it (after a
  // zero-width space) so text typed next is plain, not formatted.
  function applyWrap(tag, attrs) {
    const editor = editorRef.current;
    editor?.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    try { range.surroundContents(el); }
    catch { const frag = range.extractContents(); el.appendChild(frag); range.insertNode(el); }
    // Escape the formatting context: a ZWSP text node right after the wrapper.
    const after = document.createTextNode("\u200B");
    el.parentNode.insertBefore(after, el.nextSibling);
    const nr = document.createRange();
    nr.setStart(after, 1); nr.collapse(true);
    sel.removeAllRanges(); sel.addRange(nr);
    syncState();
  }
  function makeLink() {
    const url = window.prompt('Link URL', 'https://');
    if (url) applyWrap('a', { href: url });
  }

  function insertTextAtCaret(str) {
    const editor = editorRef.current;
    editor?.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { editor?.appendChild(document.createTextNode(str)); syncState(); return; }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const tn = document.createTextNode(str);
    range.insertNode(tn);
    range.setStartAfter(tn); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    syncState();
  }

  function pickMention(user) {
    const s = suggest;
    editorRef.current?.focus();
    if (s && s.node && s.node.parentNode) {
      const range = document.createRange();
      range.setStart(s.node, Math.max(0, s.offset - s.matchLen));
      range.setEnd(s.node, s.offset);
      range.deleteContents();
      const tn = document.createTextNode(`@${user.name} `);
      range.insertNode(tn);
      range.setStartAfter(tn); range.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } else {
      insertTextAtCaret(`@${user.name} `);
    }
    setMentioned((m) => ({ ...m, [user.name]: user.id }));
    setSuggest(null);
    syncState();
  }

  function startMention() { insertTextAtCaret('@'); syncState(); }

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

  async function send() {
    const editor = editorRef.current;
    let content = '';
    try { content = nodeToMarkdown(editor).replace(/[\u200B]/g, "").replace(/\u00A0/g, " ").trim(); }
    catch { content = (editor?.textContent || '').trim(); }
    if (!content && files.length === 0) return;

    let attachment_ids = [];
    if (files.length) {
      setUploading(true);
      try {
        const uploaded = await uploadFiles(files);
        attachment_ids = uploaded.map((a) => a.id);
      } catch (err) { alert(err.message); setUploading(false); return; }
      setUploading(false);
    }
    const mention_user_ids = Object.entries(mentioned)
      .filter(([name]) => content.includes(`@${name}`))
      .map(([, id]) => id);

    getSocket()?.emit('message:send', { channel_id: channel.id, content, parent_id: replyTo?.id ?? parentId, attachment_ids, mention_user_ids });
    if (editor) editor.innerHTML = '';
    setFiles([]);
    setMentioned({});
    setSuggest(null);
    setEmpty(true);
    onClearReply?.();
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); return applyWrap('strong'); }
      if (k === 'i') { e.preventDefault(); return applyWrap('em'); }
      if (k === 'k') { e.preventDefault(); return makeLink(); }
      if (e.shiftKey && k === 'x') { e.preventDefault(); return applyWrap('s'); }
      if (e.shiftKey && k === 'c') { e.preventDefault(); return applyWrap('code'); }
    }
    if (suggest && suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pickMention(suggestions[0]);
      return;
    }
    if (e.key === 'Enter') {
      // Enter-to-send (default): Enter sends, Shift+Enter = newline.
      // Otherwise: Enter = newline, Ctrl/Cmd+Enter sends.
      if (getPrefs().enterToSend) {
        if (!e.shiftKey) { e.preventDefault(); send(); }
      } else if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); send();
      }
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
              <span className="mention-avatar" style={{ background: m.avatar_color }}>{m.name[0]}</span>
              {m.name}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        {replyTo && (
          <div className="composer-reply">
            <div className="composer-reply-body">
              <span className="composer-reply-to">Replying to {replyTo.user_name}</span>
              <span className="composer-reply-text">{replyTo.is_deleted ? 'Deleted message' : (replyTo.content || '📎 Attachment')}</span>
            </div>
            <button type="button" className="composer-reply-x" title="Cancel reply" onClick={() => onClearReply?.()}>✕</button>
          </div>
        )}
        <div className="composer-editor-wrap">
          {empty && <div className="composer-placeholder">{placeholder}</div>}
          <div
            ref={editorRef}
            className="composer-editor"
            contentEditable
            spellCheck={getPrefs().spellcheck}
            role="textbox"
            aria-multiline="true"
            onInput={syncState}
            onKeyUp={syncState}
            onMouseUp={syncState}
            onKeyDown={onKeyDown}
            suppressContentEditableWarning
          />
        </div>

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
            <input type="file" multiple hidden onChange={(e) => { setFiles((fs) => [...fs, ...Array.from(e.target.files)]); e.target.value = ''; }} />
          </label>
          <button type="button" ref={emojiBtnRef} className="composer-tool" title="Emoji" onMouseDown={(e) => e.preventDefault()} onClick={openEmoji}>😊</button>
          <button type="button" className="composer-tool" title="Mention someone" onMouseDown={(e) => e.preventDefault()} onClick={startMention}>@</button>
          <span className="composer-fmt-hint">Select text, then <kbd>Ctrl/⌘ B</kbd> / <kbd>I</kbd> / <kbd>K</kbd></span>
          <div className="composer-spacer" />
          <button type="button" className="composer-send" title="Send (Enter)" disabled={uploading || (empty && !files.length)} onClick={send}>
            {uploading ? '…' : '➤'}
          </button>
        </div>
      </div>
      {emojiOpen && <EmojiPicker position={emojiPos} onPick={(e) => { insertTextAtCaret(e); setEmojiOpen(false); }} onClose={() => setEmojiOpen(false)} />}
    </div>
  );
});

export default MessageComposer;
