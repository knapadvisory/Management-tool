import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Clients landing view: a full-width, firm-wide "clients & services" table — one
// row per client showing the services they use, their last completed task, the
// next thing due and the responsible manager. Search + service chips filter it.
// Clicking a row opens that client's detail.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHIP_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#6366f1'];
const chipColor = (tag) => {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return CHIP_COLORS[h % CHIP_COLORS.length];
};
const short = (tag) => tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || tag.toUpperCase();
const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day} ${MONTHS[Number(m) - 1]} ${y}`;
};
const TYPE_LABEL = { company: 'Company', individual: 'Individual' };

// Current Indian financial year label, e.g. "FY 2026-27".
function fyLabel() {
  const now = new Date();
  const y = now.getFullYear();
  const startY = now.getMonth() >= 3 ? y : y - 1; // FY starts in April
  return `FY ${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

const STATUSES = [['', 'All'], ['active', 'Active'], ['prospect', 'Prospect'], ['inactive', 'Inactive']];

export default function ClientEngagements({ onSelect, onAdd, onImport, onBulk }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [service, setService] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    api('/clients/engagements').then(setData).catch((e) => setErr(e.message));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (service && !r.tags.includes(service)) return false;
      if (needle && !(
        r.name.toLowerCase().includes(needle) ||
        (r.gstin || '').toLowerCase().includes(needle) ||
        (r.pan || '').toLowerCase().includes(needle)
      )) return false;
      return true;
    });
  }, [data, service, status, q]);

  if (err) return <div className="ceng"><div className="empty-hint">Couldn’t load clients: {err}</div></div>;
  if (!data) return <div className="ceng"><div className="ceng-loading">Loading clients…</div></div>;

  const s = data.summary;

  return (
    <div className="ceng">
      <div className="ceng-head">
        <div className="ceng-head-main">
          <div className="ceng-eyebrow">Client master · {s.active_clients} active</div>
          <h1>Clients &amp; services</h1>
        </div>
        <div className="ceng-head-actions">
          <span className="ceng-fy">{fyLabel()}</span>
          {onImport && <button className="btn btn-sm" onClick={onImport}>⬆ Import</button>}
          {onBulk && <button className="btn btn-sm" onClick={onBulk}>🗓 Bulk deadlines</button>}
          <button className="btn btn-primary btn-sm" onClick={onAdd}>＋ Add client</button>
        </div>
      </div>

      <div className="ceng-toolbar">
        <input className="ceng-search" placeholder="Search clients, GSTIN, PAN…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ceng-seg">
          {STATUSES.map(([v, l]) => (
            <button key={v} className={`ceng-seg-btn ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        <span className="ceng-count">
          {rows.length} of {data.rows.length} shown
          {(s.filed_this_month || s.past_due) ? <> · <span className="ceng-accent">{s.filed_this_month} filed</span>{s.past_due ? <> · <span className="ceng-danger">{s.past_due} past due</span></> : null}</> : null}
        </span>
      </div>

      {data.services.length > 0 && (
        <div className="ceng-filters ceng-filters-row">
          <button className={`ceng-chip-btn ${service === '' ? 'on' : ''}`} onClick={() => setService('')}>All services</button>
          {data.services.map((t) => (
            <button key={t} className={`ceng-chip-btn ${service === t ? 'on' : ''}`} onClick={() => setService(service === t ? '' : t)}>{t}</button>
          ))}
        </div>
      )}

      <div className="ceng-tablewrap">
        {rows.length === 0 ? (
          <div className="ceng-empty">
            <div className="ceng-empty-art">🗂️</div>
            <p>{data.rows.length === 0 ? 'No clients yet.' : 'No clients match.'}</p>
            {data.rows.length === 0 && <button className="btn btn-primary" onClick={onAdd}>Add a client</button>}
          </div>
        ) : (
          <table className="ceng-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Services engaged</th>
                <th>Last task completed</th>
                <th className="ceng-r">Next due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onSelect(r.id)}>
                  <td className="ceng-client">
                    <div className="ceng-client-name">{r.name}</div>
                    <div className="ceng-client-sub">
                      {r.constitution || TYPE_LABEL[r.type] || r.type}
                      {(r.gstin || r.pan) ? ` · ${r.gstin || r.pan}` : ''}
                    </div>
                  </td>
                  <td>
                    <div className="ceng-chips">
                      {r.tags.length === 0 && <span className="ceng-chip-none">—</span>}
                      {r.tags.map((t) => (
                        <span key={t} className="ceng-chip" title={t} style={{ '--chip': chipColor(t) }}>
                          <span className="ceng-chip-dot" />{short(t)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {r.last_completed ? (
                      <>
                        <div className="ceng-last-title">{r.last_completed.title}</div>
                        <div className="ceng-last-date">{fmtDate(r.last_completed.date)}</div>
                      </>
                    ) : <span className="ceng-chip-none">No completed work yet</span>}
                  </td>
                  <td className="ceng-r">
                    {r.next_due ? (
                      <>
                        <div className={`ceng-due-title ${r.next_due.overdue ? 'ceng-danger' : ''}`}>{r.next_due.title}</div>
                        <div className={`ceng-due-date ${r.next_due.overdue ? 'ceng-danger' : ''}`}>{fmtDate(r.next_due.date)}</div>
                      </>
                    ) : <span className="ceng-chip-none">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
