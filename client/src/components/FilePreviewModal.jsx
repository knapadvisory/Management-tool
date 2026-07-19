import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { fileUrl } from '../api.js';
import { formatBytes } from '../format.js';

// Normalise whatever read-excel-file hands back into [{ name, rows }].
// Its browser build returns [{ sheet, data }] (one entry per worksheet);
// other builds return a flat array of rows for the first sheet.
function normalizeSheets(raw) {
  const toStr = (rows) => (rows || []).map((r) => r.map((c) => (c == null ? '' : String(c))));
  if (Array.isArray(raw) && raw.length && raw[0] && Array.isArray(raw[0].data)) {
    return raw.map((s, i) => ({ name: s.sheet || `Sheet ${i + 1}`, rows: toStr(s.data) }));
  }
  return [{ name: 'Sheet 1', rows: toStr(Array.isArray(raw) ? raw : []) }];
}

// In-app preview for common file types. Images / PDFs render natively; text,
// CSV, Excel (.xlsx) and Word (.docx) are rendered in-browser (the heavier
// parsers load on demand). Anything else offers a download.
export default function FilePreviewModal({ file, files = [], onNavigate, onClose }) {
  const url = fileUrl(file.id);

  // Navigate between files in the current folder like a photo viewer:
  // ← / → keys, on-screen chevrons, and horizontal swipe on touch.
  const list = Array.isArray(files) && files.length ? files : [file];
  const idx = Math.max(0, list.findIndex((f) => f.id === file.id));
  const canNav = !!onNavigate && list.length > 1;
  const go = (delta) => {
    if (!canNav) return;
    const next = list[idx + delta];
    if (next) onNavigate(next);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Body-level swipe navigation for non-image previews (images get their own
  // swipe via ZoomableImage so it can coexist with pinch/pan).
  const touch = useRef(null);
  const onTouchStart = (e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e) => {
    if (!touch.current) return;
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    touch.current = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const mime = file.mime_type || '';
  const ext = (file.original_name.split('.').pop() || '').toLowerCase();
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf' || ext === 'pdf';
  const isText = mime.startsWith('text/') || mime === 'application/json' || ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml'].includes(ext);
  const isCsv = ext === 'csv';
  const isSheet = ['xlsx'].includes(ext);
  const isDoc = ['docx'].includes(ext);

  const [state, setState] = useState({ kind: 'loading' });
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    if (isImage || isPdf) { setState({ kind: 'native' }); return; }
    let alive = true;
    setState({ kind: 'loading' });
    setActiveSheet(0);

    (async () => {
      try {
        if (isCsv || isText) {
          const text = await (await fetch(url)).text();
          if (isCsv) { if (alive) setState({ kind: 'sheet', sheets: [{ name: 'Sheet 1', rows: parseCsv(text) }] }); }
          else if (alive) setState({ kind: 'text', text: text.slice(0, 300000) });
        } else if (isSheet) {
          const readXlsxFile = (await import('read-excel-file/browser')).default;
          const blob = await (await fetch(url)).blob();
          const raw = await readXlsxFile(blob);
          if (alive) setState({ kind: 'sheet', sheets: normalizeSheets(raw) });
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

  const sheets = state.kind === 'sheet' ? state.sheets : [];
  const rows = sheets[activeSheet]?.rows || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong className="preview-name" title={file.original_name}>{file.original_name}</strong>
          <div className="preview-head-actions">
            {canNav && <span className="muted preview-count">{idx + 1} / {list.length}</span>}
            <span className="muted">{file.size ? formatBytes(file.size) : ''}</span>
            <a className="btn btn-sm" href={url} download={file.original_name}>⬇ Download</a>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="preview-body"
          onTouchStart={isImage ? undefined : onTouchStart}
          onTouchEnd={isImage ? undefined : onTouchEnd}>
          {canNav && idx > 0 && (
            <button className="preview-nav prev" onClick={() => go(-1)} aria-label="Previous">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
          {canNav && idx < list.length - 1 && (
            <button className="preview-nav next" onClick={() => go(1)} aria-label="Next">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
          {isImage && <ZoomableImage src={url} alt={file.original_name} onSwipe={(dir) => go(dir)} />}
          {isPdf && <iframe className="preview-frame" src={url} title={file.original_name} />}

          {state.kind === 'loading' && <p className="muted" style={{ margin: 'auto' }}>Loading preview…</p>}
          {state.kind === 'text' && <pre className="preview-text">{state.text}</pre>}
          {state.kind === 'doc' && <div className="preview-doc" dangerouslySetInnerHTML={{ __html: state.html }} />}
          {state.kind === 'sheet' && (
            <div className="preview-sheet-wrap">
              <table className="preview-sheet">
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td className="preview-sheet-rownum">{i + 1}</td>
                      {row.map((cell, j) => (i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>))}
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td className="muted">Empty sheet.</td></tr>}
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
        {state.kind === 'sheet' && sheets.length > 1 && (
          <div className="preview-sheet-tabs">
            {sheets.map((s, i) => (
              <button key={i} className={`preview-sheet-tab ${i === activeSheet ? 'active' : ''}`} onClick={() => setActiveSheet(i)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Google-Photos-style image viewer for touch: pinch to zoom, double-tap to
// toggle zoom, drag to pan when zoomed. When at 1x, a horizontal swipe calls
// onSwipe(±1) to move to the previous/next file. Mouse/desktop just shows the
// image (navigation there is via the on-screen arrows and ← / → keys).
function ZoomableImage({ src, alt, onSwipe }) {
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const s = useRef({ scale: 1, x: 0, y: 0, mode: null, startDist: 0, startScale: 1, startX: 0, startY: 0, startTx: 0, startTy: 0, lastTap: 0, moved: false });

  const apply = () => {
    if (imgRef.current) {
      const st = s.current;
      imgRef.current.style.transform = `translate3d(${st.x}px, ${st.y}px, 0) scale(${st.scale})`;
      imgRef.current.style.cursor = st.scale > 1 ? 'grab' : 'auto';
    }
  };
  const reset = () => { s.current.scale = 1; s.current.x = 0; s.current.y = 0; apply(); };

  useEffect(() => { reset(); }, [src]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const clamp = (v) => Math.min(5, Math.max(1, v));
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const onStart = (e) => {
      const st = s.current; st.moved = false;
      if (e.touches.length === 2) {
        st.mode = 'pinch'; st.startDist = dist(e.touches) || 1; st.startScale = st.scale;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - st.lastTap < 300) { st.mode = 'dtap'; }
        else { st.mode = st.scale > 1 ? 'pan' : 'swipe'; }
        st.lastTap = now;
        st.startX = e.touches[0].clientX; st.startY = e.touches[0].clientY;
        st.startTx = st.x; st.startTy = st.y;
      }
    };
    const onMove = (e) => {
      const st = s.current;
      if (st.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        st.scale = clamp(st.startScale * (dist(e.touches) / st.startDist));
        apply(); st.moved = true;
      } else if (st.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        st.x = st.startTx + (e.touches[0].clientX - st.startX);
        st.y = st.startTy + (e.touches[0].clientY - st.startY);
        apply(); st.moved = true;
      } else if (st.mode === 'swipe' && e.touches.length === 1) {
        if (Math.abs(e.touches[0].clientX - st.startX) > 8) st.moved = true;
      }
    };
    const onEnd = (e) => {
      const st = s.current;
      if (st.mode === 'dtap') {
        st.scale = st.scale > 1 ? 1 : 2.5;
        if (st.scale === 1) { st.x = 0; st.y = 0; }
        apply();
      } else if (st.mode === 'swipe' && st.moved) {
        const dx = e.changedTouches[0].clientX - st.startX;
        const dy = e.changedTouches[0].clientY - st.startY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe?.(dx < 0 ? 1 : -1);
      } else if (st.mode === 'pinch' && st.scale <= 1.02) {
        reset();
      }
      st.mode = null;
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [onSwipe]);

  return (
    <div className="zoom-wrap" ref={wrapRef}>
      <img ref={imgRef} className="preview-image" src={src} alt={alt} draggable={false} />
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
