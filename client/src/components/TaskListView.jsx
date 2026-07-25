import React, { useState, useMemo } from 'react';
import Avatar from './Avatar.jsx';
import { dueStatus } from './TaskCard.jsx';
import { statusMeta } from '../status.js';
import { api } from '../api.js';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

// Days between the due date and actual completion (null if either is missing).
function delayDays(due, completedAt) {
  if (!due || !completedAt) return null;
  return Math.round((new Date(completedAt.slice(0, 10) + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
}

export default function TaskListView({ tasks, onOpen, user, users = [], onChanged }) {
  const [sort, setSort] = useState({ key: 'updated', dir: -1 });
  const [sel, setSel] = useState(() => new Set());     // selected task ids
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';

  const rows = useMemo(() => {
    const arr = [...tasks];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let av, bv;
      switch (key) {
        case 'title': av = a.title.toLowerCase(); bv = b.title.toLowerCase(); break;
        case 'board': av = a.workflow?.name || ''; bv = b.workflow?.name || ''; break;
        case 'priority': av = PRIORITY_ORDER[a.priority]; bv = PRIORITY_ORDER[b.priority]; break;
        case 'stage': av = a.stage?.position ?? 0; bv = b.stage?.position ?? 0; break;
        case 'status': av = a.status || ''; bv = b.status || ''; break;
        case 'assignee': av = a.assignee?.name || '~'; bv = b.assignee?.name || '~'; break;
        case 'creator': av = a.creator?.name || '~'; bv = b.creator?.name || '~'; break;
        case 'due': av = a.due_date || '9999'; bv = b.due_date || '9999'; break;
        case 'completed': av = a.completed_at || '9999'; bv = b.completed_at || '9999'; break;
        default: av = a.updated_at; bv = b.updated_at;
      }
      return av < bv ? dir : av > bv ? -dir : 0;
    });
    return arr;
  }, [tasks, sort]);

  const header = (key, label) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const allChecked = rows.length > 0 && rows.every((t) => sel.has(t.id));
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(rows.map((t) => t.id)));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clear = () => setSel(new Set());

  // Run `fn` over every selected task, tolerating per-task permission errors,
  // then refresh the list and report anything that couldn't be changed.
  async function runBulk(fn, label) {
    const ids = [...sel];
    if (!ids.length) return;
    setBusy(true);
    let failed = 0;
    await Promise.all(ids.map((id) => fn(id).catch(() => { failed += 1; })));
    setBusy(false);
    clear();
    onChanged?.();
    if (failed) window.alert(`${label}: ${ids.length - failed} done, ${failed} skipped (you may not have permission on those).`);
  }

  const bulkPriority = (p) => p && runBulk((id) => api(`/tasks/${id}`, { method: 'PATCH', body: { priority: p } }), 'Priority');
  const bulkDue = (d) => runBulk((id) => api(`/tasks/${id}`, { method: 'PATCH', body: { due_date: d || null } }), 'Due date');
  const bulkAssign = (uid) => runBulk((id) => api(`/tasks/${id}`, { method: 'PATCH', body: { assignee_ids: uid ? [Number(uid)] : [] } }), 'Reassign');
  const bulkArchive = () => runBulk((id) => api(`/tasks/${id}/archive`, { method: 'POST' }), 'Archive');
  const bulkDelete = () => {
    if (!window.confirm(`Delete ${sel.size} task${sel.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
    runBulk((id) => api(`/tasks/${id}`, { method: 'DELETE' }), 'Delete');
  };

  const people = users.filter((u) => u.name && u.role !== 'guest');

  return (
    <div className="list-view">
      {sel.size > 0 && (
        <div className="bulk-bar">
          <span className="bulk-count">{sel.size} selected</span>
          <select className="bulk-ctl" defaultValue="" onChange={(e) => { bulkAssign(e.target.value === 'none' ? '' : e.target.value); e.target.value = ''; }} disabled={busy}>
            <option value="" disabled>Reassign to…</option>
            <option value="none">Unassign</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select className="bulk-ctl" defaultValue="" onChange={(e) => { bulkPriority(e.target.value); e.target.value = ''; }} disabled={busy}>
            <option value="" disabled>Set priority…</option>
            <option value="urgent">Urgent</option><option value="high">High</option>
            <option value="medium">Medium</option><option value="low">Low</option>
          </select>
          <label className="bulk-ctl bulk-due">Due<input type="date" onChange={(e) => bulkDue(e.target.value)} disabled={busy} /></label>
          <button className="bulk-btn" onClick={bulkArchive} disabled={busy}>🗄 Archive</button>
          {isAdmin && <button className="bulk-btn bulk-danger" onClick={bulkDelete} disabled={busy}>🗑 Delete</button>}
          <button className="bulk-btn bulk-clear" onClick={clear} disabled={busy}>Clear</button>
        </div>
      )}
      <table className="task-table">
        <thead>
          <tr>
            <th className="bulk-check"><input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" /></th>
            {header('title', 'Task')}
            {header('board', 'Board')}
            {header('stage', 'Stage')}
            {header('status', 'Status')}
            {header('creator', 'Allotted by')}
            {header('assignee', 'Allotted to')}
            {header('priority', 'Priority')}
            {header('due', 'Due')}
            {header('completed', 'Completed')}
            <th>Delay</th>
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={sel.has(t.id) ? 'row-selected' : ''} onClick={() => onOpen(t.id)}>
              <td className="bulk-check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.title}`} />
              </td>
              <td>
                <div className="list-title">{t.title}</div>
                {t.project && <span className="project-dot inline" style={{ background: t.project.color }} />}
                {t.tags?.map((tag) => <span key={tag} className="task-tag sm">{tag}</span>)}
              </td>
              <td className="muted">{t.workflow?.name}</td>
              <td>{t.stage?.name}</td>
              <td>
                <span className="status-badge sm" style={{ background: statusMeta(t.status).color }}
                  title={t.status_reason || ''}>{statusMeta(t.status).label}</span>
              </td>
              <td>{t.creator ? <span className="list-assignee"><Avatar user={t.creator} size={20} /> {t.creator.name}</span> : <span className="muted">—</span>}</td>
              <td>{(() => {
                const as = t.assignees?.length ? t.assignees : (t.assignee ? [t.assignee] : []);
                if (!as.length) return <span className="muted">—</span>;
                if (as.length === 1) return <span className="list-assignee"><Avatar user={as[0]} size={20} /> {as[0].name}</span>;
                return <span className="list-assignee">{as.slice(0, 4).map((a) => <Avatar key={a.id} user={a} size={20} />)}{as.length > 4 ? ` +${as.length - 4}` : ''}</span>;
              })()}</td>
              <td><span className={`priority priority-${t.priority}`}>{t.priority}</span></td>
              <td>{t.due_date ? <span className={`due ${dueStatus(t.due_date)}`}>{t.due_date}</span> : <span className="muted">—</span>}</td>
              <td>{t.completed_at ? <span className="list-completed">{t.completed_at.slice(0, 10)}</span> : <span className="muted">—</span>}</td>
              <td>{(() => {
                const d = delayDays(t.due_date, t.completed_at);
                if (d == null) return <span className="muted">—</span>;
                return d > 0 ? <span className="delay-late">{d}d late</span> : <span className="delay-ontime">On time</span>;
              })()}</td>
              <td>{t.checklist_total > 0 ? `${t.checklist_done}/${t.checklist_total}` : <span className="muted">—</span>}</td>
            </tr>
          ))}
          {tasks.length === 0 && <tr><td colSpan={12} className="muted" style={{ padding: 20 }}>No tasks match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
