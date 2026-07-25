import React, { useRef, useState } from 'react';
import { downloadTaskTemplate, importTasks } from '../api.js';

// Bulk-create tasks from a filled spreadsheet. Download the template, fill it in
// Excel, then drag it in (or browse) and import. A per-row summary shows what was
// created and what was skipped, so nothing fails silently.
export default function TaskImportModal({ onClose, onImported }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { created, errors:[] }
  const [dragOver, setDragOver] = useState(false);

  const getTemplate = async () => {
    setError(null);
    try { await downloadTaskTemplate(); }
    catch (e) { setError(e.message); }
  };

  const pick = (f) => {
    if (!f) return;
    const ok = /\.(xlsx|csv)$/i.test(f.name);
    if (!ok) { setError('Please choose a .xlsx (or .csv) file.'); return; }
    setFile(f); setResult(null); setError(null);
  };

  const reset = () => { setFile(null); setResult(null); setError(null); if (fileRef.current) fileRef.current.value = ''; };

  const run = async () => {
    if (!file || busy) return;                 // guard against a double-click
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await importTasks(file);
      setResult(res);
      if (res.created > 0) onImported?.();
      // Clear the file the moment it's imported, so pressing Import again can't
      // create the same tasks a second time. Drop another file to import more.
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    pick(e.dataTransfer?.files?.[0]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal imp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Import Bulk Task</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body imp-body">
          <ol className="imp-steps">
            <li><b>Download the template</b> — it lists your boards, people, projects &amp; clients on a Reference sheet.</li>
            <li><b>Fill one task per row</b> in Excel. Only <b>Title</b> is required.</li>
            <li><b>Drop the file below</b> (or browse) and import them all at once.</li>
          </ol>

          <button className="imp-tpl-btn" onClick={getTemplate}>
            <span aria-hidden>⬇</span> Download Excel template
          </button>

          <div
            className={`imp-drop ${dragOver ? 'over' : ''} ${file ? 'has-file' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              hidden
              onChange={(e) => pick(e.target.files?.[0])}
            />
            {file ? (
              <div className="imp-file">
                <span className="imp-file-icon" aria-hidden>📄</span>
                <span className="imp-file-name">{file.name}</span>
                <button className="imp-file-x" onClick={(e) => { e.stopPropagation(); reset(); }} aria-label="Remove file">✕</button>
              </div>
            ) : (
              <div className="imp-drop-hint">
                <div className="imp-drop-icon" aria-hidden>⬆</div>
                <div><b>Drag &amp; drop</b> your filled sheet here</div>
                <div className="imp-drop-sub">or click to browse — .xlsx or .csv</div>
              </div>
            )}
          </div>

          {error && <div className="imp-error">{error}</div>}

          {result && (
            <div className="imp-result">
              <div className="imp-ok">✓ Created {result.created} task{result.created === 1 ? '' : 's'}.</div>
              {result.errors?.length > 0 && (
                <div className="imp-skipped">
                  <div className="imp-skipped-head">{result.errors.length} row{result.errors.length === 1 ? '' : 's'} skipped:</div>
                  <ul>
                    {result.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                  </ul>
                </div>
              )}
              <div className="imp-result-sub">Drop another file to import more.</div>
            </div>
          )}
        </div>

        <div className="modal-footer imp-footer">
          <button className="btn btn-sm" onClick={reset} disabled={busy || (!file && !result)}>Reset</button>
          <span className="imp-footer-spacer" />
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="imp-import-btn" disabled={!file || busy} onClick={run}>
            {busy ? 'Importing…' : 'Import Bulk Task'}
          </button>
        </div>
      </div>
    </div>
  );
}
