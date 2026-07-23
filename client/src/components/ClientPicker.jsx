import React, { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';

const SERVICE_TAGS = ['GST', 'TDS', 'ITR', 'Bookkeeping', 'Payroll', 'Audit', 'ROC'];

// Searchable client selector with an inline "add new client" that stays inside
// the current window (no navigation). `clients` is the current list; when a new
// one is created it's passed back via onClientAdded so the caller can extend it.
export default function ClientPicker({ clients = [], value, onChange, onClientAdded }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef(null);

  const selected = clients.find((c) => c.id === Number(value));
  const filtered = q.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))
    : clients;

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(id) { onChange(id); setOpen(false); setQ(''); }

  return (
    <div className="client-picker" ref={wrapRef}>
      <button type="button" className="client-picker-input" onClick={() => setOpen((o) => !o)}>
        {selected ? <span>{selected.name}</span> : <span className="muted">No client</span>}
        <span className="cp-caret">▾</span>
      </button>
      {open && (
        <div className="client-picker-pop">
          <input autoFocus className="cp-search" placeholder="Search clients…" value={q}
            onChange={(e) => setQ(e.target.value)} />
          <div className="cp-list">
            <button type="button" className="cp-opt" onClick={() => pick('')}>
              <span className="muted">No client</span>
            </button>
            {filtered.map((c) => (
              <button type="button" key={c.id} className={`cp-opt ${Number(value) === c.id ? 'sel' : ''}`} onClick={() => pick(c.id)}>
                {c.name}
              </button>
            ))}
            {filtered.length === 0 && <div className="cp-empty muted">No match.</div>}
          </div>
          <button type="button" className="cp-add" onClick={() => setAdding(true)}>
            ＋ Add new client{q.trim() ? ` "${q.trim()}"` : ''}
          </button>
        </div>
      )}
      {adding && (
        <QuickClientModal initialName={q.trim()}
          onClose={() => setAdding(false)}
          onCreated={(client) => { onClientAdded?.(client); onChange(client.id); setAdding(false); setOpen(false); setQ(''); }} />
      )}
    </div>
  );
}

// Compact new-client form shown over the task window (does not navigate away).
function QuickClientModal({ initialName = '', onClose, onCreated }) {
  const [form, setForm] = useState({ name: initialName, type: 'company', gstin: '', pan: '', phone: '', email: '' });
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (t) => setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));

  async function save() {
    if (!form.name.trim()) { setError('Client name is required'); return; }
    setBusy(true); setError(null);
    try {
      const client = await api('/clients', { method: 'POST', body: { ...form, name: form.name.trim(), tags } });
      onCreated(client);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-header"><strong>New client</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">Name<input autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Acme Pvt Ltd" /></label>
          <div className="field-row">
            <label className="field">Type
              <select value={form.type} onChange={set('type')}><option value="company">Company</option><option value="individual">Individual</option></select>
            </label>
            <label className="field">Mobile<input value={form.phone} onChange={set('phone')} /></label>
          </div>
          <div className="field-row">
            <label className="field">GSTIN<input value={form.gstin} onChange={set('gstin')} /></label>
            <label className="field">PAN<input value={form.pan} onChange={set('pan')} /></label>
          </div>
          <label className="field">Email<input type="email" value={form.email} onChange={set('email')} /></label>
          <div className="field">
            <span>Services <span className="muted">— become tags for compliance</span></span>
            <div className="service-checks">
              {SERVICE_TAGS.map((tg) => (
                <label key={tg} className={`service-check ${tags.includes(tg) ? 'on' : ''}`}>
                  <input type="checkbox" checked={tags.includes(tg)} onChange={() => toggle(tg)} /> {tg}
                </label>
              ))}
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <span />
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>{busy ? 'Adding…' : 'Add client'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
