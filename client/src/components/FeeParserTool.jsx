// Staff-only "Marketplace Fee Register" tool page.
// Drops marketplace fee PDFs, gets one reconciled Excel register back. The
// server does the parsing (Python) and enforces staff-only access; this page
// is also only shown to non-guests (see App/Sidebar).
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { getToken } from '../api.js';

const API = '/api/tools/fee-parser';

// Module-level so a half-done batch survives leaving the tool and coming back
// (File objects stay in memory for the session; cleared on send).
const keep = { files: [], result: null };

// Authenticated fetch using TeamHub's JWT (localStorage teamhub_token).
function apiFetch(url, opts = {}) {
  const token = getToken();
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

export default function FeeParserTool() {
  const [files, setFiles] = useState(keep.files);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(keep.result);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  // Mirror to the module store so navigating away and back restores the batch.
  useEffect(() => { keep.files = files; }, [files]);
  useEffect(() => { keep.result = result; }, [result]);

  const addFiles = useCallback((list) => {
    const pdfs = Array.from(list).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    setFiles((prev) => [...prev, ...pdfs]);
    setResult(null); setError('');
  }, []);

  const onDrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };

  async function process() {
    setBusy(true); setError('');
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    try {
      const r = await apiFetch(`${API}/process`, { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Processing failed.');
      setResult(data); setFiles([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const r = await apiFetch(`${API}/download/${result.token}`);
    if (!r.ok) { setError('Download expired — please process again.'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Fee_Register.xlsx'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="feeparser">
      <div className="feeparser-head">
        <h2>Marketplace Fee Register</h2>
        {result?.version && <span className="feeparser-ver">parser {result.version}</span>}
      </div>
      <p className="muted feeparser-lede">
        Drop this month’s marketplace fee documents. Each PDF is read, split by fee type,
        GST separated, a TDS section mapped, and reconciled against its printed total —
        then compiled into one Excel register. Files are processed on the server and discarded.
      </p>

      <div
        className={`feeparser-drop ${busy ? 'busy' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        role="button" tabIndex={0}
      >
        <strong className="feeparser-drop-h">Drop invoice PDFs here</strong>
        <div className="feeparser-drop-p">or click to browse — invoices and credit notes together</div>
        <div className="feeparser-marks">AMAZON · FLIPKART · MYNTRA · NYKAA</div>
      </div>
      <input ref={inputRef} type="file" multiple accept="application/pdf"
             style={{ display: 'none' }} onChange={(e) => addFiles(e.target.files)} />

      {files.length > 0 && (
        <div className="feeparser-selected">
          <ul className="feeparser-list">
            {files.map((f, i) => (
              <li key={i} className="feeparser-li">
                <span className="feeparser-fn">{f.name}</span>
                <button className="feeparser-rm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ul>
          <button className="btn btn-primary" disabled={busy} onClick={process}>
            {busy ? 'Reading documents…' : `Generate register (${files.length})`}
          </button>
        </div>
      )}

      {error && <div className="feeparser-err">{error}</div>}

      {result && (
        <div className="feeparser-result">
          <div className="feeparser-summary">
            <span className="feeparser-sumN">{result.ok} of {result.total}</span>
            <span className="muted">
              {result.ok === result.total ? 'documents reconciled cleanly'
                : 'reconciled — the rest need a manual check'}
            </span>
          </div>
          <div className="feeparser-ledger">
            {result.rows.map((row, i) => {
              const ok = row.status === 'OK';
              return (
                <div key={i} className="feeparser-row">
                  <span className={`feeparser-tick ${ok ? 'ok' : 'check'}`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="feeparser-doc">{row.doc}</div>
                    <div className="feeparser-rdetail">{row.detail}</div>
                  </div>
                  <span className={`feeparser-chip ${ok ? 'ok' : 'check'}`}>{row.status}</span>
                </div>
              );
            })}
          </div>
          <div className="feeparser-actions">
            <button className="btn btn-primary" onClick={download}>Download Excel register</button>
            <button className="btn" onClick={() => { setResult(null); setFiles([]); }}>Process another batch</button>
          </div>
          <p className="muted feeparser-note">Rows marked <b>CHECK</b> did not match their printed total — open those PDFs and verify before filing.</p>
        </div>
      )}
    </div>
  );
}
