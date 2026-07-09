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
// adds folders, uploading (button + drag-and-drop) and a live socket refresh.
export default function FilesView({ user, mode = 'files' }) {
  const isDrive = mode === 'drive';
  const endpoint = isDrive ? '/drive' : '/files';

  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [path, setPath] = useState([]); // breadcrumb ancestors
  const [folderId, setFolderId] = useState(null); // current folder (Drive)
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [details, setDetails] = useState(null);
  const [moving, setMoving] = useState(null); // files pending a "move to folder"
  const [view, setView] = useState('details'); // 'details' | 'grid'
  const [sort, setSort] = useState({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  const load = useCallback(async (q, fid) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (isDrive && fid != null) params.set('folder', String(fid));
      const d = await api(`${endpoint}${params.toString() ? `?${params}` : ''}`);
      setFiles(d.files || []);
      setFolders(d.folders || []);
      setPath(d.path || []);
      setSelected(new Set());
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [endpoint, isDrive]);

  useEffect(() => { const t = setTimeout(() => load(query, folderId), 200); return () => clearTimeout(t); }, [query, folderId, load]);

  // Keep the Drive fresh when teammates upload, move or remove files/folders.
  useEffect(() => {
    if (!isDrive) return;
    const s = getSocket();
    if (!s) return;
    const refresh = () => load(query, folderId);
    s.on('drive:changed', refresh);
    return () => s.off('drive:changed', refresh);
  }, [isDrive, load, query, folderId]);

  const searching = isDrive && !!query.trim();

  async function uploadDriveFiles(list) {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    setUploading(true);
    try { await uploadToDrive(arr, folderId); await load(query, folderId); }
    catch (err) { alert(err.message); }
    finally { setUploading(false); }
  }

  async function newFolder() {
    const name = prompt('New folder name');
    if (!name || !name.trim()) return;
    try { await api('/drive/folders', { method: 'POST', body: { name: name.trim(), parent_id: folderId } }); await load(query, folderId); }
    catch (err) { alert(err.message); }
  }
  async function renameFolder(f) {
    const name = prompt('Rename folder', f.name);
    if (!name || !name.trim() || name.trim() === f.name) return;
    try { await api(`/drive/folders/${f.id}`, { method: 'PATCH', body: { name: name.trim() } }); await load(query, folderId); }
    catch (err) { alert(err.message); }
  }
  async function deleteFolder(f) {
    if (!confirm(`Delete folder “${f.name}”? It must be empty.`)) return;
    try { await api(`/drive/folders/${f.id}`, { method: 'DELETE' }); await load(query, folderId); }
    catch (err) { alert(err.message); }
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
  const canManageFolder = (f) => f.created_by === user.id || user.role === 'admin';

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
    load(query, folderId);
  }

  function openFolder(id) { setQuery(''); setFolderId(id); }

  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
  const one = selectedFiles.length === 1 ? selectedFiles[0] : null;
  const movableSelected = selectedFiles.filter((f) => f.uploader_id === user.id || user.role === 'admin');

  const emptyMsg = query
    ? `No files match “${query}”.`
    : isDrive ? 'This folder is empty. Upload a file or create a folder.' : 'No files have been shared yet.';
  const nothingHere = sorted.length === 0 && (!isDrive || folders.length === 0);

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
              <button className="btn files-newfolder-btn" onClick={newFolder}>📁 New folder</button>
              <button className="btn btn-primary files-upload-btn" disabled={uploading} onClick={() => inputRef.current?.click()}>
                {uploading ? 'Uploading…' : '⬆ Upload'}
              </button>
              <input ref={inputRef} type="file" multiple hidden onChange={(e) => { uploadDriveFiles(e.target.files); e.target.value = ''; }} />
            </>
          )}
        </div>
      </header>

      {isDrive && (
        <div className="drive-breadcrumb">
          <button className={`crumb ${folderId == null && !searching ? 'current' : ''}`} onClick={() => openFolder(null)}>💾 Drive</button>
          {!searching && path.map((p) => (
            <React.Fragment key={p.id}>
              <span className="crumb-sep">›</span>
              <button className={`crumb ${p.id === folderId ? 'current' : ''}`} onClick={() => openFolder(p.id)}>{p.name}</button>
            </React.Fragment>
          ))}
          {searching && <><span className="crumb-sep">›</span><span className="crumb current">Search results</span></>}
        </div>
      )}

      {selected.size > 0 && (
        <div className="files-actionbar">
          <span className="files-selected-count">Selected: {selected.size}</span>
          <span className="files-actionbar-sep" />
          <button className="fa-btn" disabled={!one} onClick={() => one && setPreview(one)}>👁 Open</button>
          <button className="fa-btn" disabled={!one} onClick={() => one && setDetails(one)}>ℹ Details</button>
          <button className="fa-btn" onClick={() => selectedFiles.forEach(downloadFile)}>⬇ Download</button>
          {isDrive && <button className="fa-btn" disabled={!movableSelected.length} onClick={() => setMoving(movableSelected)}>📂 Move</button>}
          <button className="fa-btn danger" onClick={deleteSelected}>🗑 Delete</button>
          <button className="fa-btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {isDrive && <p className="files-drive-hint muted">A shared team Drive — everyone can see and download these files. You can only delete files you uploaded.</p>}

      {loading && files.length === 0 && folders.length === 0 ? (
        <p className="muted" style={{ padding: 20 }}>Loading…</p>
      ) : nothingHere ? (
        <div className="empty-hint" style={{ padding: 20 }}>{emptyMsg}</div>
      ) : view === 'details' ? (
        <div className="files-table-wrap">
          <table className="files-table">
            <thead>
              <tr>
                <th className="fx-check"><input type="checkbox" checked={sorted.length > 0 && selected.size === sorted.length} onChange={toggleAll} /></th>
                <th className="fx-name" onClick={() => setSortKey('name')}>Name{arrow('name')}</th>
                <th className="fx-owner" onClick={() => setSortKey('owner')}>Owner{arrow('owner')}</th>
                <th className="fx-date" onClick={() => setSortKey('date')}>Shared on{arrow('date')}</th>
                <th className="fx-size" onClick={() => setSortKey('size')}>Size{arrow('size')}</th>
              </tr>
            </thead>
            <tbody>
              {isDrive && !searching && folders.map((f) => (
                <tr key={`folder-${f.id}`} className="folder-row">
                  <td className="fx-check" />
                  <td className="fx-name" onClick={() => openFolder(f.id)}>
                    <span className="file-icon sm">📁</span>
                    <span className="fx-filename">{f.name}</span>
                    {canManageFolder(f) && (
                      <span className="folder-row-actions">
                        <button title="Rename" onClick={(e) => { e.stopPropagation(); renameFolder(f); }}>✎</button>
                        <button title="Delete" onClick={(e) => { e.stopPropagation(); deleteFolder(f); }}>🗑</button>
                      </span>
                    )}
                  </td>
                  <td className="fx-owner"><span className="muted">{f.created_by_name}</span></td>
                  <td className="fx-date muted">{formatDateTime(f.created_at)}</td>
                  <td className="fx-size muted">{f.files + f.subs === 0 ? 'Empty' : `${f.subs ? `${f.subs} folder${f.subs === 1 ? '' : 's'}` : ''}${f.subs && f.files ? ', ' : ''}${f.files ? `${f.files} file${f.files === 1 ? '' : 's'}` : ''}`}</td>
                </tr>
              ))}
              {sorted.map((f) => (
                <tr key={f.id} className={selected.has(f.id) ? 'sel' : ''}>
                  <td className="fx-check"><input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td className="fx-name" onClick={() => setPreview(f)}>
                    {f.mime_type?.startsWith('image/') ? <img className="file-thumb sm" src={fileUrl(f.id)} alt="" /> : <span className="file-icon sm">{iconFor(f.mime_type, f.original_name)}</span>}
                    <span className="fx-filename">{f.original_name}</span>
                    {!isDrive && <span className="fx-context muted">{f.context}</span>}
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
          {isDrive && !searching && folders.map((f) => (
            <div key={`folder-${f.id}`} className="file-card folder-card">
              <button className="file-card-body" onClick={() => openFolder(f.id)}>
                <span className="file-card-icon">📁</span>
                <span className="file-card-name">{f.name}</span>
                <span className="file-card-owner muted">{f.files + f.subs === 0 ? 'Empty' : `${f.files} file${f.files === 1 ? '' : 's'}`}</span>
              </button>
              {canManageFolder(f) && (
                <span className="folder-card-actions">
                  <button title="Rename" onClick={() => renameFolder(f)}>✎</button>
                  <button title="Delete" onClick={() => deleteFolder(f)}>🗑</button>
                </span>
              )}
            </div>
          ))}
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

      <div className="files-foot muted">SELECTED: {selected.size} / {sorted.length}{isDrive && folders.length ? ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''}</div>

      {isDrive && dragging && (
        <div className="files-drop-overlay"><div className="files-drop-inner">⬆<br />Drop files to upload here</div></div>
      )}

      {preview && <FilePreviewModal file={preview} onClose={() => setPreview(null)} />}
      {details && <FileDetails file={details} onClose={() => setDetails(null)} onOpen={() => { setPreview(details); setDetails(null); }} />}
      {moving && (
        <MoveModal
          files={moving} currentFolder={folderId}
          onClose={() => setMoving(null)}
          onMoved={() => { setMoving(null); load(query, folderId); }}
        />
      )}
    </div>
  );
}

// Pick a destination folder for the selected files. Loads the flat folder list
// and lets the user choose the root or any folder.
function MoveModal({ files, currentFolder, onClose, onMoved }) {
  const [folders, setFolders] = useState([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/drive/folders').then((d) => setFolders(d.folders || [])).catch(() => {}); }, []);

  async function move() {
    setBusy(true);
    const folder_id = target === '' ? null : Number(target);
    for (const f of files) { try { await api(`/drive/${f.id}`, { method: 'PATCH', body: { folder_id } }); } catch { /* skip */ } }
    setBusy(false);
    onMoved();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="modal-header"><strong>Move {files.length} file{files.length === 1 ? '' : 's'}</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: '4px 4px 12px' }}>
          <label className="muted" style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Destination folder</label>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: '100%' }}>
            <option value="">💾 Drive (root)</option>
            {folders.map((f) => <option key={f.id} value={f.id} disabled={f.id === currentFolder}>📁 {f.name}{f.id === currentFolder ? ' (current)' : ''}</option>)}
          </select>
        </div>
        <div className="editor-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={move}>{busy ? 'Moving…' : 'Move here'}</button>
        </div>
      </div>
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
