import React, { useState } from 'react';
import { api } from '../api.js';
import { formatBytes, formatDateTime } from '../format.js';

const SORTS = [
  { key: 'deleted', label: 'Deleted date' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
  { key: 'owner', label: 'Owner' },
];

function iconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['xls', 'xlsx', 'xlsm', 'csv'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (ext === 'pdf') return '📕';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return '🖼️';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}

// The admin archive as a searchable, sortable, multi-select file manager.
export default function ArchiveManager({ files, onReload }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'deleted', dir: -1 });
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const filtered = files.filter((f) =>
    !q || f.original_name.toLowerCase().includes(q) ||
    (f.uploader_name || '').toLowerCase().includes(q) ||
    (f.deleted_by_name || '').toLowerCase().includes(q));

  const sorted = [...filtered].sort((a, b) => {
    const { key, dir } = sort;
    let av, bv;
    if (key === 'name') { av = a.original_name.toLowerCase(); bv = b.original_name.toLowerCase(); }
    else if (key === 'owner') { av = (a.uploader_name || '').toLowerCase(); bv = (b.uploader_name || '').toLowerCase(); }
    else if (key === 'size') { av = a.size; bv = b.size; }
    else { av = a.archived_at || ''; bv = b.archived_at || ''; }
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const setSortKey = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' || key === 'owner' ? 1 : -1 }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((s) => (s.size === sorted.length ? new Set() : new Set(sorted.map((f) => f.id))));
  const selectedFiles = sorted.filter((f) => selected.has(f.id));

  async function run(ids, kind) {
    setBusy(true);
    for (const id of ids) {
      try {
        if (kind === 'restore') await api(`/admin/files/${id}/restore`, { method: 'POST' });
        else await api(`/admin/files/${id}`, { method: 'DELETE' });
      } catch { /* skip */ }
    }
    setBusy(false);
    setSelected(new Set());
    onReload();
  }

  const restoreSelected = () => run([...selected], 'restore');
  const purgeSelected = () => {
    if (!confirm(`Permanently delete ${selected.size} file${selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
    run([...selected], 'purge');
  };

  return (
    <div className="archive-mgr">
      <div className="archive-controls">
        <input className="files-search" placeholder="Search by file, owner or who deleted it…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="files-sort">
          <select value={sort.key} onChange={(e) => setSortKey(e.target.value)}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>By {s.label.toLowerCase()}</option>)}
          </select>
        </label>
        <button className="files-dir" title="Reverse order" onClick={() => setSort((s) => ({ ...s, dir: -s.dir }))}>{sort.dir === 1 ? '↑' : '↓'}</button>
      </div>

      {selected.size > 0 && (
        <div className="files-actionbar">
          <span className="files-selected-count">Selected: {selected.size}</span>
          <span className="files-actionbar-sep" />
          <button className="fa-btn" disabled={busy} onClick={restoreSelected}>↩ Restore</button>
          <button className="fa-btn danger" disabled={busy} onClick={purgeSelected}>🗑 Delete permanently</button>
          <button className="fa-btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="empty-hint" style={{ padding: 16 }}>{q ? `No archived files match “${query}”.` : 'No deleted files.'}</div>
      ) : (
        <div className="files-table-wrap">
          <table className="files-table archive-table">
            <thead>
              <tr>
                <th className="fx-check"><input type="checkbox" checked={selected.size === sorted.length} onChange={toggleAll} /></th>
                <th className="fx-name" onClick={() => setSortKey('name')}>Name{arrow('name')}</th>
                <th className="fx-owner" onClick={() => setSortKey('owner')}>Owner{arrow('owner')}</th>
                <th>Deleted by</th>
                <th className="fx-date" onClick={() => setSortKey('deleted')}>Deleted on{arrow('deleted')}</th>
                <th className="fx-size" onClick={() => setSortKey('size')}>Size{arrow('size')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => (
                <tr key={f.id} className={selected.has(f.id) ? 'sel' : ''}>
                  <td className="fx-check"><input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} /></td>
                  <td className="fx-name"><span className="file-icon sm">{iconFor(f.original_name)}</span> <span className="fx-filename">{f.original_name}</span></td>
                  <td className="fx-owner muted">{f.uploader_name}</td>
                  <td className="muted">{f.deleted_by_name || '—'}</td>
                  <td className="fx-date muted">{formatDateTime(f.archived_at)}</td>
                  <td className="fx-size muted">{formatBytes(f.size)}</td>
                  <td className="archive-row-actions">
                    <button className="btn btn-sm" disabled={busy} onClick={() => run([f.id], 'restore')}>Restore</button>
                    <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { if (confirm(`Permanently delete “${f.original_name}”?`)) run([f.id], 'purge'); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="files-foot muted">Showing {sorted.length} of {files.length} archived file{files.length === 1 ? '' : 's'}</div>
    </div>
  );
}
