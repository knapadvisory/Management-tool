import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, uploadFiles, fileUrl } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const STATUS = { active: 'Active', prospect: 'Prospect', inactive: 'Inactive' };
const REC = { none: 'One-off', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
const overdue = (d) => d && d < new Date().toISOString().slice(0, 10);

// --- Client-master workbook import -----------------------------------------
// A firm's "Client Master" sheet (e.g. KNAP's) carries far more than name/email:
// identity fields plus a block of Yes/No service columns (GST, TDS, ITR …).
// We map the identity columns onto our client record and turn every service
// marked "Yes" into a tag, so the sheet immediately powers tag-based bulk
// compliance (GST clients, TDS clients, …) with no manual tagging.

const norm = (s) => String(s == null ? '' : s).trim();
const isYes = (v) => /^(y|yes|true|1|applicable)$/i.test(norm(v));

// Header label (lowercased) -> our client field.
const KNAP_FIELDS = {
  'client name (as per pan)': 'name', 'client name': 'name', 'name': 'name',
  'client code': 'client_code', 'constitution': 'constitution', 'status': 'status',
  'firm': 'firm', 'pan': 'pan', 'tan': 'tan',
  'primary gstin': 'gstin', 'gstin': 'gstin', 'cin / llpin': 'cin', 'cin/llpin': 'cin',
  'primary contact person': 'contact_person', 'contact person': 'contact_person',
  'mobile': 'phone', 'phone': 'phone', 'email': 'email',
  'principal place of business': 'address', 'address': 'address',
  'gst return frequency': 'gst_frequency', 'fee model': 'fee_model',
  'fee amount (rs.)': 'fee_amount', 'fee amount': 'fee_amount',
  'turnover band (rs.)': 'turnover_band', 'turnover band': 'turnover_band',
  'risk rating': 'risk_rating', 'independence flag (firm interest?)': 'independence_flag',
  'date of onboarding': 'onboarding_date', 'remarks': 'notes',
};
// Yes/No service columns -> tag applied when the cell says Yes.
const KNAP_SERVICE_TAGS = {
  'gst': 'GST', 'tds': 'TDS', 'itr': 'ITR', 'bookkeeping': 'Bookkeeping',
  'payroll': 'Payroll', 'audit': 'Audit', 'roc / company law': 'ROC', 'roc': 'ROC',
};
const statusFromSheet = (v) => {
  const s = norm(v).toLowerCase();
  if (s.startsWith('prospect')) return 'prospect';
  if (s.startsWith('dormant') || s.startsWith('exit') || s.startsWith('inactive') || s.startsWith('closed')) return 'inactive';
  return 'active';
};
const typeFromConstitution = (v) => (/individual|proprietor|huf/i.test(norm(v)) ? 'individual' : 'company');

// Find the header row and return {header: string[], index}. Some sheets have a
// category band ("IDENTITY", "SERVICES"…) above the real header, so we scan for
// the row that actually names the columns.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const cells = (rows[i] || []).map((c) => norm(c).toLowerCase());
    if (cells.some((c) => c === 'name' || c.startsWith('client name') || c === 'client code')) return { header: cells, index: i };
  }
  return null;
}

// True when this looks like a rich client-master (has a service column), vs the
// plain Name/GSTIN/Email/Phone/Tags template.
const isClientMaster = (header) => header.some((h) => h in KNAP_SERVICE_TAGS) && header.some((h) => KNAP_FIELDS[h] === 'name');

// Map a client-master sheet into our client objects (with derived tags).
function mapClientMaster(rows) {
  const found = findHeaderRow(rows);
  if (!found) return [];
  const { header, index } = found;
  const out = [];
  for (let r = index + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const c = { tags: [] };
    header.forEach((h, ci) => {
      const val = norm(row[ci]);
      if (KNAP_FIELDS[h] && val) c[KNAP_FIELDS[h]] = val;
      if (KNAP_SERVICE_TAGS[h] && isYes(val)) c.tags.push(KNAP_SERVICE_TAGS[h]);
    });
    if (!c.name) continue;
    c.type = typeFromConstitution(c.constitution);
    c.status = statusFromSheet(c.status);
    out.push(c);
  }
  return out;
}

export default function ClientsView({ user, users = [], onOpenTask }) {
  const [tab, setTab] = useState('clients');
  const [clients, setClients] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [letter, setLetter] = useState('');
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
  const visible = clients.filter((c) =>
    (!q || c.name.toLowerCase().includes(q)) &&
    (statusFilter === 'all' || c.status === statusFilter) &&
    (!letter || c.name.trim().toUpperCase().startsWith(letter)));
  // Which first-letters actually have clients (for the A–Z rail).
  const activeLetters = new Set(clients.map((c) => (c.name.trim()[0] || '').toUpperCase()));
  const showDetail = creating || selectedId != null;

  function selectClient(id) { setCreating(false); setSelectedId(id); }
  function backToList() { setCreating(false); setSelectedId(null); }

  return (
    <div className="clients-page">
      <div className="files-tabs">
        <button className={`files-tab ${tab === 'clients' ? 'active' : ''}`} onClick={() => setTab('clients')}>🗂️ Clients</button>
        <button className={`files-tab ${tab === 'board' ? 'active' : ''}`} onClick={() => setTab('board')}>🗓 Compliance board</button>
        <button className={`files-tab ${tab === 'matrix' ? 'active' : ''}`} onClick={() => setTab('matrix')}>▦ Matrix</button>
      </div>
      {tab === 'board' ? (
        <ComplianceBoard staff={staff} onOpenTask={onOpenTask} />
      ) : tab === 'matrix' ? (
        <ComplianceMatrix onOpenClient={(id) => { setTab('clients'); selectClient(id); }} />
      ) : (
        <div className={`messenger ${showDetail ? 'show-detail' : ''}`}>
      <div className="msgr-list">
        <div className="msgr-search collab-search">
          <input placeholder="Find a client" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="collab-new" title="New client" onClick={() => { setCreating(true); setSelectedId(null); }}>＋</button>
        </div>
        <div className="client-toolbar">
          <select className="client-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} title="Filter by status">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="prospect">Prospect</option>
            <option value="inactive">Inactive</option>
          </select>
          <button className="btn btn-sm" onClick={() => setShowImport(true)}>⬆ Import list</button>
          <button className="btn btn-sm" onClick={() => setShowBulk(true)}>🗓 Bulk deadlines</button>
        </div>
        <div className="az-rail">
          <button className={`az-key ${letter === '' ? 'on' : ''}`} onClick={() => setLetter('')}>All</button>
          {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((L) => (
            <button key={L} disabled={!activeLetters.has(L)} className={`az-key ${letter === L ? 'on' : ''}`} onClick={() => setLetter(L === letter ? '' : L)}>{L}</button>
          ))}
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
          onDone={(r) => { setShowImport(false); load(); setFlash(`Imported ${r.created} new${r.updated ? ` · ${r.updated} updated` : ''}${r.skipped ? ` · ${r.skipped} skipped` : ''}`); }}
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

// Compliance matrix: clients (rows) × filing types (columns), each cell showing
// that filing's status for the month. A firm-wide "who owes what" grid.
function ComplianceMatrix({ onOpenClient }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState({ columns: [], rows: [] });
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setData(await api(`/clients/matrix?month=${month}`));
  }, [month]);
  useEffect(() => {
    load();
    const s = getSocket();
    const onCh = () => load();
    s?.on('clients:changed', onCh);
    return () => s?.off('clients:changed', onCh);
  }, [load]);

  const [y, mo] = month.split('-').map(Number);
  const rows = data.rows.filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const CELL = { filed: { t: '✓', c: 'cell-filed' }, due: { t: '•', c: 'cell-due' }, overdue: { t: '!', c: 'cell-overdue' } };

  return (
    <div className="matrix-view">
      <div className="cb-head">
        <div className="cb-month">
          <button className="btn btn-sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
          <strong>{MONTHS[mo - 1]} {y}</strong>
          <button className="btn btn-sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        </div>
        <input className="bulk-search" placeholder="Find a client" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="matrix-legend">
          <span><b className="cell-filed">✓</b> Filed</span>
          <span><b className="cell-due">•</b> Due</span>
          <span><b className="cell-overdue">!</b> Overdue</span>
        </div>
      </div>
      {data.columns.length === 0 ? (
        <div className="empty-hint" style={{ margin: 20 }}>No compliance filings this month. Assign deadlines (Bulk deadlines) to build the matrix.</div>
      ) : (
        <div className="matrix-scroll">
          <table className="matrix-table">
            <thead>
              <tr><th className="matrix-csticky">Client</th>{data.columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.client_id}>
                  <td className="matrix-csticky"><button className="link-btn" onClick={() => onOpenClient?.(r.client_id)}>{r.name}</button></td>
                  {data.columns.map((col) => {
                    const cell = r.cells[col];
                    const meta = cell ? CELL[cell.status] : null;
                    return <td key={col} className="matrix-cell">{meta ? <span className={`matrix-mark ${meta.c}`} title={`${col}: ${cell.status}${cell.due_date ? ` (due ${fmtDate(cell.due_date)})` : ''}`}>{meta.t}</span> : <span className="matrix-na">–</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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

// Columns of the downloadable client-master template (matches a firm's master
// sheet: identity + service Yes/No columns that become tags on import).
const TEMPLATE_COLS = [
  'Client Code', 'Client Name (as per PAN)', 'Constitution', 'Status', 'Firm',
  'PAN', 'TAN', 'Primary GSTIN', 'CIN / LLPIN', 'Primary Contact Person',
  'Mobile', 'Email', 'Principal Place of Business',
  'GST', 'TDS', 'ITR', 'Bookkeeping', 'Payroll', 'Audit', 'ROC / Company Law',
  'GST Return Frequency', 'Fee Model', 'Fee Amount (Rs.)', 'Turnover Band (Rs.)',
  'Risk Rating', 'Independence Flag (Firm Interest?)', 'Date of Onboarding', 'Remarks',
];
const TEMPLATE_SAMPLE = [
  'KNAP-001', 'Sample Exports Private Limited', 'Private Limited', 'Active', 'KNAP',
  'AAACS1234F', 'DELS12345E', '07AAACS1234F1Z5', 'U74999DL2020PTC123456', 'A. Sharma',
  '9800000001', 'accounts@sampleexports.in', 'Noida, UP',
  'Yes', 'Yes', 'Yes', 'Yes', 'No', 'Yes', 'Yes',
  'Monthly', 'Monthly Retainer', '25000', '10-25 Cr',
  'Low', 'No', '01-Apr-2024', 'Sample row — overwrite with your first client',
];

function BulkImportModal({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [fileClients, setFileClients] = useState(null); // structured rows from a client-master file
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const textClients = text.split('\n').map((line) => {
    const parts = line.split(/\t|,/).map((s) => s.trim());
    return {
      name: parts[0], gstin: parts[1] || '', email: parts[2] || '', phone: parts[3] || '',
      tags: (parts[4] || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
    };
  }).filter((r) => r.name);
  const clients = fileClients || textClients;
  const tagCounts = {};
  if (fileClients) fileClients.forEach((c) => (c.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

  function csvCell(v) { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
  function downloadTemplate() {
    const csv = [TEMPLATE_COLS, TEMPLATE_SAMPLE].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'teamhub-client-master-template.csv';
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  }

  // Load a filled sheet (.xlsx or .csv). A rich client-master is mapped straight
  // to structured records (identity + tags); a plain list fills the text box.
  async function onFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(null); setFileClients(null);
    try {
      let rows;
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const readXlsxFile = (await import('read-excel-file/browser')).default;
        // Prefer a sheet literally named "Client Master" if the workbook has one.
        let sheet;
        try { sheet = (await readXlsxFile(file, { getSheets: true })).find((s) => /client master/i.test(s.name))?.name; } catch { /* single sheet */ }
        rows = await readXlsxFile(file, sheet ? { sheet } : undefined);
      } else {
        rows = (await file.text()).split(/\r?\n/).map((l) => l.split(','));
      }
      const found = findHeaderRow(rows);
      if (found && isClientMaster(found.header)) {
        const mapped = mapClientMaster(rows);
        if (!mapped.length) { setError('No client rows found in the sheet.'); return; }
        setFileClients(mapped); setText('');
        return;
      }
      // Plain Name/GSTIN/Email/Phone/Tags list → editable text.
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
    if (!clients.length) return;
    setBusy(true); setError(null);
    try { onDone(await api('/clients/bulk', { method: 'POST', body: { clients, update: updateExisting } })); }
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
        {fileClients ? (
          <div className="import-preview">
            <p className="muted" style={{ marginTop: 0 }}>
              Read <strong>{fileClients.length}</strong> client{fileClients.length === 1 ? '' : 's'} from your client-master sheet. Services marked “Yes” become tags for bulk compliance:
            </p>
            <div className="import-tag-summary">
              {Object.keys(tagCounts).length === 0
                ? <span className="muted">No service tags detected.</span>
                : Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
                    <span key={t} className="chip">{t} · {n}</span>
                  ))}
            </div>
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setFileClients(null)}>Clear &amp; paste instead</button>
          </div>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>Upload your <strong>Client Master</strong> sheet (the service columns GST/TDS/ITR… auto-tag each client) — or paste one client per line: <code>Name, GSTIN, Email, Phone, Tags</code>. Tag by compliance (e.g. <code>GST;TDS</code>) to bulk-select later.</p>
            <textarea className="bulk-textarea" rows={10} autoFocus value={text} onChange={(e) => setText(e.target.value)}
              placeholder={'Acme Pvt Ltd, 29ABCDE1234F1Z5, ops@acme.in, 9876543210, GST;TDS\nBharat Traders, , , , GST;PF'} />
          </>
        )}
        <label className="checkbox import-update"><input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} /> Update existing clients <span className="muted">(match by client code, PAN, or name — otherwise duplicates are skipped)</span></label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <span className="muted">{clients.length} client{clients.length === 1 ? '' : 's'} detected</span>
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !clients.length} onClick={submit}>{busy ? 'Importing…' : `Import ${clients.length}`}</button>
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

const BLANK = {
  name: '', type: 'company', status: 'active', email: '', phone: '', gstin: '', pan: '', address: '', notes: '', tags: [],
  client_code: '', constitution: '', firm: '', tan: '', cin: '', contact_person: '',
  gst_frequency: '', fee_model: '', fee_amount: '', turnover_band: '', risk_rating: '',
  independence_flag: '', onboarding_date: '',
};
// Option lists mirror the workbook's "Dropdown Lists" sheet.
const CONSTITUTIONS = ['Private Limited', 'LLP', 'Partnership', 'Proprietorship', 'HUF', 'Trust', 'Section 8', 'Individual', 'OPC'];
const GST_FREQ = ['Monthly', 'QRMP', 'Composition', 'Not Registered'];
const FEE_MODELS = ['Monthly Retainer', 'Quarterly', 'Per Filing', 'Annual', 'Hourly'];
const RISKS = ['Low', 'Medium', 'High'];
// The Yes/No service columns of the import become tags — offer them as checkboxes.
const SERVICE_TAGS = ['GST', 'TDS', 'ITR', 'Bookkeeping', 'Payroll', 'Audit', 'ROC'];

function ClientForm({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...BLANK, ...(initial || {}), tags: initial?.tags || [] }));
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const hasTag = (t) => form.tags.some((x) => x.toLowerCase() === t.toLowerCase());
  function toggleService(t) {
    setForm((f) => ({ ...f, tags: hasTag(t) ? f.tags.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...f.tags, t] }));
  }
  function addTag() {
    const t = tagInput.trim();
    if (t && !hasTag(t)) setForm((f) => ({ ...f, tags: [...f.tags, t] }));
    setTagInput('');
  }
  // Constitution implies the record type (individual vs company), like the import.
  function setConstitution(e) {
    const v = e.target.value;
    setForm((f) => ({ ...f, constitution: v, type: /individual|proprietor|huf/i.test(v) ? 'individual' : 'company' }));
  }
  // Extra (non-service) tags shown in the free-tag editor.
  const extraTags = form.tags.filter((t) => !SERVICE_TAGS.some((s) => s.toLowerCase() === t.toLowerCase()));

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
      <label className="field">Name (as per PAN)
        <input autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Acme Pvt Ltd" required />
      </label>
      <div className="field-row">
        <label className="field">Client code<input value={form.client_code} onChange={set('client_code')} placeholder="e.g. KNAP-001" /></label>
        <label className="field">Constitution
          <select value={form.constitution} onChange={setConstitution}>
            <option value="">—</option>
            {CONSTITUTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">Status
          <select value={form.status} onChange={set('status')}>
            {Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field">Firm<input value={form.firm} onChange={set('firm')} /></label>
      </div>
      <div className="field-row">
        <label className="field">Primary contact person<input value={form.contact_person} onChange={set('contact_person')} /></label>
        <label className="field">Date of onboarding<input value={form.onboarding_date} onChange={set('onboarding_date')} placeholder="e.g. 01-Apr-2024" /></label>
      </div>
      <div className="field-row">
        <label className="field">Email<input type="email" value={form.email} onChange={set('email')} /></label>
        <label className="field">Mobile<input value={form.phone} onChange={set('phone')} /></label>
      </div>
      <div className="field-row">
        <label className="field">Primary GSTIN<input value={form.gstin} onChange={set('gstin')} /></label>
        <label className="field">PAN<input value={form.pan} onChange={set('pan')} /></label>
      </div>
      <div className="field-row">
        <label className="field">TAN<input value={form.tan} onChange={set('tan')} /></label>
        <label className="field">CIN / LLPIN<input value={form.cin} onChange={set('cin')} /></label>
      </div>
      <label className="field">Principal place of business<input value={form.address} onChange={set('address')} /></label>
      <div className="field">
        <span>Services <span className="muted">— what we do for this client. Each ticked service becomes a tag so you can bulk-assign its compliance.</span></span>
        <div className="service-checks">
          {SERVICE_TAGS.map((t) => (
            <label key={t} className={`service-check ${hasTag(t) ? 'on' : ''}`}>
              <input type="checkbox" checked={hasTag(t)} onChange={() => toggleService(t)} /> {t}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Other tags <span className="muted">— e.g. PF, ESI, or any segment of your own</span></span>
        <div className="tags-row">
          {extraTags.map((t) => (
            <span key={t} className="task-tag removable">{t}<button type="button" onClick={() => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }))}>✕</button></span>
          ))}
          <input className="tag-inline" placeholder="+ tag" value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} onBlur={addTag} />
        </div>
      </div>
      <div className="field-row">
        <label className="field">GST return frequency
          <select value={form.gst_frequency} onChange={set('gst_frequency')}>
            <option value="">—</option>
            {GST_FREQ.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="field">Turnover band<input value={form.turnover_band} onChange={set('turnover_band')} placeholder="e.g. 10-25 Cr" /></label>
      </div>
      <div className="field-row">
        <label className="field">Fee model
          <select value={form.fee_model} onChange={set('fee_model')}>
            <option value="">—</option>
            {FEE_MODELS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="field">Fee amount (₹)<input value={form.fee_amount} onChange={set('fee_amount')} inputMode="numeric" /></label>
      </div>
      <div className="field-row">
        <label className="field">Risk rating
          <select value={form.risk_rating} onChange={set('risk_rating')}>
            <option value="">—</option>
            {RISKS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="field">Independence flag
          <select value={form.independence_flag} onChange={set('independence_flag')}>
            <option value="">—</option>
            <option value="No">No</option>
            <option value="Yes">Yes (firm interest)</option>
          </select>
        </label>
      </div>
      <label className="field">Remarks / summary<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
      {error && <div className="form-error">{error}</div>}
      <div className="editor-actions">
        <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : (initial ? 'Save' : 'Create client')}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const overdueDl = (d) => d && !d.completed && overdue(d.due_date);

function ClientFacts({ c }) {
  const has = [c.gstin, c.pan, c.tan, c.cin, c.client_code, c.constitution, c.firm, c.contact_person,
    c.gst_frequency, c.fee_model, c.fee_amount, c.turnover_band, c.risk_rating,
    c.independence_flag, c.onboarding_date, c.address, c.notes].some(Boolean);
  if (!has) return <div className="empty-hint">No profile details yet — use ✏ Edit to add them.</div>;
  return (
    <div className="client-facts">
      {c.client_code && <div><span className="muted">Code</span> {c.client_code}</div>}
      {c.constitution && <div><span className="muted">Constitution</span> {c.constitution}</div>}
      {c.firm && <div><span className="muted">Firm</span> {c.firm}</div>}
      {c.gstin && <div><span className="muted">GSTIN</span> {c.gstin}</div>}
      {c.pan && <div><span className="muted">PAN</span> {c.pan}</div>}
      {c.tan && <div><span className="muted">TAN</span> {c.tan}</div>}
      {c.cin && <div><span className="muted">CIN / LLPIN</span> {c.cin}</div>}
      {c.contact_person && <div><span className="muted">Contact</span> {c.contact_person}</div>}
      {c.gst_frequency && <div><span className="muted">GST freq.</span> {c.gst_frequency}</div>}
      {c.fee_model && <div><span className="muted">Fee model</span> {c.fee_model}{c.fee_amount ? ` · ₹${c.fee_amount}` : ''}</div>}
      {!c.fee_model && c.fee_amount && <div><span className="muted">Fee</span> ₹{c.fee_amount}</div>}
      {c.turnover_band && <div><span className="muted">Turnover</span> {c.turnover_band}</div>}
      {c.risk_rating && <div><span className="muted">Risk</span> {c.risk_rating}</div>}
      {isYes(c.independence_flag) && <div><span className="due-warn">⚑ Independence flag</span></div>}
      {c.onboarding_date && <div><span className="muted">Onboarded</span> {c.onboarding_date}</div>}
      {c.address && <div><span className="muted">Address</span> {c.address}</div>}
      {c.notes && <div className="client-facts-notes">{c.notes}</div>}
    </div>
  );
}

function LinkedTasks({ tasks, onOpenTask }) {
  return (
    <section className="client-section">
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
  );
}

function ClientDetail({ clientId, user, staff = [], onChanged, onDeleted, onOpenTask }) {
  const [data, setData] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState('overview');

  const load = useCallback(async () => {
    const d = await api(`/clients/${clientId}`);
    setData(d);
    const t = await api(`/clients/${clientId}/tasks`);
    setTasks(t.tasks);
  }, [clientId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTab('overview'); }, [clientId]);

  if (!data) return <div className="boot">Loading…</div>;
  const c = data.client;
  const documents = data.documents || [];
  const openTasks = tasks.filter((t) => !t.is_done && !t.archived).length;
  const overdueCount = (data.deadlines || []).filter(overdueDl).length;

  async function remove() {
    if (!confirm(`Delete ${c.name}? Their tasks stay but are unlinked. Contacts, notes, documents and deadlines are removed.`)) return;
    await api(`/clients/${clientId}`, { method: 'DELETE' });
    onDeleted();
  }

  if (editing) {
    return <div className="client-detail"><ClientForm initial={c} onCancel={() => setEditing(false)}
      onSaved={() => { setEditing(false); load(); onChanged?.(); }} /></div>;
  }

  const TABS = [
    ['overview', 'Overview'],
    ['services', `Services${c.tags?.length ? ` (${c.tags.length})` : ''}`],
    ['tasks', `Tasks${tasks.length ? ` (${tasks.length})` : ''}`],
    ['deadlines', `Compliance${data.deadlines?.length ? ` (${data.deadlines.length})` : ''}`],
    ['documents', `Documents${documents.length ? ` (${documents.length})` : ''}`],
    ['contacts', `Contacts${data.contacts?.length ? ` (${data.contacts.length})` : ''}`],
    ['notes', 'Discussion'],
  ];

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

      {/* One-click complete picture: everything about this client on one file. */}
      <div className="c360-stats">
        <button className={`c360-stat ${tab === 'tasks' ? 'on' : ''}`} onClick={() => setTab('tasks')}>
          <span className="c360-num">{openTasks}</span><span className="c360-lbl">Open tasks</span>
        </button>
        <button className={`c360-stat ${overdueCount ? 'warn' : ''}`} onClick={() => setTab('deadlines')}>
          <span className="c360-num">{overdueCount}</span><span className="c360-lbl">Overdue filings</span>
        </button>
        <button className="c360-stat" onClick={() => setTab('documents')}>
          <span className="c360-num">{documents.length}</span><span className="c360-lbl">Documents</span>
        </button>
        <div className="c360-stat">
          <span className="c360-num">{c.fee_amount ? `₹${c.fee_amount}` : '—'}</span><span className="c360-lbl">{c.fee_model || 'Fee'}</span>
        </div>
        <div className="c360-stat">
          <span className="c360-num c360-next">{data.deadlines?.find((d) => !d.completed)?.title || '—'}</span>
          <span className="c360-lbl">Next filing</span>
        </div>
      </div>

      <div className="c360-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={`c360-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div className="c360-body">
        {tab === 'overview' && (
          <>
            <ClientFacts c={c} />
            <section className="client-section">
              <h3>Upcoming compliance</h3>
              {(!data.deadlines || data.deadlines.filter((d) => !d.completed).length === 0)
                ? <div className="empty-hint">No open filings. <button className="link-btn" onClick={() => setTab('deadlines')}>Add one</button>.</div>
                : data.deadlines.filter((d) => !d.completed).slice(0, 4).map((d) => (
                    <div key={d.id} className="c360-line">
                      <span className={overdueDl(d) ? 'due-warn' : ''}>⏳ {d.title}</span>
                      <span className="muted">{fmtDate(d.due_date)}{d.assignee_name ? ` · ${d.assignee_name}` : ''}</span>
                    </div>
                  ))}
            </section>
            <section className="client-section">
              <h3>Recent tasks</h3>
              {tasks.length === 0 ? <div className="empty-hint">No linked tasks yet.</div>
                : <LinkedTasks tasks={tasks.slice(0, 5)} onOpenTask={onOpenTask} />}
            </section>
          </>
        )}
        {tab === 'services' && (
          <section className="client-section">
            <h3>Services & engagement</h3>
            {(c.tags || []).length === 0 && <div className="empty-hint">No services tagged. Use ✏ Edit to tick the services you handle for this client.</div>}
            <div className="service-list">
              {(c.tags || []).map((t) => {
                const open = (data.deadlines || []).filter((d) => !d.completed && d.title.toUpperCase().includes(t.toUpperCase())).length;
                return (
                  <div key={t} className="service-item">
                    <span className="service-name">✔ {t}</span>
                    {open > 0 && <span className="muted small">{open} open filing{open === 1 ? '' : 's'}</span>}
                  </div>
                );
              })}
            </div>
            {(c.gst_frequency || c.fee_model) && (
              <div className="client-facts" style={{ marginTop: 12 }}>
                {c.gst_frequency && <div><span className="muted">GST frequency</span> {c.gst_frequency}</div>}
                {c.fee_model && <div><span className="muted">Fee model</span> {c.fee_model}{c.fee_amount ? ` · ₹${c.fee_amount}` : ''}</div>}
              </div>
            )}
          </section>
        )}
        {tab === 'tasks' && <LinkedTasks tasks={tasks} onOpenTask={onOpenTask} />}
        {tab === 'deadlines' && (
          <Deadlines clientId={clientId} deadlines={data.deadlines} staff={staff} onOpenTask={onOpenTask}
            onChange={(d) => { setData((x) => ({ ...x, deadlines: d })); onChanged?.(); }} />
        )}
        {tab === 'documents' && (
          <Documents clientId={clientId} documents={documents} onChange={(docs) => { setData((x) => ({ ...x, documents: docs })); onChanged?.(); }} />
        )}
        {tab === 'contacts' && (
          <Contacts clientId={clientId} contacts={data.contacts} onChange={(c2) => setData((x) => ({ ...x, contacts: c2 }))} />
        )}
        {tab === 'notes' && (
          <Notes clientId={clientId} notes={data.notes} user={user} onChange={(n) => setData((x) => ({ ...x, notes: n }))} />
        )}
      </div>
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

function Documents({ clientId, documents, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  async function onFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy(true); setError(null);
    try {
      const uploaded = await uploadFiles(files);
      const docs = await api(`/clients/${clientId}/documents`, { method: 'POST', body: { attachment_ids: uploaded.map((a) => a.id) } });
      onChange(docs);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function del(id) {
    if (!confirm('Remove this document?')) return;
    onChange(await api(`/clients/${clientId}/documents/${id}`, { method: 'DELETE' }));
  }

  return (
    <section className="client-section">
      <h3>Documents
        <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : '⬆ Upload'}</button>
        <input ref={fileRef} type="file" multiple hidden onChange={onFiles} />
      </h3>
      {error && <div className="form-error">{error}</div>}
      {documents.length === 0 && !busy && <div className="empty-hint">No documents filed for this client yet.</div>}
      {documents.map((d) => (
        <div key={d.id} className="doc-row">
          <a className="doc-name" href={fileUrl(d.id)} target="_blank" rel="noreferrer">📄 {d.original_name}</a>
          <span className="muted small">{fmtBytes(d.size)}{d.uploaded_by ? ` · ${d.uploaded_by}` : ''}</span>
          <button className="icon-btn" title="Remove" onClick={() => del(d.id)}>✕</button>
        </div>
      ))}
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
