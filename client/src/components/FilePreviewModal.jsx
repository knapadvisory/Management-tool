import React, { useEffect, useState } from 'react';
import { fileUrl } from '../api.js';
import { formatBytes } from '../format.js';

// In-app preview for common file types. Images, PDFs and text/CSV render
// inline; anything else (Office docs, etc.) offers a download instead.
export default function FilePreviewModal({ file, onClose }) {
  const url = fileUrl(file.id);
  const mime = file.mime_type || '';
  const ext = (file.original_name.split('.').pop() || '').toLowerCase();
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf' || ext === 'pdf';
  const isText = mime.startsWith('text/') || mime === 'application/json' || ['txt', 'csv', 'md', 'log', 'json', 'xml', 'yml', 'yaml'].includes(ext);

  const [text, setText] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!isText) return;
    let alive = true;
    fetch(url).then((r) => r.text()).then((t) => { if (alive) setText(t.slice(0, 200000)); }).catch(() => alive && setErr('Could not load a preview.'));
    return () => { alive = false; };
  }, [url, isText]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong className="preview-name" title={file.original_name}>{file.original_name}</strong>
          <div className="preview-head-actions">
            <span className="muted">{file.size ? formatBytes(file.size) : ''}</span>
            <a className="btn btn-sm" href={url} download={file.original_name}>⬇ Download</a>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="preview-body">
          {isImage && <img className="preview-image" src={url} alt={file.original_name} />}
          {isPdf && <iframe className="preview-frame" src={url} title={file.original_name} />}
          {isText && (err ? <div className="form-error">{err}</div> : text !== null ? <pre className="preview-text">{text}</pre> : <p className="muted">Loading…</p>)}
          {!isImage && !isPdf && !isText && (
            <div className="preview-none">
              <div className="preview-none-icon">📄</div>
              <p className="muted">A preview isn't available for this file type.</p>
              <a className="btn btn-primary" href={url} download={file.original_name}>Download to open</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
