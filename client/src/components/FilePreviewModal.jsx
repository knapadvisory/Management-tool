import React, { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { fileUrl } from '../api.js';
import { formatBytes } from '../format.js';

// In-app preview for common file types. Images / PDFs render natively; text,
// CSV, Excel (.xlsx) and Word (.docx) are rendered in-browser (the heavier
// parsers load on demand). Anything else offers a download.
export default function FilePreviewModal({ file, onClose }) {
  const url = fileUrl(file.id);
  const mime = file.mime_type || '';
  const ext = (file.original_name.split('.').pop() || '').toLowerCase();
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf' || ext === 'pdf';
  const isText = mime.startsWith('text/') || mime === 'application/json' || ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml'].includes(ext);
  const isCsv = ext === 'csv';
  const isSheet = ['xlsx'].includes(ext);
  const isDoc = ['docx'].includes(ext);

  const [state, setState] = useState({ kind: 'loading' });

  useEffect(() => {
    if (isImage || isPdf) { setState({ kind: 'native' }); return; }
    let alive = true;
    setState({ kind: 'loading' });

    (async () => {
      try {
        if (isCsv || isText) {
          const text = await (await fetch(url)).text();
          if (isCsv) { if (alive) setState({ kind: 'sheet', rows: parseCsv(text) }); }
          else if (alive) setState({ kind: 'text', text: text.slice(0, 300000) });
        } else if (isSheet) {
          const readXlsxFile = (await import('read-excel-file/browser')).default;
          const blob = await (await fetch(url)).blob();
          const rows = await readXlsxFile(blob);
          if (alive) setState({ kind: 'sheet', rows: rows.map((r) => r.map((c) => (c == null ? '' : String(c)))) });
        } else if (isDoc) {
          const mod = await import('mammoth/mammoth.browser');
          const mammoth = mod.default || mod;
          const arrayBuffer = await (await fetch(url)).arrayBuffer();
          const { value } = await mammoth.convertToHtml({ arrayBuffer });
          if (alive) setState({ kind: 'doc', html: DOMPurify.sanitize(value) });
        } else {
          if (alive) setState({ kind: 'none' });
        }
      } catch {
        if (alive) setState({ kind: 'error' });
      }
    })();

    return () => { alive = false; };
  }, [url, isImage, isPdf, isText, isCsv, isSheet, isDoc]);

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

          {state.kind === 'loading' && <p className="muted" style={{ margin: 'auto' }}>Loading preview…</p>}
          {state.kind === 'text' && <pre className="preview-text">{state.text}</pre>}
          {state.kind === 'doc' && <div className="preview-doc" dangerouslySetInnerHTML={{ __html: state.html }} />}
          {state.kind === 'sheet' && (
            <div className="preview-sheet-wrap">
              <table className="preview-sheet">
                <tbody>
                  {state.rows.map((row, i) => (
                    <tr key={i}>
                      <td className="preview-sheet-rownum">{i + 1}</td>
                      {row.map((cell, j) => (i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>))}
                    </tr>
                  ))}
                  {state.rows.length === 0 && <tr><td className="muted">Empty sheet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {(state.kind === 'none' || state.kind === 'error') && (
            <div className="preview-none">
              <div className="preview-none-icon">📄</div>
              <p className="muted">{state.kind === 'error' ? "Couldn't render a preview for this file." : "A preview isn't available for this file type."}</p>
              <a className="btn btn-primary" href={url} download={file.original_name}>Download to open</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Minimal CSV parser handling quoted fields and commas/newlines within quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== '')).slice(0, 2000);
}
