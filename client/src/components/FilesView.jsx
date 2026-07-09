import React, { useEffect, useState, useCallback } from 'react';
import { api, fileUrl } from '../api.js';
import { formatBytes, formatDateTime } from '../format.js';
import Avatar from './Avatar.jsx';

// Every file shared across the user's conversations and tasks, with who
// shared it, where, and a search box.
export default function FilesView() {
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const d = await api(`/files${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      setFiles(d.files);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { const t = setTimeout(() => load(query), 200); return () => clearTimeout(t); }, [query, load]);

  return (
    <div className="files-page">
      <header className="files-head">
        <h2>Files</h2>
        <input className="files-search" placeholder="Search files, people or places…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>

      {loading && files.length === 0 ? (
        <p className="muted" style={{ padding: 20 }}>Loading…</p>
      ) : files.length === 0 ? (
        <div className="empty-hint" style={{ padding: 20 }}>{query ? `No files match “${query}”.` : 'No files have been shared yet.'}</div>
      ) : (
        <div className="files-list">
          {files.map((f) => (
            <a key={f.id} className="file-row" href={fileUrl(f.id)} target="_blank" rel="noopener noreferrer">
              {f.mime_type?.startsWith('image/')
                ? <img className="file-thumb" src={fileUrl(f.id)} alt="" />
                : <span className="file-icon">{iconFor(f.mime_type, f.original_name)}</span>}
              <div className="file-main">
                <div className="file-name">{f.original_name}</div>
                <div className="file-sub">
                  <span className="file-context">{f.context}</span>
                  <span className="muted">· {formatBytes(f.size)}</span>
                </div>
              </div>
              <div className="file-meta">
                <span className="file-sharer">
                  <Avatar user={{ name: f.uploader_name, avatar_color: f.uploader_color }} size={20} /> {f.uploader_name}
                </span>
                <span className="muted">{formatDateTime(f.created_at)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function iconFor(mime, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime?.startsWith('video/')) return '🎬';
  if (mime?.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf' || ext === 'pdf') return '📕';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}
