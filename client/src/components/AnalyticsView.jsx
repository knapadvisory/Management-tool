import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import TaskModal from './TaskModal.jsx';

// Practice Analytics — two tabs:
//  • Overview  — firm-wide (or personal) KPIs, throughput, compliance, quality.
//  • Appraisals — employee rating leaderboard + every rated task (with rater).
// Charts are hand-drawn inline SVG so there's no chart-library weight.

const PERIODS = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'fy', label: 'FY' },
];
const CHART_STYLES = [
  { key: 'area', label: 'Area' },
  { key: 'line', label: 'Line' },
  { key: 'bars', label: 'Bars' },
  { key: 'stacked', label: 'Stacked' },
];

const fmtHours = (h) => (h >= 1000 ? `${(h / 1000).toFixed(1)}k` : `${h}`);
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const RATER_ROLE = { self: 'self-review', assigner: 'assigner', manager: 'manager' };

function Stars({ value, size = 14 }) {
  const n = Math.round(value || 0);
  return <span className="an-stars" style={{ fontSize: size }}>{'★★★★★'.slice(0, n)}<span className="an-stars-off">{'★★★★★'.slice(n)}</span></span>;
}

function Delta({ pct, suffix = '% vs last', goodDown = false }) {
  if (pct === null || pct === undefined) return null;
  const positive = pct > 0;
  const good = goodDown ? !positive : positive;
  const cls = pct === 0 ? 'flat' : good ? 'up' : 'down';
  const arrow = pct === 0 ? '●' : positive ? '▲' : '▼';
  return <span className={`an-delta ${cls}`}>{arrow} {Math.abs(pct)}{suffix}</span>;
}

// Throughput chart with four render styles.
function ThroughputChart({ series, mode }) {
  const W = 640, H = 220, padX = 24, padTop = 22, base = H - 30;
  const max = Math.max(4, ...series.map((s) => Math.max(s.completed, s.assigned)));
  const stackMax = Math.max(4, ...series.map((s) => s.completed + s.assigned));
  const n = series.length;
  const x = (i) => padX + (i * (W - padX * 2)) / Math.max(1, n - 1);
  const y = (v, m = max) => base - ((base - padTop) * v) / m;
  const pts = (key) => series.map((s, i) => `${x(i)},${y(s[key])}`).join(' ');
  const areaPath = (key) => `M${x(0)},${base} L${series.map((s, i) => `${x(i)},${y(s[key])}`).join(' L')} L${x(n - 1)},${base} Z`;
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => padTop + (base - padTop) * f);
  const tick = (label) => { const d = new Date(label); return `${d.toLocaleString('en', { month: 'short' })} ${d.getUTCDate()}`; };
  const bw = Math.min(26, (W - padX * 2) / n / 2.4);

  return (
    <svg className="an-svg an-svg-throughput" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Task throughput">
      <g stroke="var(--an-grid)" strokeWidth="1">{gridYs.map((gy, i) => <line key={i} x1="0" y1={gy} x2={W} y2={gy} />)}</g>

      {mode === 'area' && (<>
        <path d={areaPath('assigned')} fill="var(--an-accent-soft2)" opacity=".5" />
        <polyline points={pts('assigned')} fill="none" stroke="var(--an-accent-soft2)" strokeWidth="2.5" />
        <path d={areaPath('completed')} fill="var(--an-accent)" opacity=".12" />
        <polyline points={pts('completed')} fill="none" stroke="var(--an-accent)" strokeWidth="2.5" />
        <circle cx={x(n - 1)} cy={y(series[n - 1].completed)} r="4" fill="var(--an-accent)" />
      </>)}

      {mode === 'line' && (<>
        <polyline points={pts('assigned')} fill="none" stroke="var(--an-accent-soft2)" strokeWidth="2.5" strokeDasharray="5 4" />
        <polyline points={pts('completed')} fill="none" stroke="var(--an-accent)" strokeWidth="3" />
        <g fill="var(--an-accent)">{series.map((s, i) => <circle key={i} cx={x(i)} cy={y(s.completed)} r="3" />)}</g>
      </>)}

      {mode === 'bars' && series.map((s, i) => (
        <g key={i}>
          <rect x={x(i) - bw - 1} y={y(s.assigned)} width={bw} height={base - y(s.assigned)} rx="2" fill="var(--an-accent-soft2)" />
          <rect x={x(i) + 1} y={y(s.completed)} width={bw} height={base - y(s.completed)} rx="2" fill="var(--an-accent)" />
        </g>
      ))}

      {mode === 'stacked' && series.map((s, i) => {
        const yc = y(s.completed, stackMax);
        const ya = y(s.completed + s.assigned, stackMax);
        return (
          <g key={i}>
            <rect x={x(i) - bw} y={yc} width={bw * 2} height={base - yc} rx="2" fill="var(--an-accent)" />
            <rect x={x(i) - bw} y={ya} width={bw * 2} height={yc - ya} rx="2" fill="var(--an-accent-soft2)" />
          </g>
        );
      })}

      <g fill="var(--muted)" fontSize="10" textAnchor="middle">
        {series.map((s, i) => (i % 2 === 0 || i === n - 1) && <text key={i} x={x(i)} y={H - 8}>{tick(s.label)}</text>)}
      </g>
    </svg>
  );
}

function Donut({ segments, total, centerLabel }) {
  const R = 15.9155, C = 2 * Math.PI * R;
  let offset = 25;
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

function QualityTrend({ points }) {
  const W = 340, H = 150;
  if (!points.length) return <div className="an-empty">No ratings yet in this range.</div>;
  // With a single month of data, centre the point instead of pinning it left.
  const xs = points.length === 1
    ? [W / 2]
    : points.map((_, i) => 20 + (i * (W - 40)) / (points.length - 1));
  const y = (v) => H - 20 - ((H - 45) * (Math.max(3, Math.min(5, v)) - 3)) / 2;
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

// A compact 1–5 star distribution mini-bar.
function DistBar({ dist }) {
  const total = dist.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="an-dist" title={dist.map((c, i) => `${i + 1}★: ${c}`).join('  ')}>
      {[5, 4, 3, 2, 1].map((star) => {
        const c = dist[star - 1];
        return <span key={star} className={`an-dist-seg s${star}`} style={{ flex: c / total || 0.0001 }} />;
      })}
    </div>
  );
}

// ============ Overview tab ============
function Overview({ data, chartStyle, setChartStyle, onDrill, onQuality }) {
  const s = data.summary;
  return (
    <>
      <section className="an-kpis">
        <button className="an-kpi an-kpi-btn" onClick={() => onDrill('completed')}>
          <div className="an-lab">Tasks completed <span className="an-kpi-go">→</span></div>
          <div className="an-val">{s.tasks_completed.value}</div>
          <Delta pct={s.tasks_completed.delta} />
        </button>
        <button className="an-kpi an-kpi-btn" onClick={() => onDrill('on_time')}>
          <div className="an-lab">On-time rate <span className="an-kpi-go">→</span></div>
          <div className="an-val">{s.on_time.rate === null ? '—' : <>{s.on_time.rate}<small>%</small></>}</div>
          <div className="an-note">{s.on_time.n ? `${s.on_time.n} with due dates` : 'no dated tasks'}</div>
        </button>
        <button className="an-kpi an-kpi-btn" onClick={onQuality}>
          <div className="an-lab">Avg quality <span className="an-kpi-go">→</span></div>
          <div className="an-val">{s.quality.value ? <>{Number(s.quality.value).toFixed(1)}<small>/5</small></> : '—'}</div>
          {s.quality.value ? <Stars value={s.quality.value} /> : <div className="an-note">no ratings yet</div>}
        </button>
        <button className="an-kpi an-kpi-btn" onClick={() => onDrill('billable')}>
          <div className="an-lab">Billable hours <span className="an-kpi-go">→</span></div>
          <div className="an-val">{fmtHours(s.billable_hours.hours)}<small>h</small></div>
          <span className="an-delta flat">● {s.billable_hours.billable_pct}% of logged</span>
        </button>
        <button className="an-kpi an-kpi-btn" onClick={() => onDrill('overdue')}>
          <div className="an-lab">Overdue filings <span className="an-kpi-go">→</span></div>
          <div className={`an-val ${s.overdue_filings ? 'an-bad' : ''}`}>{s.overdue_filings}</div>
          <div className="an-note">{s.overdue_filings ? 'need action' : 'all clear'}</div>
        </button>
      </section>

      <section className="an-grid-3">
        <div className="an-card an-card-chart">
          <div className="an-card-head">
            <div><h3>Task throughput</h3><div className="an-ch-sub">Completed vs assigned</div></div>
            <div className="an-seg an-seg-sm an-seg-wrap">
              {CHART_STYLES.map((c) => <button key={c.key} className={chartStyle === c.key ? 'on' : ''} onClick={() => setChartStyle(c.key)}>{c.label}</button>)}
            </div>
          </div>
          <ThroughputChart series={data.throughput} mode={chartStyle} />
          <div className="an-legend an-legend-btm">
            <span><i style={{ background: 'var(--an-accent)' }} />Completed</span>
            <span><i style={{ background: 'var(--an-accent-soft2)' }} />Assigned</span>
          </div>
        </div>

        <div className="an-card an-card-chart">
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

        <div className="an-card an-card-chart">
          <div className="an-card-head"><div><h3>Quality trend</h3><div className="an-ch-sub">Avg rating, 6 months</div></div></div>
          <QualityTrend points={data.quality_trend} />
        </div>
      </section>

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
                  const chip = over ? 'c-bad' : soon ? 'c-warn' : 'c-ok';
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
    </>
  );
}

// ============ Appraisals tab ============
const MEDAL = ['🥇', '🥈', '🥉'];
function Appraisals({ user, isAdmin, focusUserId, onFocusUser, onOpenTask }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [minStars, setMinStars] = useState(0); // task-list filter
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('date');
  const [empF, setEmpF] = useState('');   // filter table by employee
  const [roleF, setRoleF] = useState(''); // self | assigner | manager

  useEffect(() => {
    setLoading(true); setErr('');
    const qs = new URLSearchParams();
    if (isAdmin && focusUserId) qs.set('user_id', focusUserId);
    api(`/analytics/ratings?${qs.toString()}`).then(setData).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [focusUserId, isAdmin]);

  if (loading && !data) return <div className="an-loading">Loading…</div>;
  if (err) return <div className="an-error">Couldn’t load appraisals: {err}</div>;
  if (!data) return null;

  const employees = [...new Map(data.tasks.map((t) => [t.ratee.name, t.ratee])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const needle = q.trim().toLowerCase();
  const rows = (() => {
    let out = data.tasks.filter((t) => t.stars >= minStars);
    if (empF) out = out.filter((t) => t.ratee.name === empF);
    if (roleF) out = out.filter((t) => t.role === roleF);
    if (needle) out = out.filter((t) => [t.title, t.ratee?.name, t.client_name, t.comment, t.rater?.name].some((s) => (s || '').toLowerCase().includes(needle)));
    const cmp = {
      date: (a, b) => String(b.rated_at || '').localeCompare(String(a.rated_at || '')),
      rating_desc: (a, b) => b.stars - a.stars,
      rating_asc: (a, b) => a.stars - b.stars,
      employee: (a, b) => (a.ratee?.name || '').localeCompare(b.ratee?.name || ''),
    }[sort];
    return cmp ? [...out].sort(cmp) : out;
  })();
  const sum = data.summary;

  return (
    <>
      <section className="an-kpis an-kpis-4">
        <div className="an-kpi">
          <div className="an-lab">Ratings given</div>
          <div className="an-val">{sum.total_ratings}</div>
          <div className="an-note">{sum.rated_people} {sum.rated_people === 1 ? 'person' : 'people'} rated</div>
        </div>
        <div className="an-kpi">
          <div className="an-lab">Firm average</div>
          <div className="an-val">{sum.avg ? <>{sum.avg.toFixed(1)}<small>/5</small></> : '—'}</div>
          {sum.avg ? <Stars value={sum.avg} /> : <div className="an-note">—</div>}
        </div>
        <div className="an-kpi">
          <div className="an-lab">Rating spread</div>
          <div className="an-dist-tall">
            {[5, 4, 3, 2, 1].map((star) => {
              const c = sum.distribution[star - 1];
              const max = Math.max(1, ...sum.distribution);
              return (
                <div className="an-dist-row" key={star}>
                  <span className="an-dist-star">{star}★</span>
                  <div className="an-dist-track"><div className={`an-dist-fill s${star}`} style={{ width: `${(c / max) * 100}%` }} /></div>
                  <span className="an-dist-c">{c}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="an-kpi">
          <div className="an-lab">Pending reviews</div>
          <div className={`an-val ${data.pending ? 'an-warn' : ''}`}>{data.pending}</div>
          <div className="an-note">{data.pending ? 'awaiting a rating' : 'all caught up'}</div>
        </div>
      </section>

      <section className="an-grid-appr">
        {/* Leaderboard */}
        <div className="an-card">
          <div className="an-card-head">
            <div><h3>Employee ranking</h3><div className="an-ch-sub">By average rating · click to filter tasks</div></div>
            {focusUserId && <button className="an-clearfocus" onClick={() => onFocusUser('')}>Show all ✕</button>}
          </div>
          {data.ranking.length === 0 ? <div className="an-empty">No ratings recorded yet.</div> : (
            <div className="an-rank">
              {data.ranking.map((r, i) => (
                <button key={r.id} className={`an-rank-row ${Number(focusUserId) === r.id ? 'on' : ''}`} onClick={() => onFocusUser(String(r.id))}>
                  <span className="an-rank-pos">{i < 3 ? MEDAL[i] : i + 1}</span>
                  <Avatar user={r} size={30} />
                  <div className="an-rank-main">
                    <div className="an-rank-name">{r.name}
                      {r.trend != null && r.trend !== 0 && <span className={`an-trend ${r.trend > 0 ? 'up' : 'down'}`}>{r.trend > 0 ? '▲' : '▼'}{Math.abs(r.trend).toFixed(1)}</span>}
                    </div>
                    <DistBar dist={r.dist} />
                  </div>
                  <div className="an-rank-score"><b>{Number(r.avg).toFixed(1)}</b><span className="an-rank-n">{r.count}★</span></div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Task-wise ratings */}
        <div className="an-card">
          <div className="an-card-head">
            <div>
              <h3>Task ratings</h3>
              <div className="an-ch-sub">{focusUserId ? `${data.ranking.find((r) => r.id === Number(focusUserId))?.name || 'Selected person'}’s rated tasks` : 'Every rated task · who, and who rated'}</div>
            </div>
          </div>
          <div className="an-tbar">
            <input className="an-tbar-search" placeholder="Search task, person, comment…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="date">Date (newest)</option>
              <option value="rating_desc">Rating (high→low)</option>
              <option value="rating_asc">Rating (low→high)</option>
              <option value="employee">Employee A–Z</option>
            </select>
            {!focusUserId && employees.length > 1 && (
              <select value={empF} onChange={(e) => setEmpF(e.target.value)}>
                <option value="">All employees</option>
                {employees.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
              </select>
            )}
            <select value={roleF} onChange={(e) => setRoleF(e.target.value)}>
              <option value="">All reviewers</option>
              <option value="assigner">Assigner</option>
              <option value="manager">Manager</option>
              <option value="self">Self-review</option>
            </select>
            <select value={minStars} onChange={(e) => setMinStars(Number(e.target.value))}>
              <option value={0}>All stars</option>
              <option value={5}>5★ only</option>
              <option value={4}>4★ &amp; up</option>
              <option value={3}>3★ &amp; up</option>
            </select>
            <span className="an-tbar-count">{rows.length} of {data.tasks.length}</span>
          </div>
          {rows.length === 0 ? <div className="an-empty">No rated tasks match.</div> : (
            <div className="an-table-wrap">
              <table className="an-table">
                <thead><tr><th>Task</th>{!focusUserId && <th>Employee</th>}<th>Rating</th><th>Rated by</th><th>Date</th></tr></thead>
                <tbody>
                  {rows.map((t, i) => (
                    <tr key={i} className={onOpenTask ? 'an-row-click' : ''} onClick={() => onOpenTask?.(t.task_id)}>
                      <td className="an-t-name">{t.title}{t.client_name && <div className="an-t-client">{t.client_name}</div>}</td>
                      {!focusUserId && <td><span className="an-owner"><span className="an-mini-av" style={{ background: t.ratee.avatar_color }}>{initials(t.ratee.name)}</span>{t.ratee.name}</span></td>}
                      <td><Stars value={t.stars} size={13} /> {t.comment && <span className="an-cmt" title={t.comment}>“{t.comment}”</span>}</td>
                      <td>{t.rater ? <span className="muted">{t.rater.name}<span className="an-role"> · {RATER_ROLE[t.role] || t.role}</span></span> : <span className="muted">—</span>}</td>
                      <td className="muted">{(t.rated_at || '').slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

// Drill-down modal behind a KPI tile.
const METRIC_TITLE = {
  completed: 'Completed tasks',
  on_time: 'On-time breakdown',
  billable: 'Billable hours',
  overdue: 'Overdue filings',
};
function DetailModal({ metric, period, userId, clientId, isAdmin, onOpenTask, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(metric === 'overdue' ? 'overdue' : 'date');
  const [ownerF, setOwnerF] = useState('');
  const [timing, setTiming] = useState(''); // completed/on_time: '' | ontime | late
  useEffect(() => {
    const qs = new URLSearchParams({ metric, period });
    if (isAdmin && userId) qs.set('user_id', userId);
    if (clientId) qs.set('client_id', clientId);
    api(`/analytics/detail?${qs.toString()}`).then(setData).catch((e) => setErr(e.message));
  }, [metric, period, userId, clientId, isAdmin]);

  const rowsRaw = data?.rows || [];
  const owners = useMemo(() => {
    const m = new Map();
    for (const r of rowsRaw) if (r.who?.name) m.set(r.who.name, r.who);
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rowsRaw]);
  const rows = useMemo(() => {
    let out = rowsRaw;
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((r) => (r.title || '').toLowerCase().includes(needle) || (r.client_name || '').toLowerCase().includes(needle) || (r.who?.name || '').toLowerCase().includes(needle));
    if (ownerF) out = out.filter((r) => (r.who?.name || '') === ownerF);
    if (timing) out = out.filter((r) => (timing === 'late' ? r.on_time === false : r.on_time !== false));
    const cmp = {
      date: (a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')),
      due: (a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')),
      timing: (a, b) => (a.on_time === false ? 1 : 0) - (b.on_time === false ? 1 : 0),
      overdue: (a, b) => (b.days_overdue || 0) - (a.days_overdue || 0),
      title: (a, b) => (a.title || '').localeCompare(b.title || ''),
    }[sort];
    return cmp ? [...out].sort(cmp) : out;
  }, [rowsRaw, q, ownerF, timing, sort]);

  const isTaskMetric = metric === 'completed' || metric === 'on_time';
  const sortOpts = isTaskMetric
    ? [['date', 'Completed (newest)'], ['due', 'Due date'], ['timing', 'On-time first'], ['title', 'Title A–Z']]
    : [['overdue', 'Most overdue'], ['due', 'Due date'], ['title', 'Title A–Z']];

  return (
    <div className="an-modal-overlay" onClick={onClose}>
      <div className="an-modal" onClick={(e) => e.stopPropagation()}>
        <div className="an-modal-head">
          <strong>{METRIC_TITLE[metric]}</strong>
          <button className="an-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="an-modal-body">
          {err && <div className="an-error">{err}</div>}
          {!data && !err && <div className="an-loading">Loading…</div>}

          {data && metric !== 'billable' && (
            <div className="an-tbar">
              <input className="an-tbar-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {sortOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {!userId && owners.length > 1 && (
                <select value={ownerF} onChange={(e) => setOwnerF(e.target.value)}>
                  <option value="">All owners</option>
                  {owners.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                </select>
              )}
              {isTaskMetric && (
                <select value={timing} onChange={(e) => setTiming(e.target.value)}>
                  <option value="">On-time &amp; late</option>
                  <option value="ontime">On time</option>
                  <option value="late">Late</option>
                </select>
              )}
              <span className="an-tbar-count">{rows.length} of {rowsRaw.length}</span>
            </div>
          )}

          {data && isTaskMetric && (
            rows.length === 0 ? <div className="an-empty">No tasks match.</div> : (
              <table className="an-table">
                <thead><tr><th>Task</th>{!userId && <th>Owner</th>}<th>Completed</th><th>Due</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={onOpenTask ? 'an-row-click' : ''} onClick={() => onOpenTask?.(r.id)}>
                      <td className="an-t-name">{r.title}{r.client_name && <div className="an-t-client">{r.client_name}</div>}</td>
                      {!userId && <td>{r.who ? <span className="an-owner"><span className="an-mini-av" style={{ background: r.who.avatar_color }}>{initials(r.who.name)}</span>{r.who.name}</span> : <span className="muted">—</span>}</td>}
                      <td className="muted">{(r.completed_at || '').slice(0, 10)}</td>
                      <td>{r.due_date ? (r.on_time ? <span className="an-chip c-ok">on time</span> : <span className="an-chip c-bad">late</span>) : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {data && metric === 'overdue' && (
            rows.length === 0 ? <div className="an-empty">Nothing matches.</div> : (
              <table className="an-table">
                <thead><tr><th>Filing</th><th>Client</th>{!userId && <th>Owner</th>}<th>Due</th><th>Late</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="an-t-name">{r.title}</td>
                      <td>{r.client_name}</td>
                      {!userId && <td>{r.who ? <span className="an-owner"><span className="an-mini-av" style={{ background: r.who.avatar_color }}>{initials(r.who.name)}</span>{r.who.name}</span> : <span className="muted">Unassigned</span>}</td>}
                      <td className="muted">{r.due_date}</td>
                      <td><span className="an-chip c-bad">{r.days_overdue}d</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {data && metric === 'billable' && (
            <div className="an-bill-cols">
              <div>
                <div className="an-bill-h">By person</div>
                {data.by_user.length === 0 ? <div className="an-empty">No billable time.</div> : data.by_user.map((r, i) => (
                  <div className="an-bill-row" key={i}><span className="an-mini-av" style={{ background: r.avatar_color }}>{initials(r.name)}</span><span className="an-bill-name">{r.name}</span><b>{r.hours}h</b></div>
                ))}
              </div>
              <div>
                <div className="an-bill-h">By client</div>
                {data.by_client.length === 0 ? <div className="an-empty">No billable time.</div> : data.by_client.map((r, i) => (
                  <div className="an-bill-row" key={i}><span className="an-bill-name">{r.name}</span><b>{r.hours}h</b></div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsView({ user, users = [] }) {
  const isAdmin = user.role === 'admin';
  const [tab, setTab] = useState('overview');
  const [period, setPeriod] = useState('month');
  const [userId, setUserId] = useState('');
  const [clientId, setClientId] = useState('');
  const [chartStyle, setChartStyle] = useState('area');
  const [drill, setDrill] = useState(null); // metric for the detail modal
  const [clients, setClients] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  // Open tasks in a modal in place, so clicking one keeps you on the current tab.
  const [openTaskId, setOpenTaskId] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [projects, setProjects] = useState([]);
  const openTask = (id) => setOpenTaskId(id);

  useEffect(() => {
    if (isAdmin) api('/clients').then((d) => setClients(d.clients || [])).catch(() => {});
    api('/workflows').then((d) => setWorkflows(d.workflows || d || [])).catch(() => {});
    api('/projects').then((d) => setProjects(d.projects || d || [])).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    if (tab !== 'overview') return;
    setLoading(true); setErr('');
    const qs = new URLSearchParams({ period });
    if (isAdmin && userId) qs.set('user_id', userId);
    if (clientId) qs.set('client_id', clientId);
    api(`/analytics?${qs.toString()}`).then(setData).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [period, userId, clientId, isAdmin, tab]);

  const focusName = (users.find((u) => u.id === Number(userId)) || user).name;

  return (
    <div className="an-page">
      <header className="an-top">
        <div>
          <h1>Practice Analytics</h1>
          <div className="an-sub">
            {isAdmin && !userId ? 'Firm-wide performance & compliance' : `${focusName}'s performance`}
          </div>
        </div>
        <div className="an-filters">
          {tab === 'overview' && (
            <div className="an-seg">
              {PERIODS.map((p) => <button key={p.key} className={period === p.key ? 'on' : ''} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
            </div>
          )}
          {isAdmin && (
            <select className="an-pick" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">👤 Whole team</option>
              {users.filter((u) => u.name && u.role !== 'guest').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {isAdmin && tab === 'overview' && (
            <select className="an-pick" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">🗂️ All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      </header>

      <div className="an-tabs">
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button className={tab === 'appraisals' ? 'on' : ''} onClick={() => setTab('appraisals')}>Appraisals</button>
      </div>

      {tab === 'overview' && (<>
        {err && <div className="an-error">Couldn’t load analytics: {err}</div>}
        {loading && !data && <div className="an-loading">Loading…</div>}
        {data && (
          <div className={`an-body ${loading ? 'an-dim' : ''}`}>
            <Overview
              data={data}
              chartStyle={chartStyle}
              setChartStyle={setChartStyle}
              onDrill={setDrill}
              onQuality={() => setTab('appraisals')}
            />
          </div>
        )}
      </>)}

      {tab === 'appraisals' && (
        <div className="an-body">
          <Appraisals user={user} isAdmin={isAdmin} focusUserId={userId} onFocusUser={setUserId} onOpenTask={openTask} />
        </div>
      )}

      {drill && (
        <DetailModal
          metric={drill}
          period={period}
          userId={userId}
          clientId={clientId}
          isAdmin={isAdmin}
          onOpenTask={(id) => { setDrill(null); openTask(id); }}
          onClose={() => setDrill(null)}
        />
      )}

      {openTaskId && (
        <TaskModal
          taskId={openTaskId} user={user} users={users}
          workflows={workflows} projects={projects}
          onClose={() => setOpenTaskId(null)}
        />
      )}
    </div>
  );
}
