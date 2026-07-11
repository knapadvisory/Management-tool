import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import TaskModal from './TaskModal.jsx';

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

export default function DashboardView({ user, users = [], onOpenTasks, onOpenActivity }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [openTaskId, setOpenTaskId] = useState(null);   // task detail popup
  const [listPopup, setListPopup] = useState(null);     // { title, tasks } popup

  const reload = () => api('/dashboard').then(setData).catch(() => {});

  useEffect(() => {
    let alive = true;
    api('/dashboard').then((d) => { if (alive) { setData(d); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    api('/workflows').then((d) => alive && setWorkflows(d.workflows || d || [])).catch(() => {});
    api('/projects').then((d) => alive && setProjects(d.projects || d || [])).catch(() => {});
    return () => { alive = false; };
  }, []);

  const openTask = (id) => setOpenTaskId(id);

  // Open a small popup listing a filtered set of tasks (board column / a
  // teammate's workload). Pulls the in-scope task list, which respects role.
  const OPEN = (t) => !['completed', 'cancelled'].includes(t.status);
  async function openList(title, pred) {
    try {
      const d = await api('/tasks');
      const tasks = (d.tasks || []).filter(pred).map((t) => ({
        id: t.id, title: t.title, priority: t.priority, due_date: t.due_date, status: t.status,
        stage: t.stage?.name, assignee: t.assignee, creator: t.creator, project: t.project,
      }));
      setListPopup({ title, tasks });
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
        <button className="btn btn-primary" onClick={onOpenTasks}>Open tasks →</button>
      </header>

      {data.upcoming.length > 0 && (
        <section className="dash-block">
          <div className="dash-block-head"><h2>Upcoming deadlines</h2><button className="dash-link" onClick={onOpenTasks}>All tasks →</button></div>
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
              <div className="dash-block-head"><h2>Task board</h2><button className="dash-link" onClick={onOpenTasks}>Open board →</button></div>
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
              <div className="dash-block-head"><h2>Urgent tasks</h2><span className="pill-count">{data.urgent.length}</span></div>
              <TaskList tasks={data.urgent} onOpenTask={openTask} empty="Nothing urgent — you’re on top of it 🎉" detailed />
            </section>
          )}

          <section className="dash-panel">
            <div className="dash-block-head"><h2>{isAdmin ? 'All open tasks' : 'All my tasks'}</h2><span className="pill-count">{data.all_tasks.length}</span></div>
            <TaskList tasks={data.all_tasks} onOpenTask={openTask} empty="No open tasks." detailed showAssignee={isAdmin} showBy={!isAdmin} />
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

          <section className="dash-panel">
            <div className="dash-block-head"><h2>Recent activity</h2></div>
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
              <button className="dash-seeall" onClick={onOpenActivity}>See all activity →</button>
            )}
          </section>
        </aside>
      </div>

      {listPopup && (
        <div className="modal-overlay" onClick={() => setListPopup(null)}>
          <div className="modal dash-listpopup" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>{listPopup.title} <span className="pill-count">{listPopup.tasks.length}</span></strong>
              <button className="icon-btn" onClick={() => setListPopup(null)}>✕</button>
            </div>
            <div className="dash-listpopup-body">
              <TaskList tasks={listPopup.tasks} onOpenTask={(id) => { setListPopup(null); openTask(id); }} empty="No tasks here." detailed showAssignee />
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

function TaskList({ tasks, onOpenTask, empty, showBy, showAssignee, detailed }) {
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
                {detailed && <span className={`dash-prio ${p.cls}`}>{p.label}</span>}
                {detailed && t.stage && <span className="dash-chip">{t.stage}</span>}
                {t.project?.name && <span className="dash-chip" style={t.project.color ? { borderColor: t.project.color, color: t.project.color } : undefined}>{t.project.name}</span>}
                {showBy && t.creator && <span className="muted">by {t.creator.name}</span>}
                {showAssignee && (
                  <span className="dash-assignee muted">
                    {t.assignee ? <><Avatar user={t.assignee} size={16} /> {t.assignee.name}</> : 'Unassigned'}
                  </span>
                )}
              </span>
            </span>
            {t.due_date && <span className={`dash-task-due tone-${b.tone}`}>{b.text}</span>}
          </button>
        );
      })}
    </div>
  );
}
