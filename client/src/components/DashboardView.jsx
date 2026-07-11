import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';

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

export default function DashboardView({ user, onOpenTask, onOpenTasks }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api('/dashboard').then((d) => { if (alive) { setData(d); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

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
        <button className="btn btn-primary" onClick={onOpenTasks}>Open tasks →</button>
      </header>

      {data.upcoming.length > 0 && (
        <section className="dash-block">
          <div className="dash-block-head"><h2>Upcoming deadlines</h2><button className="dash-link" onClick={onOpenTasks}>All tasks →</button></div>
          <div className="deadline-strip">
            {data.upcoming.map((t) => {
              const b = dueBadge(t.due_date);
              return (
                <button key={t.id} className={`deadline-card tone-${b.tone}`} onClick={() => onOpenTask(t.id)}>
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
              <div className="dash-block-head"><h2>Task board</h2><button className="dash-link" onClick={onOpenTasks}>Open board →</button></div>
              <div className="board-summary">
                {data.board.map((col) => (
                  <div key={col.stage} className="board-col">
                    <div className="board-col-count">{col.count}</div>
                    <div className="board-col-name muted">{col.stage}</div>
                  </div>
                ))}
                <div className="board-col done">
                  <div className="board-col-count">{data.done_count}</div>
                  <div className="board-col-name muted">Completed</div>
                </div>
                {data.board.length === 0 && <p className="muted" style={{ padding: 12 }}>No open tasks.</p>}
              </div>
            </section>
          ) : (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>Urgent tasks</h2><span className="pill-count">{data.urgent.length}</span></div>
              <TaskList tasks={data.urgent} onOpenTask={onOpenTask} empty="Nothing urgent — you’re on top of it 🎉" showBy />
            </section>
          )}

          <section className="dash-panel">
            <div className="dash-block-head"><h2>{isAdmin ? 'All open tasks' : 'All my tasks'}</h2><span className="pill-count">{data.all_tasks.length}</span></div>
            <TaskList tasks={data.all_tasks} onOpenTask={onOpenTask} empty="No open tasks." showBy={!isAdmin} showAssignee={isAdmin} />
          </section>
        </div>

        <aside className="dash-side">
          {isAdmin && (
            <section className="dash-panel">
              <div className="dash-block-head"><h2>Team workload</h2></div>
              <div className="workload">
                {data.workload.length === 0 && <p className="muted" style={{ padding: 8 }}>No assigned tasks.</p>}
                {data.workload.map((w) => {
                  const max = Math.max(...data.workload.map((x) => x.count), 1);
                  return (
                    <div key={w.id} className="workload-row">
                      <div className="workload-top">
                        <span className="workload-name"><Avatar user={w} size={20} /> {w.name}</span>
                        <span className="muted">{w.count} task{w.count === 1 ? '' : 's'}</span>
                      </div>
                      <div className="workload-bar"><span style={{ width: `${(w.count / max) * 100}%`, background: w.avatar_color }} /></div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="dash-panel">
            <div className="dash-block-head"><h2>Recent activity</h2></div>
            <div className="dash-activity">
              {data.activity.length === 0 && <p className="muted" style={{ padding: 8 }}>No recent activity.</p>}
              {data.activity.map((a) => (
                <button key={a.id} className="dash-activity-row" onClick={() => onOpenTask(a.task_id)}>
                  <span className="dash-activity-dot" style={{ background: a.user_color }} />
                  <span className="dash-activity-text">
                    <strong>{a.user_name}</strong> {a.action} — <span className="muted">{a.task_title}</span>
                    <span className="dash-activity-time muted">{timeAgo(a.created_at)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TaskList({ tasks, onOpenTask, empty, showBy, showAssignee }) {
  if (!tasks.length) return <p className="muted" style={{ padding: 12 }}>{empty}</p>;
  return (
    <div className="dash-tasklist">
      {tasks.map((t) => {
        const p = PRIO[t.priority] || PRIO.medium;
        const b = dueBadge(t.due_date);
        return (
          <button key={t.id} className="dash-task" onClick={() => onOpenTask(t.id)}>
            <span className={`prio-dot ${p.cls}`} title={p.label} />
            <span className="dash-task-main">
              <span className="dash-task-title">{t.title}</span>
              <span className="dash-task-sub">
                {t.project?.name && <span className="dash-chip" style={t.project.color ? { borderColor: t.project.color, color: t.project.color } : undefined}>{t.project.name}</span>}
                {showBy && t.creator && <span className="muted">by {t.creator.name}</span>}
                {showAssignee && <span className="muted">{t.assignee ? t.assignee.name : 'Unassigned'}</span>}
              </span>
            </span>
            {t.due_date && <span className={`dash-task-due tone-${b.tone}`}>{b.text}</span>}
          </button>
        );
      })}
    </div>
  );
}
