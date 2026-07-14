import React, { useState, useEffect, useCallback, useRef } from 'react';
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

export default function ClientsView({ user, users = [], onOpenTask }) {
  const [tab, setTab] = useState('clients');
  const [clients, setClients] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [flash, setFlash] = useState(null);
  const staff = users.filter((u) => u.role !== 'guest');

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
    <div className="clients-page">
      <div className="files-tabs">
        <button className={`files-tab ${tab === 'clients' ? 'active' : ''}`} onClick={() => setTab('clients')}>🗂️ Clients</button>
        <button className={`files-tab ${tab === 'board' ? 'active' : ''}`} onClick={() => setTab('board')}>🗓 Compliance board</button>
      </div>
      {tab === 'board' ? (
        <ComplianceBoard staff={staff} onOpenTask={onOpenTask} />
      ) : (
        <div className={`messenger ${showDetail ? 'show-detail' : ''}`}>
      <div className="msgr-list">
        <div className="msgr-search collab-search">
          <input placeholder="Find a client" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="collab-new" title="New client" onClick={() => { setCreating(true); setSelectedId(null); }}>＋</button>
        </div>
        <div className="client-toolbar">
          <button className="btn btn-sm" onClick={() => setShowImport(true)}>⬆ Import list</button>
          <button className="btn btn-sm" onClick={() => setShowBulk(true)}>🗓 Bulk deadlines</button>
        </div>
        {flash && <div className="client-flash">{flash}</div>}

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
          <ClientDetail key={selectedId} clientId={selectedId} user={user} staff={staff} onChanged={load} onOpenTask={onOpenTask}
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

      {showImport && (
        <BulkImportModal
          onClose={() => setShowImport(false)}
          onDone={(r) => { setShowImport(false); load(); setFlash(`Imported ${r.created} client${r.created === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped (duplicates)` : ''}`); }}
        />
      )}
      {showBulk && (
        <BulkDeadlinesModal
          clients={clients} staff={staff}
          onClose={() => setShowBulk(false)}
          onDone={(r) => { setShowBulk(false); load(); setFlash(`Set on ${r.created} client${r.created === 1 ? '' : 's'}${r.tasks ? ` · ${r.tasks} task${r.tasks === 1 ? '' : 's'} created` : ''}${r.skipped ? ` · ${r.skipped} already had it` : ''}`); }}
        />
      )}
        </div>
      )}
    </div>
  );
}

const PRESETS = ['GSTR-1', 'GSTR-3B', 'TDS payment', 'PF payment', 'ESI payment', 'Advance tax', 'Professional tax'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shiftMonth(m, delta) {
  let [y, mo] = m.split('-').map(Number);
  mo += delta;
  if (mo < 1) { mo = 12; y -= 1; } else if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, '0')}`;
}

function ComplianceBoard({ staff = [], onOpenTask }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState({ deadlines: [], summary: [] });
  const [filing, setFiling] = useState('');
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState('pending');

  const load = useCallback(async () => {
    setData(await api(`/clients/deadlines/board?month=${month}`));
  }, [month]);
  useEffect(() => {
    load();
    const s = getSocket();
    const onCh = () => load();
    s?.on('clients:changed', onCh);
    return () => s?.off('clients:changed', onCh);
  }, [load]);

  async function toggle(d) {
    await api(`/clients/${d.client_id}/deadlines/${d.id}`, { method: 'PATCH', body: { completed: !d.completed } });
    load();
  }
  async function makeTask(d) {
    const r = await api(`/clients/${d.client_id}/deadlines/${d.id}/task`, { method: 'POST' });
    load();
    if (r.task_id && confirm('Task created and assigned. Open it now?')) onOpenTask?.(r.task_id);
  }

  const rows = data.deadlines.filter((d) =>
    (!filing || d.title === filing) &&
    (!assignee || (assignee === 'none' ? !d.assignee_id : String(d.assignee_id || '') === assignee)) &&
    (status === 'all' || (status === 'done' ? d.completed : !d.completed))
  );
  const [y, mo] = month.split('-').map(Number);

  return (
    <div className="compliance-board">
      <div className="cb-head">
        <div className="cb-month">
          <button className="btn btn-sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
          <strong>{MONTHS[mo - 1]} {y}</strong>
          <button className="btn btn-sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        </div>
        <div className="cb-filters">
          <select value={filing} onChange={(e) => setFiling(e.target.value)}>
            <option value="">All filings</option>
            {data.summary.map((s) => <option key={s.title} value={s.title}>{s.title}</option>)}
          </select>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {staff.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Pending</option><option value="done">Filed</option><option value="all">All</option>
          </select>
        </div>
      </div>

      <div className="cb-summary">
        {data.summary.length === 0 && <span className="muted">No compliance deadlines this month.</span>}
        {data.summary.map((s) => (
          <button key={s.title} className={`cb-stat ${filing === s.title ? 'on' : ''}`} onClick={() => setFiling(filing === s.title ? '' : s.title)}>
            <div className="cb-stat-top"><span>{s.title}</span><span className="cb-stat-num">{s.done}/{s.total}</span></div>
            <div className="cb-bar"><div className="cb-bar-fill" style={{ width: `${s.total ? Math.round((s.done / s.total) * 100) : 0}%` }} /></div>
          </button>
        ))}
      </div>

      <div className="cb-table-wrap">
        <table className="cb-table">
          <thead><tr><th></th><th>Filing</th><th>Client</th><th>Who files</th><th>Due</th><th></th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className={d.completed ? 'filed' : (overdue(d.due_date) ? 'overdue' : '')}>
                <td><input type="checkbox" checked={!!d.completed} onChange={() => toggle(d)} title="Mark filed" /></td>
                <td className="cb-filing">{d.title}{d.recurrence !== 'none' && <span className="dl-rec">{REC[d.recurrence]}</span>}</td>
                <td>{d.client_name}</td>
                <td>{d.assignee_name
                  ? <span className="cb-assignee"><Avatar user={{ name: d.assignee_name, avatar_color: d.assignee_color }} size={20} /> {d.assignee_name}</span>
                  : <span className="muted">Unassigned</span>}</td>
                <td className={!d.completed && overdue(d.due_date) ? 'due-warn' : 'muted'}>{fmtDate(d.due_date)}</td>
                <td>{d.task_id
                  ? <button className="icon-btn" title="Open task" onClick={() => onOpenTask?.(d.task_id)}>📋</button>
                  : <button className="icon-btn" title="Create task" onClick={() => makeTask(d)}>＋📋</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && data.summary.length > 0 && <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>Nothing matches these filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BulkImportModal({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const parsed = text.split('\n').map((line) => {
    const parts = line.split(/\t|,/).map((s) => s.trim());
    return {
      name: parts[0], gstin: parts[1] || '', email: parts[2] || '', phone: parts[3] || '',
      tags: (parts[4] || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
    };
  }).filter((r) => r.name);

  function downloadTemplate() {
    const csv = 'Name,GSTIN,Email,Phone,Tags (separate with ;)\nAcme Pvt Ltd,29ABCDE1234F1Z5,ops@acme.in,9876543210,GST;TDS\nBharat Traders,,,,GST;PF\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'teamhub-clients-template.csv';
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  }

  // Load a filled template (.xlsx or .csv) into the text box for review.
  async function onFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      let rows;
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const readXlsxFile = (await import('read-excel-file/browser')).default;
        rows = await readXlsxFile(file);
      } else {
        rows = (await file.text()).split(/\r?\n/).map((l) => l.split(','));
      }
      const isHeader = rows.length && String(rows[0][0] || '').trim().toLowerCase() === 'name';
      const body = (isHeader ? rows.slice(1) : rows)
        .map((r) => (r || []).map((c) => (c == null ? '' : String(c)).trim()))
        .filter((r) => r[0]);
      setText(body.map((r) => [r[0], r[1] || '', r[2] || '', r[3] || '', r[4] || ''].join(', ')).join('\n'));
    } catch {
      setError('Could not read that file. Please use the template (.csv or .xlsx).');
    }
  }

  async function submit() {
    if (!parsed.length) return;
    setBusy(true); setError(null);
    try { onDone(await api('/clients/bulk', { method: 'POST', body: { clients: parsed } })); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal bulk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Import clients</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="import-actions">
          <button type="button" className="btn btn-sm" onClick={downloadTemplate}>⬇ Download template</button>
          <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>⬆ Upload filled sheet</button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={onFile} />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>Download the template, fill it in Excel, and upload it — or paste one client per line: <code>Name, GSTIN, Email, Phone, Tags</code>. Tag clients by compliance (e.g. <code>GST;TDS</code>) to bulk-select them later.</p>
        <textarea className="bulk-textarea" rows={10} autoFocus value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'Acme Pvt Ltd, 29ABCDE1234F1Z5, ops@acme.in, 9876543210, GST;TDS\nBharat Traders, , , , GST;PF'} />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <span className="muted">{parsed.length} client{parsed.length === 1 ? '' : 's'} detected</span>
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !parsed.length} onClick={submit}>{busy ? 'Importing…' : `Import ${parsed.length}`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BulkDeadlinesModal({ clients, staff = [], onClose, onDone }) {
  const [title, setTitle] = useState('GSTR-3B');
  const [due, setDue] = useState('');
  const [rec, setRec] = useState('monthly');
  const [assignee, setAssignee] = useState('');
  const [createTasks, setCreateTasks] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [tagFilter, setTagFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [types, setTypes] = useState([]);       // firm-added filing types
  const allTags = [...new Set(clients.flatMap((c) => c.tags || []))].sort();
  const [addingType, setAddingType] = useState(false);
  const [newType, setNewType] = useState('');

  useEffect(() => { api('/clients/compliance-types').then((d) => setTypes(d.types)).catch(() => {}); }, []);
  async function addType() {
    const name = newType.trim();
    if (!name) { setAddingType(false); return; }
    try {
      const d = await api('/clients/compliance-types', { method: 'POST', body: { name } });
      setTypes(d.types); setTitle(name);
    } catch { /* ignore */ }
    setNewType(''); setAddingType(false);
  }

  const filtered = clients.filter((c) =>
    (statusFilter === 'all' || c.status === statusFilter) &&
    (!tagFilter || (c.tags || []).some((t) => t.toLowerCase() === tagFilter.toLowerCase())) &&
    (!q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())));
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => sel.has(c.id));

  function toggle(id) { setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() {
    setSel((s) => {
      const n = new Set(s);
      if (allFilteredSelected) filtered.forEach((c) => n.delete(c.id));
      else filtered.forEach((c) => n.add(c.id));
      return n;
    });
  }

  async function submit() {
    if (!title.trim() || !due || sel.size === 0) return;
    setBusy(true); setError(null);
    try {
      onDone(await api('/clients/deadlines/bulk', { method: 'POST', body: {
        title: title.trim(), due_date: due, recurrence: rec,
        assignee_id: assignee ? Number(assignee) : null, create_tasks: createTasks, client_ids: [...sel],
      } }));
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal bulk-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Set a recurring deadline on many clients</strong><button className="icon-btn" onClick={onClose}>✕</button></div>

        <div className="bulk-presets">
          {[...PRESETS, ...types].map((p) => (
            <button key={p} className={`chip ${title === p ? 'on' : ''}`} onClick={() => setTitle(p)}>{p}</button>
          ))}
          {addingType ? (
            <input className="chip-add" autoFocus value={newType} placeholder="New filing name…"
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addType(); } if (e.key === 'Escape') { setNewType(''); setAddingType(false); } }}
              onBlur={addType} />
          ) : (
            <button className="chip chip-ghost" onClick={() => setAddingType(true)}>＋ Add type</button>
          )}
        </div>
        <div className="field-row">
          <label className="field">Deadline<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. GSTR-3B" /></label>
          <label className="field">First due date<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        <div className="field-row">
          <label className="field">Repeats
            <select value={rec} onChange={(e) => setRec(e.target.value)}>
              <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option><option value="none">One-off</option>
            </select>
          </label>
          <label className="field">Assign to
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>
        <label className="checkbox"><input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} /> Also create an assignable task for each client</label>

        <div className="bulk-pick-head">
          <input className="bulk-search" placeholder="Filter clients" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} title="Filter by tag / compliance segment">
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="active">Active</option><option value="prospect">Prospect</option>
            <option value="inactive">Inactive</option><option value="all">All statuses</option>
          </select>
          <label className="checkbox"><input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} /> Select all ({filtered.length})</label>
        </div>
        <div className="bulk-client-list">
          {filtered.map((c) => (
            <label key={c.id} className="bulk-client-row">
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              <span className={`client-avatar ${c.type}`} style={{ width: 26, height: 26, fontSize: 13 }}>{c.type === 'individual' ? '👤' : '🏢'}</span>
              <span>{c.name}</span>
            </label>
          ))}
          {filtered.length === 0 && <div className="empty-hint" style={{ padding: 12 }}>No clients match.</div>}
        </div>

        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <span className="muted">{sel.size} selected</span>
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !title.trim() || !due || sel.size === 0} onClick={submit}>
              {busy ? 'Setting…' : `Set on ${sel.size} client${sel.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const BLANK = { name: '', type: 'company', status: 'active', email: '', phone: '', gstin: '', pan: '', address: '', notes: '', tags: [] };

function ClientForm({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...BLANK, ...(initial || {}), tags: initial?.tags || [] }));
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  function addTag() {
    const t = tagInput.trim();
    if (t && !form.tags.some((x) => x.toLowerCase() === t.toLowerCase())) setForm((f) => ({ ...f, tags: [...f.tags, t] }));
    setTagInput('');
  }

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
      <div className="field">
        <span>Tags <span className="muted">— which compliances apply (GST, TDS, PF…) so you can bulk-select this segment</span></span>
        <div className="tags-row">
          {form.tags.map((t) => (
            <span key={t} className="task-tag removable">{t}<button type="button" onClick={() => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }))}>✕</button></span>
          ))}
          <input className="tag-inline" placeholder="+ tag" value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} onBlur={addTag} />
        </div>
      </div>
      <label className="field">Notes / summary<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
      {error && <div className="form-error">{error}</div>}
      <div className="editor-actions">
        <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : (initial ? 'Save' : 'Create client')}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ClientDetail({ clientId, user, staff = [], onChanged, onDeleted, onOpenTask }) {
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
            {(c.tags || []).map((t) => <span key={t} className="client-tag">{t}</span>)}
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

      <Deadlines clientId={clientId} deadlines={data.deadlines} staff={staff} onOpenTask={onOpenTask}
        onChange={(d) => { setData((x) => ({ ...x, deadlines: d })); onChanged?.(); }} />
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

function Deadlines({ clientId, deadlines, staff = [], onOpenTask, onChange }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [rec, setRec] = useState('none');
  const base = `/clients/${clientId}/deadlines`;
  async function add(e) {
    e.preventDefault();
    if (!title.trim() || !due) return;
    onChange(await api(base, { method: 'POST', body: { title: title.trim(), due_date: due, recurrence: rec } }));
    setTitle(''); setDue(''); setRec('none');
  }
  const patch = async (dl, body) => onChange(await api(`${base}/${dl.id}`, { method: 'PATCH', body }));
  async function del(dl) { onChange(await api(`${base}/${dl.id}`, { method: 'DELETE' })); }
  async function makeTask(dl) {
    const r = await api(`${base}/${dl.id}/task`, { method: 'POST' });
    onChange(r.deadlines);
    if (r.task_id && confirm('Task created and assigned. Open it now?')) onOpenTask?.(r.task_id);
  }
  return (
    <section className="client-section">
      <h3>Compliance deadlines</h3>
      {deadlines.map((d) => (
        <div key={d.id} className={`deadline-row ${d.completed ? 'done' : ''}`}>
          <input type="checkbox" checked={!!d.completed} onChange={() => patch(d, { completed: !d.completed })} />
          <span className="dl-title">{d.title}</span>
          {d.recurrence !== 'none' && <span className="dl-rec">{REC[d.recurrence]}</span>}
          <select className="dl-assignee" value={d.assignee_id || ''} onChange={(e) => patch(d, { assignee_id: e.target.value ? Number(e.target.value) : null })} title="Who files it">
            <option value="">Unassigned</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className={`dl-date ${!d.completed && overdue(d.due_date) ? 'due-warn' : 'muted'}`}>{fmtDate(d.due_date)}</span>
          {d.task_id
            ? <button className="icon-btn" title="Open the task" onClick={() => onOpenTask?.(d.task_id)}>📋</button>
            : <button className="icon-btn" title="Create an assignable task" onClick={() => makeTask(d)}>＋📋</button>}
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
