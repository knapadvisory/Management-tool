import React, { useRef, useState } from 'react';
import { downloadTaskTemplate, importTasks } from '../api.js';

// Bulk-create tasks from a filled spreadsheet. Two steps: download the template,
// fill it in Excel, upload it back. Shows a per-row summary so nothing fails
// silently.
export default function TaskImportModal({ onClose, onImported }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { created, errors:[] }

  const getTemplate = async () => {
    setError(null);
    try { await downloadTaskTemplate(); }
    catch (e) { setError(e.message); }
  };

  const run = async () => {
    if (!file) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await importTasks(file);
      setResult(res);
      if (res.created > 0) onImported?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Import tasks from Excel</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7, color: 'var(--muted, #64748b)' }}>
            <li><b>Download the template</b> — it lists your boards, people, projects and clients on a Reference sheet.</li>
            <li><b>Fill one task per row</b> in Excel. Only <b>Title</b> is required.</li>
            <li><b>Upload the file</b> below to create them all at once.</li>
          </ol>

          <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={getTemplate}>
            ⬇ Download Excel template
          </button>

          <div
            className="import-drop"
            onClick={() => fileRef.current?.click()}
            style={{ border: '1.5px dashed var(--border, #cbd5e1)', borderRadius: 10, padding: 20, textAlign: 'center', cursor: 'pointer' }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              style={{ display: 'none' }}
              onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(null); }}
            />
            {file
              ? <span>📄 {file.name}</span>
              : <span style={{ color: 'var(--muted, #64748b)' }}>Click to choose a filled <b>.xlsx</b> (or .csv) file</span>}
          </div>

          {error && <div className="form-error" style={{ color: '#dc2626' }}>{error}</div>}

          {result && (
            <div style={{ background: 'var(--surface-2, #f1f5f9)', borderRadius: 8, padding: 12 }}>
              <div style={{ color: '#16a34a', fontWeight: 600 }}>✓ Created {result.created} task{result.created === 1 ? '' : 's'}.</div>
              {result.errors?.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ color: '#b45309', fontWeight: 600 }}>{result.errors.length} row{result.errors.length === 1 ? '' : 's'} skipped:</div>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 20, maxHeight: 160, overflowY: 'auto', fontSize: 13 }}>
                    {result.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-sm" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
          <button className="btn btn-primary" disabled={!file || busy} onClick={run}>
            {busy ? 'Importing…' : 'Import tasks'}
          </button>
        </div>
      </div>
    </div>
  );
}
