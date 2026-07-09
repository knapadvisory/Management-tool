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
export default function FilesView({ user, users = [], mode = 'files' }) {
  const isDrive = mode === 'drive';
  const endpoint = isDrive ? '/drive' : '/files';
  const team = users.filter((u) => u.id !== user.id);

  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [path, setPath] = useState([]); // breadcrumb ancestors
  const [folderId, setFolderId] = useState(null); // current folder (Drive)
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [details, setDetails] = useState(null);
  const [moving, setMoving] = useState(null); // files pending a "move to folder"
  const [sharing, setSharing] = useState(null); // files pending a "share with" edit
  const [pending, setPending] = useState(null); // files chosen, awaiting the upload dialog
  const [view, setView] = useState('details'); // 'details' | 'grid'
  const [sort, setSort] = useState({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [clipboard, setClipboard] = useState(null); // { mode:'copy'|'cut', files:[...] }
  const [menu, setMenu] = useState(null); // { x, y, kind:'file'|'folder'|'bg', item }
  const inputRef = useRef(null);
  const folderInputRef = useRef(null);
  const dragDepth = useRef(0);
  const selectedFilesRef = useRef([]);
  const clipboardRef = useRef(null);

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

  // Keyboard: Ctrl/Cmd C/X copy or cut the selection, Ctrl/Cmd V pastes into
  // the current folder. Ignored while typing in a field.
  useEffect(() => {
    if (!isDrive) return;
    const onKey = (e) => {
      if (menu) setMenu(null);
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && selectedFilesRef.current.length) { e.preventDefault(); copyToClipboard(selectedFilesRef.current, 'copy'); }
      else if (k === 'x' && selectedFilesRef.current.length) { e.preventDefault(); copyToClipboard(selectedFilesRef.current, 'cut'); }
      else if (k === 'v' && clipboardRef.current) { e.preventDefault(); paste(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrive, menu, folderId, query]);

  // Close the context menu on any outside click or scroll.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);

  const searching = isDrive && !!query.trim();

  // Choosing/dropping files opens the upload dialog (name + tag people) rather
  // than uploading straight away.
  function chooseFiles(list) {
    const arr = Array.from(list || []);
    if (arr.length) setPending(arr);
  }

  // Files picked via a folder input carry webkitRelativePath ("dir/sub/file");
  // rebuild that folder structure in the Drive, then upload.
  async function uploadFolderInput(list) {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    setUploading(true);
    try {
      const cache = new Map(); // relative dir path -> Drive folder id
      cache.set('', folderId);
      const ensureDir = async (dirPath) => {
        if (cache.has(dirPath)) return cache.get(dirPath);
        const parts = dirPath.split('/');
        const name = parts.pop();
        const parentId = await ensureDir(parts.join('/'));
        const { folder } = await api('/drive/folders', { method: 'POST', body: { name, parent_id: parentId } });
        cache.set(dirPath, folder.id);
        return folder.id;
      };
      const byDir = new Map();
      for (const f of arr) {
        const rel = f.webkitRelativePath || f.name;
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(f);
      }
      for (const [dir, list2] of byDir) {
        const target = await ensureDir(dir);
        for (let i = 0; i < list2.length; i += 25) await uploadToDrive(list2.slice(i, i + 25), target, []);
      }
      await load(query, folderId);
    } catch (err) { alert(err.message || 'Upload failed'); }
    finally { setUploading(false); }
  }

  function openMenu(e, kind, item) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, kind, item });
  }

  async function confirmUpload(arr, sharedWith) {
    setPending(null);
    setUploading(true);
    try { await uploadToDrive(arr, folderId, sharedWith); await load(query, folderId); }
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
    if (!isDrive) return;
    // If whole folders were dropped, recreate their structure; otherwise treat
    // it as a plain multi-file upload (which opens the tag dialog).
    const items = e.dataTransfer?.items ? Array.from(e.dataTransfer.items) : [];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.some((en) => en.isDirectory)) { uploadEntries(entries); return; }
    if (e.dataTransfer?.files?.length) chooseFiles(e.dataTransfer.files);
  }

  // Walk dropped filesystem entries, recreating any folders in the Drive and
  // uploading files into the folder that mirrors their location.
  async function uploadEntries(entries) {
    setUploading(true);
    try {
      const readEntries = (reader) => new Promise((resolve) => reader.readEntries(resolve));
      const fileOf = (entry) => new Promise((resolve) => entry.file(resolve));
      // Depth-first walk; create each directory then queue its files.
      const walk = async (entry, parentId) => {
        if (entry.isFile) {
          const file = await fileOf(entry);
          batches.push({ file, parentId });
        } else if (entry.isDirectory) {
          const { folder } = await api('/drive/folders', { method: 'POST', body: { name: entry.name, parent_id: parentId } });
          const reader = entry.createReader();
          let children = [];
          let chunk;
          do { chunk = await readEntries(reader); children = children.concat(chunk); } while (chunk.length);
          for (const c of children) await walk(c, folder.id);
        }
      };
      const batches = [];
      for (const en of entries) await walk(en, folderId);
      // Upload files grouped by their target folder, in reasonable chunks.
      const byFolder = new Map();
      for (const b of batches) { const k = b.parentId ?? 'root'; if (!byFolder.has(k)) byFolder.set(k, { parentId: b.parentId, files: [] }); byFolder.get(k).files.push(b.file); }
      for (const { parentId, files: list } of byFolder.values()) {
        for (let i = 0; i < list.length; i += 25) await uploadToDrive(list.slice(i, i + 25), parentId, []);
      }
      await load(query, folderId);
    } catch (err) { alert(err.message || 'Upload failed'); }
    finally { setUploading(false); }
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
  selectedFilesRef.current = selectedFiles;
  clipboardRef.current = clipboard;
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

  async function renameFile(f) {
    const name = prompt('Rename file', f.original_name);
    if (!name || !name.trim() || name.trim() === f.original_name) return;
    try { await api(`/drive/${f.id}`, { method: 'PATCH', body: { name: name.trim() } }); await load(query, folderId); }
    catch (err) { alert(err.message); }
  }
  async function deleteFile(f) {
    if (f.uploader_id !== user.id) { alert('You can only delete files you uploaded.'); return; }
    if (!confirm(`Delete “${f.original_name}”? It'll be removed from the Drive.`)) return;
    try { await api(`/drive/${f.id}`, { method: 'DELETE' }); await load(query, folderId); }
    catch (err) { alert(err.message); }
  }

  // Clipboard: copy/cut selected (or a single) file(s), then paste into the
  // current folder. Cut = move; copy = server-side duplicate.
  function copyToClipboard(fileList, mode) {
    const arr = (fileList && fileList.length ? fileList : selectedFiles);
    if (!arr.length) return;
    setClipboard({ mode, files: arr });
  }
  async function paste() {
    const cb = clipboardRef.current;
    if (!cb || !isDrive) return;
    const { mode, files: cbFiles } = cb;
    setUploading(true);
    try {
      for (const f of cbFiles) {
        if (mode === 'copy') {
          await api(`/drive/${f.id}/copy`, { method: 'POST', body: { folder_id: folderId } });
        } else if (f.uploader_id === user.id || user.role === 'admin') {
          await api(`/drive/${f.id}`, { method: 'PATCH', body: { folder_id: folderId } });
        }
      }
      if (mode === 'cut') setClipboard(null);
      await load(query, folderId);
    } catch (err) { alert(err.message); }
    finally { setUploading(false); }
  }

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
      onContextMenu={isDrive && !searching ? (e) => openMenu(e, 'bg', null) : undefined}
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
              {clipboard && <button className="btn files-paste-btn" disabled={uploading} onClick={paste} title="Paste here (Ctrl+V)">📋 Paste {clipboard.files.length} ({clipboard.mode})</button>}
              <button className="btn files-newfolder-btn" onClick={newFolder}>📁 New folder</button>
              <button className="btn files-newfolder-btn" disabled={uploading} onClick={() => folderInputRef.current?.click()} title="Upload a whole folder">📂 Folder</button>
              <button className="btn btn-primary files-upload-btn" disabled={uploading} onClick={() => inputRef.current?.click()}>
                {uploading ? 'Uploading…' : '⬆ Upload'}
              </button>
              <input ref={inputRef} type="file" multiple hidden onChange={(e) => { chooseFiles(e.target.files); e.target.value = ''; }} />
              <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple hidden onChange={(e) => { uploadFolderInput(e.target.files); e.target.value = ''; }} />
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
          {isDrive && <button className="fa-btn" disabled={!movableSelected.length} onClick={() => setSharing(movableSelected)}>🏷 Tag people</button>}
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
                {isDrive && <th className="fx-shared">Shared with</th>}
                <th className="fx-date" onClick={() => setSortKey('date')}>Shared on{arrow('date')}</th>
                <th className="fx-size" onClick={() => setSortKey('size')}>Size{arrow('size')}</th>
              </tr>
            </thead>
            <tbody>
              {isDrive && !searching && folders.map((f) => (
                <tr key={`folder-${f.id}`} className="folder-row" onContextMenu={(e) => openMenu(e, 'folder', f)}>
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
                  {isDrive && <td className="fx-shared muted">—</td>}
                  <td className="fx-date muted">{formatDateTime(f.created_at)}</td>
                  <td className="fx-size muted">{f.files + f.subs === 0 ? 'Empty' : `${f.subs ? `${f.subs} folder${f.subs === 1 ? '' : 's'}` : ''}${f.subs && f.files ? ', ' : ''}${f.files ? `${f.files} file${f.files === 1 ? '' : 's'}` : ''}`}</td>
                </tr>
              ))}
              {sorted.map((f) => (
                <tr key={f.id} className={selected.has(f.id) ? 'sel' : ''} onContextMenu={(e) => openMenu(e, 'file', f)}>
                  <td className="fx-check"><input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td className="fx-name" onClick={() => setPreview(f)}>
                    {f.mime_type?.startsWith('image/') ? <img className="file-thumb sm" src={fileUrl(f.id)} alt="" /> : <span className="file-icon sm">{iconFor(f.mime_type, f.original_name)}</span>}
                    <span className="fx-filename">{f.original_name}</span>
                    {!isDrive && <span className="fx-context muted">{f.context}</span>}
                  </td>
                  <td className="fx-owner"><Avatar user={{ name: f.uploader_name, avatar_color: f.uploader_color }} size={20} /> <span>{f.uploader_name}</span></td>
                  {isDrive && (
                    <td className="fx-shared">
                      {f.shared_with?.length ? (
                        <span className="shared-avatars">
                          {f.shared_with.slice(0, 3).map((p) => (
                            <span key={p.id} className="shared-avatar" title={p.name}><Avatar user={p} size={20} /></span>
                          ))}
                          {f.shared_with.length > 3 && <span className="shared-more">+{f.shared_with.length - 3}</span>}
                          {f.shared_with.length === 1 && <span className="shared-name">{f.shared_with[0].name}</span>}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                  )}
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
            <div key={`folder-${f.id}`} className="file-card folder-card" onContextMenu={(e) => openMenu(e, 'folder', f)}>
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
            <div key={f.id} className={`file-card ${selected.has(f.id) ? 'sel' : ''}`} onContextMenu={(e) => openMenu(e, 'file', f)}>
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
      {pending && (
        <UploadDialog
          files={pending} team={team} uploading={uploading}
          onCancel={() => setPending(null)}
          onConfirm={(ids) => confirmUpload(pending, ids)}
        />
      )}
      {sharing && (
        <ShareModal
          files={sharing} team={team}
          onClose={() => setSharing(null)}
          onSaved={() => { setSharing(null); load(query, folderId); }}
        />
      )}
      {menu && (
        <ContextMenu
          menu={menu} user={user} clipboard={clipboard} canManageFolder={canManageFolder}
          onClose={() => setMenu(null)}
          actions={{
            openFile: (f) => setPreview(f),
            openFolder,
            download: (f) => downloadFile(f),
            copy: (f) => copyToClipboard([f], 'copy'),
            cut: (f) => copyToClipboard([f], 'cut'),
            paste,
            renameFile, deleteFile, renameFolder, deleteFolder,
            move: (f) => setMoving([f]),
            tag: (f) => setSharing([f]),
            details: (f) => setDetails(f),
            newFolder,
            upload: () => inputRef.current?.click(),
          }}
        />
      )}
    </div>
  );
}

// Right-click menu for a file, a folder, or the empty background.
function ContextMenu({ menu, user, clipboard, canManageFolder, onClose, actions }) {
  const { x, y, kind, item } = menu;
  const run = (fn, arg) => (e) => { e.stopPropagation(); onClose(); fn(arg); };
  const style = { top: Math.min(y, window.innerHeight - 320), left: Math.min(x, window.innerWidth - 210) };
  const canEditFile = item && (item.uploader_id === user.id || user.role === 'admin');

  return (
    <div className="ctx-menu" style={style} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {kind === 'file' && (
        <>
          <button onClick={run(actions.openFile, item)}>👁 Open</button>
          <button onClick={run(actions.download, item)}>⬇ Download</button>
          <div className="ctx-sep" />
          <button onClick={run(actions.copy, item)}>⧉ Copy <span className="ctx-kbd">Ctrl+C</span></button>
          {canEditFile && <button onClick={run(actions.cut, item)}>✂ Cut <span className="ctx-kbd">Ctrl+X</span></button>}
          {clipboard && <button onClick={run(actions.paste)}>📋 Paste <span className="ctx-kbd">Ctrl+V</span></button>}
          {canEditFile && <button onClick={run(actions.move, item)}>📂 Move to…</button>}
          {canEditFile && <button onClick={run(actions.renameFile, item)}>✎ Rename</button>}
          {canEditFile && <button onClick={run(actions.tag, item)}>🏷 Tag people</button>}
          <div className="ctx-sep" />
          <button onClick={run(actions.details, item)}>ℹ Details</button>
          {canEditFile && <button className="danger" onClick={run(actions.deleteFile, item)}>🗑 Delete</button>}
        </>
      )}
      {kind === 'folder' && (
        <>
          <button onClick={run(actions.openFolder, item.id)}>📂 Open</button>
          {clipboard && <button onClick={run(actions.paste)}>📋 Paste here <span className="ctx-kbd">Ctrl+V</span></button>}
          {canManageFolder(item) && <div className="ctx-sep" />}
          {canManageFolder(item) && <button onClick={run(actions.renameFolder, item)}>✎ Rename</button>}
          {canManageFolder(item) && <button className="danger" onClick={run(actions.deleteFolder, item)}>🗑 Delete</button>}
        </>
      )}
      {kind === 'bg' && (
        <>
          <button onClick={run(actions.newFolder)}>📁 New folder</button>
          <button onClick={run(actions.upload)}>⬆ Upload files</button>
          {clipboard && <button onClick={run(actions.paste)}>📋 Paste {clipboard.files.length} here <span className="ctx-kbd">Ctrl+V</span></button>}
        </>
      )}
    </div>
  );
}

// A searchable checkbox list of teammates, used to tag people on a file.
function PeoplePicker({ team, selected, onToggle }) {
  const [q, setQ] = useState('');
  const shown = team.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="people-picker">
      <input className="people-picker-search" placeholder="Search teammates…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="people-picker-list">
        {shown.length === 0 && <p className="muted" style={{ padding: 8 }}>No teammates found.</p>}
        {shown.map((u) => (
          <label key={u.id} className={`people-picker-row ${selected.has(u.id) ? 'sel' : ''}`}>
            <input type="checkbox" checked={selected.has(u.id)} onChange={() => onToggle(u.id)} />
            <Avatar user={u} size={22} />
            <span>{u.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// Confirm an upload: review the files and optionally tag teammates.
function UploadDialog({ files, team, uploading, onCancel, onConfirm }) {
  const [selected, setSelected] = useState(() => new Set());
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal-header"><strong>Upload {files.length} file{files.length === 1 ? '' : 's'} to the Drive</strong><button className="icon-btn" onClick={onCancel}>✕</button></div>
        <div className="upload-dialog-files">
          {files.map((f, i) => <div key={i} className="upload-dialog-file"><span>{iconFor(f.type, f.name)}</span><span className="upload-dialog-fname" title={f.name}>{f.name}</span><span className="muted">{formatBytes(f.size)}</span></div>)}
        </div>
        <label className="muted upload-dialog-label">Tag people this file is for <span className="upload-dialog-optional">(optional)</span></label>
        <PeoplePicker team={team} selected={selected} onToggle={toggle} />
        <div className="editor-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={uploading} onClick={() => onConfirm([...selected])}>{uploading ? 'Uploading…' : `Upload${selected.size ? ` & tag ${selected.size}` : ''}`}</button>
        </div>
      </div>
    </div>
  );
}

// Edit who a set of already-uploaded files is tagged with. When exactly one
// file is selected its current tags are pre-checked.
function ShareModal({ files, team, onClose, onSaved }) {
  const [selected, setSelected] = useState(() => new Set(files.length === 1 ? (files[0].shared_with || []).map((p) => p.id) : []));
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  async function save() {
    setBusy(true);
    const user_ids = [...selected];
    for (const f of files) { try { await api(`/drive/${f.id}/shares`, { method: 'PATCH', body: { user_ids } }); } catch { /* skip */ } }
    setBusy(false);
    onSaved();
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal-header"><strong>Tag people on {files.length} file{files.length === 1 ? '' : 's'}</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        {files.length > 1 && <p className="muted" style={{ padding: '0 4px 8px' }}>The chosen tags replace any existing tags on all selected files.</p>}
        <PeoplePicker team={team} selected={selected} onToggle={toggle} />
        <div className="editor-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save tags'}</button>
        </div>
      </div>
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
    ...(file.shared_with?.length ? [['Shared with', file.shared_with.map((p) => p.name).join(', ')]] : []),
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
