import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

const STATUS = { active: 'Active', prospect: 'Prospect', inactive: 'Inactive' };
const REC = { none: 'One-off', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
const overdue = (d) => d && d < new Date().toISOString().slice(0, 10);

export default function ClientsView({ user, onOpenTask }) {
  const [clients, setClients] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    const d = await api('/clients');
    setClients(d.clients);
  }, []);

  useEffect(() => {
    load();
    const socket = getSocket();
    const onChanged = () => load();
    socket?.on('clients:changed', onChanged);
    return () => socket?.off('clients:changed', onChanged);
  }, [load]);

  const q = query.trim().toLowerCase();
  const visible = clients.filter((c) => !q || c.name.toLowerCase().includes(q));
  const showDetail = creating || selectedId != null;

  function selectClient(id) { setCreating(false); setSelectedId(id); }
  function backToList() { setCreating(false); setSelectedId(null); }

  return (
    <div className={`messenger ${showDetail ? 'show-detail' : ''}`}>
      <div className="msgr-list">
        <div className="msgr-search collab-search">
          <input placeholder="Find a client" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="collab-new" title="New client" onClick={() => { setCreating(true); setSelectedId(null); }}>＋</button>
        </div>

        {visible.map((c) => (
          <button key={c.id} className={`msgr-row client-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => selectClient(c.id)}>
            <span className={`client-avatar ${c.type}`}>{c.type === 'individual' ? '👤' : '🏢'}</span>
            <div className="msgr-row-body">
              <div className="msgr-row-top">
                <span className="msgr-name">{c.name}</span>
                <span className={`client-status s-${c.status}`}>{STATUS[c.status]}</span>
              </div>
              <div className="msgr-preview">
                {c.next_deadline
                  ? <span className={overdue(c.next_deadline.due_date) ? 'due-warn' : ''}>⏳ {c.next_deadline.title} · {fmtDate(c.next_deadline.due_date)}</span>
                  : `${c.open_task_count} open task${c.open_task_count === 1 ? '' : 's'}`}
              </div>
            </div>
          </button>
        ))}
        {clients.length === 0 && (
          <div className="collab-empty-list"><div className="collab-empty-art">🗂️</div><p>No clients yet</p></div>
        )}
      </div>

      <div className="msgr-pane">
        {showDetail && <button className="mobile-back" onClick={backToList}>← Clients</button>}
        {creating ? (
          <ClientForm user={user} onCancel={() => setCreating(false)} onSaved={(c) => { load(); setCreating(false); setSelectedId(c.id); }} />
        ) : selectedId != null ? (
          <ClientDetail key={selectedId} clientId={selectedId} user={user} onChanged={load} onOpenTask={onOpenTask}
            onDeleted={() => { setSelectedId(null); load(); }} />
        ) : (
          <div className="collab-promo">
            <div className="collab-promo-badge">🗂️</div>
            <h2>Your client book</h2>
            <ul className="collab-promo-points">
              <li><strong>Everything per client</strong><span>Contacts, notes, linked tasks and compliance deadlines in one place.</span></li>
              <li><strong>Never miss a filing</strong><span>Recurring deadlines roll forward automatically when you tick them off.</span></li>
              <li><strong>Tie work to clients</strong><span>Link any task to a client and see the whole engagement at a glance.</span></li>
            </ul>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>Add a client</button>
          </div>
        )}
      </div>
    </div>
  );
}

const BLANK = { name: '', type: 'company', status: 'active', email: '', phone: '', gstin: '', pan: '', address: '', notes: '' };

function ClientForm({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState(initial || BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true); setError(null);
    try {
      const saved = initial
        ? await api(`/clients/${initial.id}`, { method: 'PATCH', body: form })
        : await api('/clients', { method: 'POST', body: form });
      onSaved(saved);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <form className="client-form" onSubmit={save}>
      <h2>{initial ? 'Edit client' : 'New client'}</h2>
      <label className="field">Name
        <input autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Acme Pvt Ltd" required />
      </label>
      <div className="field-row">
        <label className="field">Type
          <select value={form.type} onChange={set('type')}><option value="company">Company</option><option value="individual">Individual</option></select>
        </label>
        <label className="field">Status
          <select value={form.status} onChange={set('status')}>
            {Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">Email<input type="email" value={form.email} onChange={set('email')} /></label>
        <label className="field">Phone<input value={form.phone} onChange={set('phone')} /></label>
      </div>
      <div className="field-row">
        <label className="field">GSTIN<input value={form.gstin} onChange={set('gstin')} /></label>
        <label className="field">PAN<input value={form.pan} onChange={set('pan')} /></label>
      </div>
      <label className="field">Address<input value={form.address} onChange={set('address')} /></label>
      <label className="field">Notes / summary<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
      {error && <div className="form-error">{error}</div>}
      <div className="editor-actions">
        <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : (initial ? 'Save' : 'Create client')}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ClientDetail({ clientId, user, onChanged, onDeleted, onOpenTask }) {
  const [data, setData] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const d = await api(`/clients/${clientId}`);
    setData(d);
    const t = await api(`/clients/${clientId}/tasks`);
    setTasks(t.tasks);
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="boot">Loading…</div>;
  const c = data.client;

  async function remove() {
    if (!confirm(`Delete ${c.name}? Their tasks stay but are unlinked. Contacts, notes and deadlines are removed.`)) return;
    await api(`/clients/${clientId}`, { method: 'DELETE' });
    onDeleted();
  }

  if (editing) {
    return <div className="client-detail"><ClientForm initial={c} onCancel={() => setEditing(false)}
      onSaved={() => { setEditing(false); load(); onChanged?.(); }} /></div>;
  }

  return (
    <div className="client-detail">
      <div className="client-head">
        <span className={`client-avatar lg ${c.type}`}>{c.type === 'individual' ? '👤' : '🏢'}</span>
        <div className="client-head-main">
          <h2>{c.name}</h2>
          <div className="client-head-meta">
            <span className={`client-status s-${c.status}`}>{STATUS[c.status]}</span>
            {c.email && <span className="muted">✉ {c.email}</span>}
            {c.phone && <span className="muted">☎ {c.phone}</span>}
          </div>
        </div>
        <div className="client-head-actions">
          <button className="btn btn-sm" onClick={() => setEditing(true)}>✏ Edit</button>
          {user.role === 'admin' && <button className="btn btn-sm btn-danger" onClick={remove}>Delete</button>}
        </div>
      </div>

      {(c.gstin || c.pan || c.address || c.notes) && (
        <div className="client-facts">
          {c.gstin && <div><span className="muted">GSTIN</span> {c.gstin}</div>}
          {c.pan && <div><span className="muted">PAN</span> {c.pan}</div>}
          {c.address && <div><span className="muted">Address</span> {c.address}</div>}
          {c.notes && <div className="client-facts-notes">{c.notes}</div>}
        </div>
      )}

      <Deadlines clientId={clientId} deadlines={data.deadlines} onChange={(d) => { setData((x) => ({ ...x, deadlines: d })); onChanged?.(); }} />
      <Contacts clientId={clientId} contacts={data.contacts} onChange={(c2) => setData((x) => ({ ...x, contacts: c2 }))} />

      <section className="client-section">
        <h3>Linked tasks <span className="count-pill">{tasks.length}</span></h3>
        {tasks.length === 0 && <div className="empty-hint">No tasks linked to this client yet.</div>}
        {tasks.map((t) => (
          <button key={t.id} className={`client-task ${t.archived ? 'archived' : ''}`} onClick={() => onOpenTask?.(t.id)}>
            <span className={`ct-dot p-${t.priority}`} />
            <span className="ct-title">{t.title}</span>
            <span className="ct-stage muted">{t.is_done ? '✓ Done' : t.stage}</span>
            {t.assignee && <Avatar user={t.assignee} size={20} />}
          </button>
        ))}
      </section>

      <Notes clientId={clientId} notes={data.notes} user={user} onChange={(n) => setData((x) => ({ ...x, notes: n }))} />
    </div>
  );
}

function Deadlines({ clientId, deadlines, onChange }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [rec, setRec] = useState('none');
  async function add(e) {
    e.preventDefault();
    if (!title.trim() || !due) return;
    const d = await api(`/clients/${clientId}/deadlines`, { method: 'POST', body: { title: title.trim(), due_date: due, recurrence: rec } });
    onChange(d); setTitle(''); setDue(''); setRec('none');
  }
  async function toggle(dl) {
    onChange(await api(`/clients/${clientId}/deadlines/${dl.id}`, { method: 'PATCH', body: { completed: !dl.completed } }));
  }
  async function del(dl) {
    onChange(await api(`/clients/${clientId}/deadlines/${dl.id}`, { method: 'DELETE' }));
  }
  return (
    <section className="client-section">
      <h3>Compliance deadlines</h3>
      {deadlines.map((d) => (
        <div key={d.id} className={`deadline-row ${d.completed ? 'done' : ''}`}>
          <input type="checkbox" checked={!!d.completed} onChange={() => toggle(d)} />
          <span className="dl-title">{d.title}</span>
          {d.recurrence !== 'none' && <span className="dl-rec">{REC[d.recurrence]}</span>}
          <span className={`dl-date ${!d.completed && overdue(d.due_date) ? 'due-warn' : 'muted'}`}>{fmtDate(d.due_date)}</span>
          <button className="icon-btn" title="Remove" onClick={() => del(d)}>✕</button>
        </div>
      ))}
      <form className="deadline-add" onSubmit={add}>
        <input placeholder="e.g. GSTR-3B" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <select value={rec} onChange={(e) => setRec(e.target.value)}>
          {Object.entries(REC).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="btn btn-sm btn-primary" disabled={!title.trim() || !due}>Add</button>
      </form>
    </section>
  );
}

function Contacts({ clientId, contacts, onChange }) {
  const [f, setF] = useState({ name: '', role: '', email: '', phone: '' });
  const [adding, setAdding] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function add(e) {
    e.preventDefault();
    if (!f.name.trim()) return;
    onChange(await api(`/clients/${clientId}/contacts`, { method: 'POST', body: f }));
    setF({ name: '', role: '', email: '', phone: '' }); setAdding(false);
  }
  async function del(id) { onChange(await api(`/clients/${clientId}/contacts/${id}`, { method: 'DELETE' })); }
  return (
    <section className="client-section">
      <h3>Contacts <button className="btn btn-sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '＋ Add'}</button></h3>
      {contacts.map((ct) => (
        <div key={ct.id} className="contact-row">
          <div>
            <strong>{ct.name}</strong>{ct.role && <span className="muted"> · {ct.role}</span>}
            <div className="muted small">{[ct.email, ct.phone].filter(Boolean).join(' · ')}</div>
          </div>
          <button className="icon-btn" onClick={() => del(ct.id)}>✕</button>
        </div>
      ))}
      {contacts.length === 0 && !adding && <div className="empty-hint">No contacts yet.</div>}
      {adding && (
        <form className="contact-add" onSubmit={add}>
          <input placeholder="Name" value={f.name} onChange={set('name')} />
          <input placeholder="Role" value={f.role} onChange={set('role')} />
          <input placeholder="Email" value={f.email} onChange={set('email')} />
          <input placeholder="Phone" value={f.phone} onChange={set('phone')} />
          <button className="btn btn-sm btn-primary" disabled={!f.name.trim()}>Save</button>
        </form>
      )}
    </section>
  );
}

function Notes({ clientId, notes, user, onChange }) {
  const [body, setBody] = useState('');
  async function add(e) {
    e.preventDefault();
    if (!body.trim()) return;
    onChange(await api(`/clients/${clientId}/notes`, { method: 'POST', body: { body: body.trim() } }));
    setBody('');
  }
  async function del(id) {
    await api(`/clients/${clientId}/notes/${id}`, { method: 'DELETE' });
    onChange(notes.filter((n) => n.id !== id));
  }
  return (
    <section className="client-section">
      <h3>Notes</h3>
      <form className="note-add" onSubmit={add}>
        <input placeholder="Add a note…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn btn-sm btn-primary" disabled={!body.trim()}>Add</button>
      </form>
      {notes.map((n) => (
        <div key={n.id} className="note-row">
          <Avatar user={{ name: n.user_name, avatar_color: n.avatar_color }} size={26} />
          <div className="note-body">
            <div className="note-meta"><strong>{n.user_name}</strong> <span className="muted small">{new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
            <div>{n.body}</div>
          </div>
          {(n.user_id === user.id || user.role === 'admin') && <button className="icon-btn" onClick={() => del(n.id)}>✕</button>}
        </div>
      ))}
      {notes.length === 0 && <div className="empty-hint">No notes yet.</div>}
    </section>
  );
}
