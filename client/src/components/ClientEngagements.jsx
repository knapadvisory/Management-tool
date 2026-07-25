import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Clients landing view: a firm-wide "client engagements" table — one row per
// client showing the services they use, their last completed task and the next
// thing due — with headline stats and a service filter. Replaces the old empty
// promo panel. Clicking a row opens that client's detail.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Stable-ish colour per service tag, so the same tag always reads the same.
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

export default function ClientEngagements({ onSelect, onAdd }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [service, setService] = useState(''); // '' = all services

  useEffect(() => {
    api('/clients/engagements').then(setData).catch((e) => setErr(e.message));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return service ? data.rows.filter((r) => r.tags.includes(service)) : data.rows;
  }, [data, service]);

  if (err) return <div className="ceng"><div className="empty-hint">Couldn’t load engagements: {err}</div></div>;
  if (!data) return <div className="ceng"><div className="ceng-loading">Loading engagements…</div></div>;

  const s = data.summary;

  return (
    <div className="ceng">
      <div className="ceng-head">
        <div className="ceng-head-main">
          <div className="ceng-eyebrow">Client book</div>
          <h1>Client engagements</h1>
        </div>
        <div className="ceng-stats">
          <div className="ceng-stat"><span className="ceng-stat-num">{s.active_clients}</span><span className="ceng-stat-lbl">active clients</span></div>
          <div className="ceng-stat"><span className="ceng-stat-num ceng-accent">{s.filed_this_month}</span><span className="ceng-stat-lbl">filed this month</span></div>
          <div className="ceng-stat"><span className={`ceng-stat-num ${s.past_due ? 'ceng-danger' : ''}`}>{s.past_due}</span><span className="ceng-stat-lbl">past due</span></div>
        </div>
      </div>

      {data.services.length > 0 && (
        <div className="ceng-filters">
          <button className={`ceng-chip-btn ${service === '' ? 'on' : ''}`} onClick={() => setService('')}>All services</button>
          {data.services.map((t) => (
            <button key={t} className={`ceng-chip-btn ${service === t ? 'on' : ''}`} onClick={() => setService(t)}>{t}</button>
          ))}
        </div>
      )}

      <div className="ceng-tablewrap">
        {rows.length === 0 ? (
          <div className="ceng-empty">
            <div className="ceng-empty-art">🗂️</div>
            <p>{data.rows.length === 0 ? 'No clients yet.' : 'No clients use this service yet.'}</p>
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
                    <div className="ceng-client-sub">{TYPE_LABEL[r.type] || r.type}{r.contact_person ? ` · ${r.contact_person}` : ''}</div>
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
