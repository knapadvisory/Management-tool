import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import TaskModal from './TaskModal.jsx';
import Clock from './Clock.jsx';
import { fmtDuration } from '../time.js';
import { t } from '../i18n.js';

const PRIO = {
  urgent: { label: 'URGENT', cls: 'p-urgent' },
  high: { label: 'HIGH', cls: 'p-high' },
  medium: { label: 'MED', cls: 'p-med' },
  low: { label: 'LOW', cls: 'p-low' },
};

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

function dueBadge(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return { text: 'No date', tone: 'none' };
  if (d < 0) return { text: `${-d}d overdue`, tone: 'over' };
  if (d === 0) return { text: 'Due today', tone: 'today' };
  if (d <= 3) return { text: `T-${d} days`, tone: 'soon' };
  if (d <= 10) return { text: `T-${d} days`, tone: 'mid' };
  return { text: `T-${d} days`, tone: 'far' };
}

function fmtDay(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function DashboardView({ user, users = [], onOpenTasks, onOpenActivity, onOpenTimesheet }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [openTaskId, setOpenTaskId] = useState(null);   // task detail popup
  const [listPopup, setListPopup] = useState(null);     // { title, tasks } popup
  const [taskQuery, setTaskQuery] = useState('');
  const [taskHits, setTaskHits] = useState(null);       // null = not searching
  const searchTimer = React.useRef(null);

  // The caller's LOCAL date, so overdue/aging are computed in the user's time
  // zone (not the server's UTC) — otherwise counts are off around midnight.
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const reload = () => api(`/dashboard?today=${localToday()}`).then(setData).catch(() => {});

  // Search tasks (by title or client) across the firm, like the global search.
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (taskQuery.trim().length < 2) { setTaskHits(null); return undefined; }
    searchTimer.current = setTimeout(async () => {
      try {
        const d = await api(`/search?q=${encodeURIComponent(taskQuery.trim())}`);
        setTaskHits((d.tasks || []).map((t) => ({
          id: t.id, title: t.title, priority: t.priority, due_date: t.due_date, status: t.status,
          stage: t.stage, project: t.client_name ? { name: t.client_name, color: '#6b7280' } : null,
        })));
      } catch { setTaskHits([]); }
    }, 220);
    return () => clearTimeout(searchTimer.current);
  }, [taskQuery]);

  useEffect(() => {
    let alive = true;
    api(`/dashboard?today=${localToday()}`).then((d) => { if (alive) { setData(d); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    api('/workflows').then((d) => alive && setWorkflows(d.workflows || d || [])).catch(() => {});
    api('/projects').then((d) => alive && setProjects(d.projects || d || [])).catch(() => {});
    return () => { alive = false; };
  }, []);

  const openTask = (id) => setOpenTaskId(id);

  // Open a small popup listing a filtered set of tasks (board column / a
  // teammate's workload). Pulls the in-scope task list, which respects role.
  const OPEN = (t) => !['completed', 'cancelled'].includes(t.status);
  const liteMap = (t) => ({
    id: t.id, title: t.title, priority: t.priority, due_date: t.due_date, status: t.status,
    stage: t.stage?.name, assignee: t.assignee, creator: t.creator, project: t.project,
    completed_at: t.completed_at,
  });
  async function openList(title, pred) {
    try {
      const d = await api('/tasks');
      setListPopup({ title, tasks: (d.tasks || []).filter(pred).map(liteMap) });
    } catch { /* ignore */ }
  }
  // Tasks completed this month — includes archived ones (a completed task
  // auto-archives after 7 days, so "closed this month" spans both lists).
  async function openClosedThisMonth() {
    try {
      const month = localToday().slice(0, 7);
      const [act, arch] = await Promise.all([api('/tasks'), api('/tasks?archived=1')]);
      const done = [...(act.tasks || []), ...(arch.tasks || [])]
        .filter((t) => t.completed_at && String(t.completed_at).slice(0, 7) === month)
        .map(liteMap);
      setListPopup({ title: 'Closed this month', tasks: done, mode: 'closed' });
    } catch { /* ignore */ }
  }

  if (loading) return <div className="dash"><p className="muted" style={{ padding: 24 }}>Loading dashboard…</p></div>;
  if (!data) return <div className="dash"><p className="muted" style={{ padding: 24 }}>Couldn’t load the dashboard.</p></div>;

  const isAdmin = data.role === 'admin';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const s = data.summary;

  const subParts = [`${s.open} open task${s.open === 1 ? '' : 's'}`];
  if (isAdmin && s.clients) subParts.push(`across ${s.clients} client${s.clients === 1 ? '' : 's'}`);
  if (s.overdue) subParts.push(`${s.overdue} overdue`);
  else if (s.due_soon) subParts.push(`${s.due_soon} due within 7 days`);

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1 className="dash-title">{greeting}, {(user.name || '').split(' ')[0]}</h1>
          <p className="dash-sub">{today} · {subParts.join(' · ')}</p>
        </div>
        <div className="dash-head-right">
          <Clock />
          <button className="btn btn-primary" onClick={onOpenTasks}>{t('dash.opentasks')} →</button>
        </div>
      </header>

      {/* Practice command-centre KPIs */}
      <div className="dash-kpis">
        <button className="dash-kpi" onClick={onOpenTasks}>
          <span className="dash-kpi-num">{s.open}</span><span className="dash-kpi-lbl">Active tasks</span>
        </button>
        <button className={`dash-kpi ${s.overdue ? 'warn' : ''}`} onClick={() => openList('Overdue', (t) => t.due_date && daysUntil(t.due_date) < 0 && OPEN(t))}>
          <span className="dash-kpi-num">{s.overdue}</span><span className="dash-kpi-lbl">Overdue tasks</span>
        </button>
        <button className="dash-kpi ok" onClick={openClosedThisMonth}>
          <span className="dash-kpi-num">{s.closed_month ?? 0}</span><span className="dash-kpi-lbl">Closed this month</span>
        </button>
        <div className="dash-kpi">
          <span className="dash-kpi-num">{s.clients ?? 0}</span><span className="dash-kpi-lbl">Active clients</span>
        </div>
      </div>

      {data.upcoming.length > 0 && (
        <section className="dash-block">
          <div className="dash-block-head"><h2>{t('dash.upcoming')}</h2></div>
          <div className="deadline-strip">
            {data.upcoming.map((t) => {
              const b = dueBadge(t.due_date);
              return (
                <button key={t.id} className={`deadline-card tone-${b.tone}`} onClick={() => openTask(t.id)}>
                  <span className={`deadline-badge tone-${b.tone}`}>{b.text}</span>
                  <span className="deadline-title" title={t.title}>{t.title}</span>
                  <span className="deadline-meta muted">{t.project?.name || (t.assignee ? t.assignee.name : 'Unassigned')}</span>
                  <span className="deadline-date muted">{fmtDay(t.due_date)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="dash-grid">
        <div className="dash-main">
          {isAdmin ? (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>{t('dash.taskboard')}</h2><button className="dash-link" onClick={onOpenTasks}>Open board →</button></div>
              <div className="board-summary">
                {data.board.map((col) => (
                  <button key={col.stage} className="board-col" onClick={() => openList(col.stage, (t) => t.stage?.name === col.stage && OPEN(t))}>
                    <div className="board-col-count">{col.count}</div>
                    <div className="board-col-name muted">{col.stage}</div>
                  </button>
                ))}
                <button className="board-col done" onClick={() => openList('Completed', (t) => t.status === 'completed')}>
                  <div className="board-col-count">{data.done_count}</div>
                  <div className="board-col-name muted">Completed</div>
                </button>
                {data.board.length === 0 && <p className="muted" style={{ padding: 12 }}>No open tasks.</p>}
              </div>
            </section>
          ) : (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>{t('dash.urgent')}</h2><span className="pill-count">{data.urgent.length}</span></div>
              <TaskList tasks={data.urgent} onOpenTask={openTask} empty="Nothing urgent — you’re on top of it 🎉" detailed currentUserId={user.id} />
            </section>
          )}

          <section className="dash-panel">
            <div className="dash-block-head">
              <h2>{taskHits ? 'Task search' : t('dash.allopen')}</h2>
              <input className="dash-task-search" placeholder="🔍 Search tasks or a client's tasks…"
                value={taskQuery} onChange={(e) => setTaskQuery(e.target.value)} />
              {!taskHits && <span className="pill-count">{data.all_tasks.length}</span>}
            </div>
            <TaskList tasks={taskHits ?? data.all_tasks} onOpenTask={openTask}
              empty={taskHits ? 'No tasks match your search.' : 'No open tasks.'} detailed currentUserId={user.id} />
          </section>
        </div>

        <aside className="dash-side">
          {isAdmin && (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>{t('dash.workload')}</h2></div>
              <div className="workload">
                {data.workload.length === 0 && <p className="muted" style={{ padding: 8 }}>No assigned tasks.</p>}
                {data.workload.map((w) => {
                  const max = Math.max(...data.workload.map((x) => x.count), 1);
                  return (
                    <button key={w.id} className="workload-row" onClick={() => openList(`${w.name}’s tasks`, (t) => t.assignee?.id === w.id && OPEN(t))}>
                      <div className="workload-top">
                        <span className="workload-name"><Avatar user={w} size={20} /> {w.name}</span>
                        <span className="muted">{w.count} task{w.count === 1 ? '' : 's'}</span>
                      </div>
                      <div className="workload-bar"><span style={{ width: `${(w.count / max) * 100}%`, background: w.avatar_color }} /></div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {isAdmin && data.resource_performance?.length > 0 && (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>Resource performance <span className="muted small">this month</span></h2></div>
              <div className="workload">
                {data.resource_performance.map((r) => {
                  const max = Math.max(...data.resource_performance.map((x) => x.minutes), 1);
                  return (
                    <div key={r.id} className="workload-row" style={{ cursor: 'default' }}>
                      <div className="workload-top">
                        <span className="workload-name"><Avatar user={r} size={20} /> {r.name}</span>
                        <span className="muted">{fmtDuration(r.minutes)}</span>
                      </div>
                      <div className="workload-bar"><span style={{ width: `${(r.minutes / max) * 100}%`, background: r.avatar_color }} /></div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="dash-panel">
            <div className="dash-block-head"><h2>{t('dash.activity')}</h2></div>
            <div className="dash-activity">
              {data.activity.length === 0 && <p className="muted" style={{ padding: 8 }}>No recent activity.</p>}
              {data.activity.slice(0, 5).map((a) => (
                <button key={a.id} className="dash-activity-row" onClick={() => openTask(a.task_id)}>
                  <span className="dash-activity-dot" style={{ background: a.user_color }} />
                  <span className="dash-activity-text">
                    <strong>{a.user_name}</strong> {a.action} — <span className="muted">{a.task_title}</span>
                    <span className="dash-activity-time muted">{timeAgo(a.created_at)}</span>
                  </span>
                </button>
              ))}
            </div>
            {data.activity.length > 0 && (
              <button className="dash-seeall" onClick={onOpenActivity}>{t('dash.seeall')} →</button>
            )}
          </section>
        </aside>
      </div>

      {/* Practice analytics: overdue aging, upcoming closures, and the FY view */}
      {(data.aging || data.closures || data.year) && (
        <div className="dash-analytics">
          {data.aging && (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>Overdue aging</h2></div>
              <AgingBars title="Tasks" data={data.aging.tasks} />
              <AgingBars title="Compliance filings" data={data.aging.filings} />
            </section>
          )}
          {data.closures && (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>Upcoming closures</h2><span className="pill-count">{data.closures.buckets?.total || 0}</span></div>
              <div className="closure-buckets">
                {[['≤15d', data.closures.buckets?.d15], ['16–30d', data.closures.buckets?.d30], ['31–45d', data.closures.buckets?.d45], ['46–60d', data.closures.buckets?.d60]].map(([lbl, n]) => (
                  <div key={lbl} className="closure-bucket"><span className="closure-num">{n || 0}</span><span className="closure-lbl">{lbl}</span></div>
                ))}
              </div>
              <div className="closure-list">
                {(data.closures.list || []).length === 0 && <p className="muted" style={{ padding: 8 }}>No filings due in the next 60 days.</p>}
                {(data.closures.list || []).map((d) => (
                  <div key={d.id} className="closure-row">
                    <span className={`closure-when ${daysUntil(d.due_date) <= 7 ? 'soon' : ''}`}>{fmtDay(d.due_date)}</span>
                    <span className="closure-what">{d.title} · <span className="muted">{d.client_name}</span></span>
                    {d.assignee_name && <Avatar user={{ name: d.assignee_name, avatar_color: d.assignee_color }} size={18} />}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {data.year && (
        <section className="dash-panel dash-year">
          <div className="dash-block-head"><h2>This financial year <span className="muted">({data.year.fy})</span></h2><span className="muted small">assigned vs completed</span></div>
          <YearMatrix months={data.year.months} />
        </section>
      )}

      {listPopup && (
        <div className="modal-overlay" onClick={() => setListPopup(null)}>
          <div className="modal dash-listpopup" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>{listPopup.title} <span className="pill-count">{listPopup.tasks.length}</span></strong>
              <button className="icon-btn" onClick={() => setListPopup(null)}>✕</button>
            </div>
            <div className="dash-listpopup-body">
              {listPopup.mode === 'closed'
                ? <ClosedList tasks={listPopup.tasks} onOpenTask={(id) => { setListPopup(null); openTask(id); }} />
                : <TaskList tasks={listPopup.tasks} onOpenTask={(id) => { setListPopup(null); openTask(id); }} empty="No tasks here." detailed currentUserId={user.id} />}
            </div>
          </div>
        </div>
      )}

      {openTaskId && (
        <TaskModal
          taskId={openTaskId} user={user} users={users}
          workflows={workflows} projects={projects}
          onClose={() => { setOpenTaskId(null); reload(); }}
        />
      )}
    </div>
  );
}

// Horizontal aging bar: how overdue things are, split into age buckets.
function AgingBars({ title, data }) {
  const b = data || {};
  const buckets = [
    ['0–15d', b.d15 || 0, 'age-a'],
    ['15–30d', b.d30 || 0, 'age-b'],
    ['30–60d', b.d60 || 0, 'age-c'],
    ['60d+', b.d60plus || 0, 'age-d'],
  ];
  const total = b.total || 0;
  return (
    <div className="aging-block">
      <div className="aging-head"><span>{title}</span><span className="muted">{total} overdue</span></div>
      {total === 0 ? <div className="aging-clear">All clear 🎉</div> : (
        <>
          <div className="aging-bar">
            {buckets.map(([lbl, n, cls]) => n > 0 && <span key={lbl} className={`aging-seg ${cls}`} style={{ flex: n }} title={`${lbl}: ${n}`} />)}
          </div>
          <div className="aging-legend">
            {buckets.map(([lbl, n, cls]) => (
              <span key={lbl} className="aging-key"><span className={`aging-dot ${cls}`} />{lbl} <strong>{n}</strong></span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Financial-year month grid: assigned vs completed bars per month (Apr→Mar).
function YearMatrix({ months = [] }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.assigned, m.completed)));
  return (
    <div className="year-matrix">
      {months.map((m) => (
        <div key={m.key} className="year-col" title={`${m.label}: ${m.completed}/${m.assigned} completed/assigned`}>
          <div className="year-bars">
            <span className="year-bar assigned" style={{ height: `${(m.assigned / max) * 100}%` }} />
            <span className="year-bar completed" style={{ height: `${(m.completed / max) * 100}%` }} />
          </div>
          <div className="year-lbl">{m.label}</div>
        </div>
      ))}
      <div className="year-legend">
        <span><span className="year-dot assigned" /> Assigned</span>
        <span><span className="year-dot completed" /> Completed</span>
      </div>
    </div>
  );
}

const dashFirst = (u) => (u ? u.name.split(' ')[0] : null);
function dashRel(t, me) {
  const c = t.creator?.id, a = t.assignee?.id;
  if (a === me && c === me) return { text: 'Mine', cls: 'self' };
  if (a === me) return { text: 'For you', cls: 'to-me' };
  if (c === me && a && a !== me) return { text: 'You allotted', cls: 'by-me' };
  if (c === me && !a) return { text: 'You created', cls: 'by-me' };
  return null;
}

// "Closed this month" list: due date, actual completion date, and delay.
function ClosedList({ tasks, onOpenTask }) {
  if (!tasks.length) return <p className="muted" style={{ padding: 12 }}>No tasks completed this month.</p>;
  const delayDays = (due, done) => {
    if (!due || !done) return null;
    return Math.round((new Date(done.slice(0, 10) + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
  };
  return (
    <div className="closed-table">
      <div className="closed-row closed-head">
        <span>Task</span><span>Due</span><span>Completed</span><span>Delay</span>
      </div>
      {tasks.map((t) => {
        const p = PRIO[t.priority] || PRIO.medium;
        const d = delayDays(t.due_date, t.completed_at);
        return (
          <button key={t.id} className="closed-row" onClick={() => onOpenTask(t.id)}>
            <span className="closed-title"><span className={`prio-dot ${p.cls}`} />{t.title}</span>
            <span className="closed-cell">{t.due_date ? fmtDay(t.due_date) : <span className="muted">—</span>}</span>
            <span className="closed-cell">{t.completed_at ? fmtDay(t.completed_at.slice(0, 10)) : <span className="muted">—</span>}</span>
            <span className="closed-cell">
              {d == null ? <span className="muted">—</span>
                : d > 0 ? <span className="delay-late">{d}d late</span>
                : <span className="delay-ontime">On time</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TaskList({ tasks, onOpenTask, empty, detailed, currentUserId }) {
  if (!tasks.length) return <p className="muted" style={{ padding: 12 }}>{empty}</p>;
  return (
    <div className="dash-tasklist">
      {tasks.map((t) => {
        const p = PRIO[t.priority] || PRIO.medium;
        const b = dueBadge(t.due_date);
        const rel = dashRel(t, currentUserId);
        const samePerson = t.creator && t.assignee && t.creator.id === t.assignee.id;
        return (
          <button key={t.id} className="dash-task" onClick={() => onOpenTask(t.id)}>
            <span className={`prio-dot ${p.cls}`} title={p.label} />
            <span className="dash-task-main">
              <span className="dash-task-title">{t.title}</span>
              <span className="dash-task-sub">
                {detailed && <span className={`dash-prio ${p.cls}`}>{p.label}</span>}
                {detailed && t.stage && <span className="dash-chip">{t.stage}</span>}
                {t.project?.name && <span className="dash-chip" style={t.project.color ? { borderColor: t.project.color, color: t.project.color } : undefined}>{t.project.name}</span>}
                {/* Allotter → allottee, consistent with the task board. */}
                <span className="dash-people">
                  {rel && <span className={`rel-tag rel-${rel.cls}`}>{rel.text}</span>}
                  {samePerson ? (
                    <span className="dash-person"><Avatar user={t.creator} size={16} /> {dashFirst(t.creator)}</span>
                  ) : (
                    <>
                      {t.creator && <span className="dash-person"><Avatar user={t.creator} size={16} /> {dashFirst(t.creator)}</span>}
                      <span className="task-arrow">→</span>
                      {t.assignee ? <span className="dash-person"><Avatar user={t.assignee} size={16} /> {dashFirst(t.assignee)}</span> : <span className="muted">Unassigned</span>}
                    </>
                  )}
                </span>
              </span>
            </span>
            {t.due_date && (
              <span className="dash-task-duewrap">
                <span className="dash-task-date">{fmtDay(t.due_date)}</span>
                <span className={`dash-task-due tone-${b.tone}`}>{b.text}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
