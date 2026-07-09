import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, fileUrl, uploadToDrive } from '../api.js';
import { getSocket } from '../socket.js';
import { formatBytes, formatDateTime } from '../format.js';
import Avatar from './Avatar.jsx';
import FilePreviewModal from './FilePreviewModal.jsx';

const SORTS = [
  { key: 'date', label: 'Date shared' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
  { key: 'owner', label: 'Owner' },
];

function iconFor(mime, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime?.startsWith('video/')) return '🎬';
  if (mime?.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf' || ext === 'pdf') return '📕';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}

function downloadFile(f) {
  const a = document.createElement('a');
  a.href = fileUrl(f.id);
  a.download = f.original_name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// A file-manager style tab: sortable Name / Owner / Shared / Size columns, row
// selection with a contextual action bar, Details/Grid views and in-app
// preview. Powers both the Files aggregate and the shared team Drive; the Drive
// adds uploading (button + drag-and-drop) and a live socket refresh.
export default function FilesView({ user, mode = 'files' }) {
  const isDrive = mode === 'drive';
  const endpoint = isDrive ? '/drive' : '/files';

  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [details, setDetails] = useState(null);
  const [view, setView] = useState('details'); // 'details' | 'grid'
  const [sort, setSort] = useState({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const d = await api(`${endpoint}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      setFiles(d.files);
      setSelected(new Set());
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => { const t = setTimeout(() => load(query), 200); return () => clearTimeout(t); }, [query, load]);

  // Keep the Drive fresh when teammates upload or remove files.
  useEffect(() => {
    if (!isDrive) return;
    const s = getSocket();
    if (!s) return;
    const refresh = () => load(query);
    s.on('drive:changed', refresh);
    return () => s.off('drive:changed', refresh);
  }, [isDrive, load, query]);

  async function uploadDriveFiles(list) {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    setUploading(true);
    try { await uploadToDrive(arr); await load(query); }
    catch (err) { alert(err.message); }
    finally { setUploading(false); }
  }

  function onDrop(e) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (isDrive && e.dataTransfer?.files?.length) uploadDriveFiles(e.dataTransfer.files);
  }
  function onDragOver(e) { if (isDrive) e.preventDefault(); }
  function onDragEnter(e) { if (!isDrive) return; e.preventDefault(); dragDepth.current += 1; setDragging(true); }
  function onDragLeave(e) { if (!isDrive) return; e.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false); }

  const sorted = [...files].sort((a, b) => {
    const { key, dir } = sort;
    let av, bv;
    if (key === 'name') { av = a.original_name.toLowerCase(); bv = b.original_name.toLowerCase(); }
    else if (key === 'owner') { av = a.uploader_name.toLowerCase(); bv = b.uploader_name.toLowerCase(); }
    else if (key === 'size') { av = a.size; bv = b.size; }
    else { av = a.created_at || ''; bv = b.created_at || ''; }
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const selectedFiles = sorted.filter((f) => selected.has(f.id));
  const canDelete = (f) => f.uploader_id === user.id; // you can only delete files you shared

  function toggle(id) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => (s.size === sorted.length ? new Set() : new Set(sorted.map((f) => f.id))));
  }
  function setSortKey(key) {
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' || key === 'owner' ? 1 : -1 }));
  }

  async function deleteSelected() {
    const targets = selectedFiles.filter(canDelete);
    if (!targets.length) { alert(`You can only delete files you ${isDrive ? 'uploaded' : 'shared'}.`); return; }
    const where = isDrive ? 'the Drive' : 'your chats and Files';
    if (!confirm(`Delete ${targets.length} file${targets.length === 1 ? '' : 's'}? They'll be removed from ${where}.`)) return;
    for (const f of targets) { try { await api(`${endpoint}/${f.id}`, { method: 'DELETE' }); } catch { /* skip */ } }
    load(query);
  }

  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
  const one = selectedFiles.length === 1 ? selectedFiles[0] : null;

  const emptyMsg = query
    ? `No files match “${query}”.`
    : isDrive ? 'The Drive is empty. Upload a file to share it with the team.' : 'No files have been shared yet.';

  return (
    <div
      className={`files-page ${dragging ? 'drag-over' : ''}`}
      onDrop={onDrop} onDragOver={onDragOver} onDragEnter={onDragEnter} onDragLeave={onDragLeave}
    >
      <header className="files-head">
        <h2>{isDrive ? 'Drive' : 'Files'}</h2>
        <div className="files-controls">
          <input className="files-search" placeholder={isDrive ? 'Search the Drive…' : 'Search files, people or places…'} value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="files-sort">
            <select value={sort.key} onChange={(e) => setSortKey(e.target.value)}>
              {SORTS.map((s) => <option key={s.key} value={s.key}>By {s.label.toLowerCase()}</option>)}
            </select>
          </label>
          <button className="files-dir" title="Reverse order" onClick={() => setSort((s) => ({ ...s, dir: -s.dir }))}>{sort.dir === 1 ? '↑' : '↓'}</button>
          <div className="files-view-toggle">
            <button className={view === 'details' ? 'active' : ''} title="Details" onClick={() => setView('details')}>☰</button>
            <button className={view === 'grid' ? 'active' : ''} title="Icons" onClick={() => setView('grid')}>▦</button>
          </div>
          {isDrive && (
            <>
              <button className="btn btn-primary files-upload-btn" disabled={uploading} onClick={() => inputRef.current?.click()}>
                {uploading ? 'Uploading…' : '⬆ Upload'}
              </button>
              <input ref={inputRef} type="file" multiple hidden onChange={(e) => { uploadDriveFiles(e.target.files); e.target.value = ''; }} />
            </>
          )}
        </div>
      </header>

      {isDrive && <p className="files-drive-hint muted">A shared team Drive — everyone can see and download these files. You can only delete files you uploaded.</p>}

      {selected.size > 0 && (
        <div className="files-actionbar">
          <span className="files-selected-count">Selected: {selected.size}</span>
          <span className="files-actionbar-sep" />
          <button className="fa-btn" disabled={!one} onClick={() => one && setPreview(one)}>👁 Open</button>
          <button className="fa-btn" disabled={!one} onClick={() => one && setDetails(one)}>ℹ Details</button>
          <button className="fa-btn" onClick={() => selectedFiles.forEach(downloadFile)}>⬇ Download</button>
          <button className="fa-btn danger" onClick={deleteSelected}>🗑 Delete</button>
          <button className="fa-btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {loading && files.length === 0 ? (
        <p className="muted" style={{ padding: 20 }}>Loading…</p>
      ) : sorted.length === 0 ? (
        <div className="empty-hint" style={{ padding: 20 }}>{emptyMsg}</div>
      ) : view === 'details' ? (
        <div className="files-table-wrap">
          <table className="files-table">
            <thead>
              <tr>
                <th className="fx-check"><input type="checkbox" checked={selected.size === sorted.length} onChange={toggleAll} /></th>
                <th className="fx-name" onClick={() => setSortKey('name')}>Name{arrow('name')}</th>
                <th className="fx-owner" onClick={() => setSortKey('owner')}>Owner{arrow('owner')}</th>
                <th className="fx-date" onClick={() => setSortKey('date')}>Shared on{arrow('date')}</th>
                <th className="fx-size" onClick={() => setSortKey('size')}>Size{arrow('size')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => (
                <tr key={f.id} className={selected.has(f.id) ? 'sel' : ''}>
                  <td className="fx-check"><input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td className="fx-name" onClick={() => setPreview(f)}>
                    {f.mime_type?.startsWith('image/') ? <img className="file-thumb sm" src={fileUrl(f.id)} alt="" /> : <span className="file-icon sm">{iconFor(f.mime_type, f.original_name)}</span>}
                    <span className="fx-filename">{f.original_name}</span>
                    <span className="fx-context muted">{f.context}</span>
                  </td>
                  <td className="fx-owner"><Avatar user={{ name: f.uploader_name, avatar_color: f.uploader_color }} size={20} /> <span>{f.uploader_name}</span></td>
                  <td className="fx-date muted">{formatDateTime(f.created_at)}</td>
                  <td className="fx-size muted">{formatBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="files-grid">
          {sorted.map((f) => (
            <div key={f.id} className={`file-card ${selected.has(f.id) ? 'sel' : ''}`}>
              <input className="file-card-check" type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
              <button className="file-card-body" onClick={() => setPreview(f)}>
                {f.mime_type?.startsWith('image/') ? <img className="file-card-thumb" src={fileUrl(f.id)} alt="" /> : <span className="file-card-icon">{iconFor(f.mime_type, f.original_name)}</span>}
                <span className="file-card-name">{f.original_name}</span>
                <span className="file-card-owner muted">{f.uploader_name}</span>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="files-foot muted">SELECTED: {selected.size} / {sorted.length}</div>

      {isDrive && dragging && (
        <div className="files-drop-overlay"><div className="files-drop-inner">⬆<br />Drop files to upload to the Drive</div></div>
      )}

      {preview && <FilePreviewModal file={preview} onClose={() => setPreview(null)} />}
      {details && <FileDetails file={details} onClose={() => setDetails(null)} onOpen={() => { setPreview(details); setDetails(null); }} />}
    </div>
  );
}

function FileDetails({ file, onClose, onOpen }) {
  const rows = [
    ['Name', file.original_name],
    ['Type', file.mime_type || '—'],
    ['Size', formatBytes(file.size)],
    ['Shared by', file.uploader_name],
    ['Location', file.context],
    ['Shared on', formatDateTime(file.created_at)],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal file-details" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>File details</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <dl className="file-details-list">
          {rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
        </dl>
        <div className="editor-actions">
          <button className="btn btn-primary" onClick={onOpen}>Open</button>
          <a className="btn" href={fileUrl(file.id)} download={file.original_name}>Download</a>
        </div>
      </div>
    </div>
  );
}
