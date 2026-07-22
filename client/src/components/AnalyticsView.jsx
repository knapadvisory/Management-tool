import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';

// Practice Analytics — firm-wide (admin) or personal (staff) performance board.
// All numbers come from /api/analytics; the charts are hand-drawn inline SVG so
// there's no chart-library weight in the bundle.

const PERIODS = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'fy', label: 'FY' },
];

const fmtHours = (h) => (h >= 1000 ? `${(h / 1000).toFixed(1)}k` : `${h}`);
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// A star row for a 0–5 rating (rounded to nearest whole for the glyphs).
function Stars({ value }) {
  const n = Math.round(value || 0);
  return <span className="an-stars">{'★★★★★'.slice(0, n)}<span className="an-stars-off">{'★★★★★'.slice(n)}</span></span>;
}

// Trend pill: green up / red down / neutral. `goodDown` flips the colour logic
// (e.g. for "overdue", a drop is good).
function Delta({ pct, suffix = '% vs last', goodDown = false }) {
  if (pct === null || pct === undefined) return null;
  const positive = pct > 0;
  const good = goodDown ? !positive : positive;
  const cls = pct === 0 ? 'flat' : good ? 'up' : 'down';
  const arrow = pct === 0 ? '●' : positive ? '▲' : '▼';
  return <span className={`an-delta ${cls}`}>{arrow} {Math.abs(pct)}{suffix}</span>;
}

// Area + line chart for the two throughput series.
function ThroughputChart({ series }) {
  const W = 640, H = 210, pad = 20;
  const max = Math.max(4, ...series.map((s) => Math.max(s.completed, s.assigned)));
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, series.length - 1);
  const y = (v) => H - 30 - ((H - 55) * v) / max;
  const line = (key) => series.map((s, i) => `${x(i)},${y(s[key])}`).join(' ');
  const area = (key) => `M${x(0)},${y(series[0][key])} L${line(key).replace(/ /g, ' L')} L${x(series.length - 1)},${H - 30} L${x(0)},${H - 30} Z`;
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => 25 + (H - 55) * f);
  const tick = (label) => { const d = new Date(label); return `${d.toLocaleString('en', { month: 'short' })} ${d.getUTCDate()}`; };
  return (
    <svg className="an-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Task throughput">
      <g stroke="var(--an-grid)" strokeWidth="1">{gridYs.map((gy, i) => <line key={i} x1="0" y1={gy} x2={W} y2={gy} />)}</g>
      <path d={area('assigned')} fill="var(--an-accent-soft2)" opacity=".5" />
      <polyline points={line('assigned')} fill="none" stroke="var(--an-accent-soft2)" strokeWidth="2.5" />
      <path d={area('completed')} fill="var(--an-accent)" opacity=".12" />
      <polyline points={line('completed')} fill="none" stroke="var(--an-accent)" strokeWidth="2.5" />
      <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].completed)} r="4" fill="var(--an-accent)" />
      <g fill="var(--muted)" fontSize="10" textAnchor="middle">
        {series.map((s, i) => (i % 2 === 0 || i === series.length - 1) && <text key={i} x={x(i)} y={H - 8}>{tick(s.label)}</text>)}
      </g>
    </svg>
  );
}

// SVG donut for the compliance split.
function Donut({ segments, total, centerLabel }) {
  const R = 15.9155, C = 2 * Math.PI * R;
  let offset = 25; // start at 12 o'clock
  return (
    <svg viewBox="0 0 42 42" className="an-donut" role="img" aria-label="Compliance status">
      <circle cx="21" cy="21" r={R} fill="none" stroke="var(--an-grid)" strokeWidth="6" />
      {segments.map((s, i) => {
        const frac = total ? (s.value / total) * 100 : 0;
        const dash = `${(frac * C) / 100} ${C - (frac * C) / 100}`;
        const el = <circle key={i} cx="21" cy="21" r={R} fill="none" stroke={s.color} strokeWidth="6" strokeDasharray={dash} strokeDashoffset={offset} />;
        offset -= (frac * C) / 100;
        return el;
      })}
      <text x="21" y="20.5" textAnchor="middle" className="an-donut-num">{total}</text>
      <text x="21" y="26" textAnchor="middle" className="an-donut-sub">{centerLabel}</text>
    </svg>
  );
}

// Quality-trend sparkline (avg stars by month).
function QualityTrend({ points }) {
  const W = 340, H = 150;
  if (!points.length) return <div className="an-empty">No ratings yet in this range.</div>;
  const xs = points.map((_, i) => 20 + (i * (W - 40)) / Math.max(1, points.length - 1));
  const y = (v) => H - 20 - ((H - 45) * (Math.max(3, Math.min(5, v)) - 3)) / 2; // 3..5 band
  const line = points.map((p, i) => `${xs[i]},${y(p.avg)}`).join(' ');
  return (
    <svg className="an-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Quality trend">
      <g stroke="var(--an-grid)" strokeWidth="1">
        <line x1="0" y1="30" x2={W} y2="30" /><line x1="0" y1="70" x2={W} y2="70" /><line x1="0" y1="110" x2={W} y2="110" />
      </g>
      <path d={`M${xs[0]},${y(points[0].avg)} L${line.replace(/ /g, ' L')} L${xs[xs.length - 1]},${H - 20} L${xs[0]},${H - 20} Z`} fill="#f59e0b" opacity=".12" />
      <polyline points={line} fill="none" stroke="#f59e0b" strokeWidth="2.5" />
      <g fill="#f59e0b">{points.map((p, i) => <circle key={i} cx={xs[i]} cy={y(p.avg)} r="3" />)}</g>
      <g fill="var(--muted)" fontSize="9.5" textAnchor="middle">
        {points.map((p, i) => <text key={i} x={xs[i]} y={H - 4}>{new Date(p.ym + '-01').toLocaleString('en', { month: 'short' })}</text>)}
      </g>
      <g fill="var(--muted)" fontSize="9" textAnchor="end"><text x="14" y="33">5</text><text x="14" y="73">4</text><text x="14" y="113">3</text></g>
    </svg>
  );
}

export default function AnalyticsView({ user, users = [] }) {
  const isAdmin = user.role === 'admin';
  const [period, setPeriod] = useState('month');
  const [userId, setUserId] = useState(''); // admin-only person focus
  const [clientId, setClientId] = useState('');
  const [clients, setClients] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (isAdmin) api('/clients').then((d) => setClients(d.clients || [])).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    setLoading(true); setErr('');
    const qs = new URLSearchParams({ period });
    if (isAdmin && userId) qs.set('user_id', userId);
    if (clientId) qs.set('client_id', clientId);
    api(`/analytics?${qs.toString()}`)
      .then((d) => setData(d))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [period, userId, clientId, isAdmin]);

  const s = data?.summary;
  const maxOpen = Math.max(1, ...(data?.workload || []).map((w) => w.open_tasks));
  const maxClientHrs = Math.max(1, ...(data?.time_by_client || []).map((c) => c.hours));

  return (
    <div className="an-page">
      <header className="an-top">
        <div>
          <h1>Practice Analytics</h1>
          <div className="an-sub">
            {isAdmin && !userId ? 'Firm-wide performance & compliance' : `${(users.find((u) => u.id === Number(userId)) || user).name}'s performance`}
          </div>
        </div>
        <div className="an-filters">
          <div className="an-seg">
            {PERIODS.map((p) => (
              <button key={p.key} className={period === p.key ? 'on' : ''} onClick={() => setPeriod(p.key)}>{p.label}</button>
            ))}
          </div>
          {isAdmin && (
            <select className="an-pick" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">👤 Whole team</option>
              {users.filter((u) => u.name && u.role !== 'guest').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {isAdmin && (
            <select className="an-pick" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">🗂️ All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      </header>

      {err && <div className="an-error">Couldn’t load analytics: {err}</div>}
      {loading && !data && <div className="an-loading">Loading…</div>}

      {data && (
        <div className={`an-body ${loading ? 'an-dim' : ''}`}>
          {/* KPI tiles */}
          <section className="an-kpis">
            <div className="an-kpi">
              <div className="an-lab">Tasks completed</div>
              <div className="an-val">{s.tasks_completed.value}</div>
              <Delta pct={s.tasks_completed.delta} />
            </div>
            <div className="an-kpi">
              <div className="an-lab">On-time rate</div>
              <div className="an-val">{s.on_time.rate === null ? '—' : <>{s.on_time.rate}<small>%</small></>}</div>
              <div className="an-note">{s.on_time.n ? `${s.on_time.n} with due dates` : 'no dated tasks'}</div>
            </div>
            <div className="an-kpi">
              <div className="an-lab">Avg quality</div>
              <div className="an-val">{s.quality.value ? <>{Number(s.quality.value).toFixed(1)}<small>/5</small></> : '—'}</div>
              {s.quality.value ? <Stars value={s.quality.value} /> : <div className="an-note">no ratings yet</div>}
            </div>
            <div className="an-kpi">
              <div className="an-lab">Billable hours</div>
              <div className="an-val">{fmtHours(s.billable_hours.hours)}<small>h</small></div>
              <span className="an-delta flat">● {s.billable_hours.billable_pct}% of logged</span>
            </div>
            <div className="an-kpi">
              <div className="an-lab">Overdue filings</div>
              <div className={`an-val ${s.overdue_filings ? 'an-bad' : ''}`}>{s.overdue_filings}</div>
              <div className="an-note">{s.overdue_filings ? 'need action' : 'all clear'}</div>
            </div>
          </section>

          {/* Row: throughput + workload */}
          <section className="an-grid-2">
            <div className="an-card">
              <div className="an-card-head">
                <div><h3>Task throughput</h3><div className="an-ch-sub">Completed vs newly assigned</div></div>
                <div className="an-legend">
                  <span><i style={{ background: 'var(--an-accent)' }} />Completed</span>
                  <span><i style={{ background: 'var(--an-accent-soft2)' }} />Assigned</span>
                </div>
              </div>
              <ThroughputChart series={data.throughput} />
            </div>

            <div className="an-card">
              <div className="an-card-head"><div><h3>{userId || !isAdmin ? 'Workload' : 'Team workload'}</h3><div className="an-ch-sub">Open tasks · avg rating</div></div></div>
              <div className="an-lb">
                {data.workload.length === 0 && <div className="an-empty">No open work.</div>}
                {data.workload.map((w) => (
                  <div className="an-lb-row" key={w.id}>
                    <Avatar user={w} size={30} />
                    <div className="an-lb-main">
                      <div className="an-lb-name">{w.name}</div>
                      <div className="an-lb-meta">
                        {w.avg_rating ? `★ ${w.avg_rating} · ` : ''}{w.open_tasks} open{w.overdue ? ` · ${w.overdue} overdue` : ''}
                      </div>
                      <div className="an-bar"><div className="an-bar-fill" style={{ width: `${(w.open_tasks / maxOpen) * 100}%` }} /></div>
                    </div>
                    <div className="an-lb-num">{w.open_tasks}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Row: compliance + quality + time by client */}
          <section className="an-grid-3">
            <div className="an-card">
              <div className="an-card-head"><div><h3>Compliance status</h3><div className="an-ch-sub">All filings in scope</div></div></div>
              <div className="an-donut-wrap">
                <Donut
                  total={data.compliance.total || 0}
                  centerLabel="filings"
                  segments={[
                    { value: data.compliance.filed || 0, color: 'var(--success)' },
                    { value: data.compliance.due_soon || 0, color: 'var(--warning)' },
                    { value: data.compliance.overdue || 0, color: 'var(--danger)' },
                  ]}
                />
                <div className="an-dlist">
                  <div className="an-dl"><span className="an-dot" style={{ background: 'var(--success)' }} /> Filed <b>{data.compliance.filed || 0}</b></div>
                  <div className="an-dl"><span className="an-dot" style={{ background: 'var(--warning)' }} /> Due soon <b>{data.compliance.due_soon || 0}</b></div>
                  <div className="an-dl"><span className="an-dot" style={{ background: 'var(--danger)' }} /> Overdue <b>{data.compliance.overdue || 0}</b></div>
                </div>
              </div>
              {data.compliance.by_type?.length > 0 && (
                <div className="an-badges">
                  {data.compliance.by_type.map((t) => <span key={t.name} className="an-badge">{t.name} · {t.n}</span>)}
                </div>
              )}
            </div>

            <div className="an-card">
              <div className="an-card-head"><div><h3>Quality trend</h3><div className="an-ch-sub">Avg rating, 6 months</div></div></div>
              <QualityTrend points={data.quality_trend} />
            </div>

            <div className="an-card">
              <div className="an-card-head"><div><h3>Billable hours by client</h3><div className="an-ch-sub">Top clients this period</div></div></div>
              <div className="an-lb">
                {data.time_by_client.length === 0 && <div className="an-empty">No billable time logged.</div>}
                {data.time_by_client.map((c) => (
                  <div className="an-lb-row" key={c.id}>
                    <span />
                    <div className="an-lb-main">
                      <div className="an-lb-name">{c.name}</div>
                      <div className="an-bar"><div className="an-bar-fill" style={{ width: `${(c.hours / maxClientHrs) * 100}%` }} /></div>
                    </div>
                    <div className="an-lb-num">{c.hours}h</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Needs attention */}
          <section className="an-card">
            <div className="an-card-head">
              <div><h3>Needs attention</h3><div className="an-ch-sub">Open filings, soonest due first</div></div>
              <span className="an-badge">{data.attention.length} open</span>
            </div>
            {data.attention.length === 0 ? (
              <div className="an-empty">Nothing outstanding — every filing in scope is done. 🎉</div>
            ) : (
              <div className="an-table-wrap">
                <table className="an-table">
                  <thead><tr><th>Filing</th><th>Client</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.attention.map((r) => {
                      const over = r.days_overdue > 0;
                      const soon = !over && r.days_overdue >= -3;
                      const chip = over ? `c-bad` : soon ? 'c-warn' : 'c-ok';
                      const label = over ? `${r.days_overdue}d overdue` : r.days_overdue === 0 ? 'due today' : `in ${-r.days_overdue}d`;
                      return (
                        <tr key={r.id}>
                          <td className="an-t-name">{r.title}</td>
                          <td>{r.client_name}</td>
                          <td>{r.owner ? <span className="an-owner"><span className="an-mini-av" style={{ background: r.owner.avatar_color }}>{initials(r.owner.name)}</span>{r.owner.name}</span> : <span className="muted">Unassigned</span>}</td>
                          <td>{r.due_date}</td>
                          <td><span className={`an-chip ${chip}`}>{label}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
