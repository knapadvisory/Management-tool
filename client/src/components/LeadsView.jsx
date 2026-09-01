import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

const COLUMNS = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];
const digits = (s) => String(s || '').replace(/\D/g, '');

export default function LeadsView({ user, users = [], onOpenTask }) {
  const [leads, setLeads] = useState([]);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState(false);
  const [drag, setDrag] = useState(null);

  const load = useCallback(() => { api('/leads').then((d) => setLeads(d.leads || [])).catch(() => {}); }, []);
  useEffect(() => {
    load();
    const s = getSocket();
    s?.on('leads:changed', load);
    const id = setInterval(load, 45000);
    return () => { s?.off('leads:changed', load); clearInterval(id); };
  }, [load]);

  async function patch(id, body) {
    const { lead } = await api(`/leads/${id}`, { method: 'PATCH', body });
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...lead } : l)));
    setSelected((cur) => (cur && cur.id === id ? { ...cur, ...lead } : cur));
  }
  async function remove(id) {
    if (!window.confirm('Delete this lead?')) return;
    await api(`/leads/${id}`, { method: 'DELETE' }).catch(() => {});
    setSelected(null); load();
  }

  return (
    <div className="leads-view">
      <div className="leads-head">
        <div>
          <h2>Leads</h2>
          <p className="muted">Enquiries from your website, email and manual entry — move them along the pipeline.</p>
        </div>
        <div className="leads-head-actions">
          <button className="btn" onClick={() => setAdding(true)}>＋ Add lead</button>
          {user.role === 'admin' && <button className="btn" onClick={() => setSetup(true)}>⚙ Website setup</button>}
        </div>
      </div>

      <div className="leads-board">
        {COLUMNS.map((col) => {
          const items = leads.filter((l) => l.status === col.key);
          return (
            <div
              key={col.key}
              className={`leads-col leads-col-${col.key} ${drag ? 'droppable' : ''}`}
              onDragOver={(e) => { if (drag) e.preventDefault(); }}
              onDrop={() => { if (drag && drag.status !== col.key) patch(drag.id, { status: col.key }); setDrag(null); }}
            >
              <div className="leads-col-head"><span className={`dot dot-${col.key}`} /> {col.label} <span className="leads-count">{items.length}</span></div>
              <div className="leads-col-body">
                {items.map((l) => (
                  <div
                    key={l.id}
                    className="lead-card"
                    draggable
                    onDragStart={() => setDrag(l)}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => setSelected(l)}
                  >
                    <div className="lead-card-name">{l.name || l.email || l.phone || 'Enquiry'}</div>
                    {l.message && <div className="lead-card-msg">{l.message}</div>}
                    <div className="lead-card-foot">
                      {l.phone && <span className="lead-chip">📞 {l.phone}</span>}
                      <span className={`lead-src src-${l.source}`}>{l.source}</span>
                      {l.owner_id && <Avatar user={{ name: l.owner_name, avatar_color: l.owner_avatar_color }} size={20} />}
                    </div>
                  </div>
                ))}
                {items.length === 0 && <div className="leads-empty muted">—</div>}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <LeadDetail
          lead={selected} users={users} onClose={() => setSelected(null)}
          onPatch={patch} onDelete={remove} onOpenTask={onOpenTask}
        />
      )}
      {adding && <AddLead users={users} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
      {setup && <LeadSetup onClose={() => setSetup(false)} />}
    </div>
  );
}

function LeadDetail({ lead, users, onClose, onPatch, onDelete, onOpenTask }) {
  const wa = digits(lead.phone);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="lead-detail" onClick={(e) => e.stopPropagation()}>
        <div className="lead-detail-head">
          <h3>{lead.name || 'Enquiry'}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="lead-detail-actions">
          {lead.email && <a className="btn btn-sm" href={`mailto:${lead.email}`}>✉ Email</a>}
          {lead.phone && <a className="btn btn-sm" href={`tel:${lead.phone}`}>📞 Call</a>}
          {wa && <a className="btn btn-sm" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
        </div>

        <label className="lead-field-label">Status</label>
        <select value={lead.status} onChange={(e) => onPatch(lead.id, { status: e.target.value })} className="lead-select">
          {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>

        <label className="lead-field-label">Owner</label>
        <select value={lead.owner_id || ''} onChange={(e) => onPatch(lead.id, { owner_id: e.target.value ? Number(e.target.value) : null })} className="lead-select">
          <option value="">Unassigned</option>
          {users.filter((u) => u.role !== 'guest').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>

        <div className="lead-detail-info">
          {lead.email && <div><span className="muted">Email</span> {lead.email}</div>}
          {lead.phone && <div><span className="muted">Phone</span> {lead.phone}</div>}
          <div><span className="muted">Source</span> {lead.source}</div>
          <div><span className="muted">Received</span> {new Date(lead.created_at).toLocaleString()}</div>
        </div>

        {lead.message && (
          <>
            <label className="lead-field-label">Enquiry</label>
            <div className="lead-message">{lead.message}</div>
          </>
        )}

        <div className="lead-detail-foot">
          {lead.task_id && <button className="btn btn-sm" onClick={() => onOpenTask?.(lead.task_id)}>Open follow-up task →</button>}
          <button className="btn btn-sm btn-danger" onClick={() => onDelete(lead.id)}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function AddLead({ users, onClose, onAdded }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '', owner_id: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try { await api('/leads', { method: 'POST', body: { ...f, owner_id: f.owner_id ? Number(f.owner_id) : null } }); onAdded(); }
    catch { setBusy(false); }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-header"><strong>Add lead</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <form onSubmit={submit} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input className="auth-input" placeholder="Name" value={f.name} onChange={set('name')} />
          <input className="auth-input" placeholder="Email" value={f.email} onChange={set('email')} />
          <input className="auth-input" placeholder="Phone" value={f.phone} onChange={set('phone')} />
          <textarea className="auth-input" placeholder="Enquiry / message" rows={3} value={f.message} onChange={set('message')} />
          <select className="auth-input" value={f.owner_id} onChange={set('owner_id')}>
            <option value="">Assign owner (optional)</option>
            {users.filter((u) => u.role !== 'guest').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add lead'}</button>
        </form>
      </div>
    </div>
  );
}

function LeadSetup({ onClose }) {
  const [s, setS] = useState(null);
  const [copied, setCopied] = useState(null);
  const load = useCallback(() => { api('/leads/settings').then(setS).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  if (!s) return null;
  const url = `${window.location.origin}${s.intake_path}?key=${s.key}`;
  const php = `<?php
$data = array(
  'name'    => $_POST['name'],
  'email'   => $_POST['email'],
  'phone'   => $_POST['phone'],
  'message' => $_POST['message'],
);
$ch = curl_init(${JSON.stringify(url)});
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($data));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_exec($ch);
curl_close($ch);
?>`;
  const copy = (text, which) => { navigator.clipboard?.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 1500); };
  async function rotate() {
    if (!window.confirm('Rotate the key? Your website will stop sending leads until you update it with the new URL.')) return;
    await api('/leads/settings/key', { method: 'POST' }); load();
  }
  async function setWorkflow(id) {
    await api('/leads/settings', { method: 'PATCH', body: { task_workflow_id: id ? Number(id) : null } });
    setS({ ...s, task_workflow_id: id ? Number(id) : null });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="modal-header"><strong>Website lead setup</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16 }}>
          <p className="muted">Send your website's enquiry form to this URL and every submission lands on the Leads board. Keep the key secret.</p>

          <label className="lead-field-label">Webhook URL</label>
          <div className="lead-copyrow">
            <code className="lead-code">{url}</code>
            <button className="btn btn-sm" onClick={() => copy(url, 'url')}>{copied === 'url' ? 'Copied ✓' : 'Copy'}</button>
          </div>

          <label className="lead-field-label">Auto-create a follow-up task in</label>
          <select className="auth-input" value={s.task_workflow_id || ''} onChange={(e) => setWorkflow(e.target.value)}>
            <option value="">Don't create a task</option>
            {s.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>

          <label className="lead-field-label">PHP snippet (add to your form handler)</label>
          <div className="lead-copyrow">
            <pre className="lead-snippet">{php}</pre>
          </div>
          <button className="btn btn-sm" onClick={() => copy(php, 'php')}>{copied === 'php' ? 'Copied ✓' : 'Copy snippet'}</button>

          <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <button className="btn btn-sm btn-danger" onClick={rotate}>Rotate key</button>
            <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>Use if the key is exposed. You'll need to update the URL on your site.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
