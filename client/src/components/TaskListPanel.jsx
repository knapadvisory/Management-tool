import React, { useMemo, useState } from 'react';

// A task list with a consistent search + sort + filter toolbar on top. Wraps the
// existing TaskList / ClosedList renderers so every drill-down popup and the
// "All open tasks" list share the same controls. Everything is client-side.

const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const dayNum = (d) => (d ? new Date(d + 'T00:00:00').getTime() : Infinity);
const isLate = (t) => t.completed_at && t.due_date && String(t.completed_at).slice(0, 10) > t.due_date;
const ownerOf = (t) => t.assignee?.name || '';

export default function TaskListPanel({ tasks, mode, onOpenTask, currentUserId, TaskList, ClosedList, empty = 'No tasks here.' }) {
  const closed = mode === 'closed';
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(closed ? 'completed_desc' : 'due_asc');
  const [prio, setPrio] = useState('');   // '' = all
  const [owner, setOwner] = useState(''); // '' = all
  const [delay, setDelay] = useState(''); // closed only: '' | 'ontime' | 'late'

  const owners = useMemo(() => {
    const set = new Map();
    for (const t of tasks) if (t.assignee?.id) set.set(t.assignee.id, t.assignee.name);
    return [...set.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks]);

  const view = useMemo(() => {
    let rows = tasks;
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((t) => (t.title || '').toLowerCase().includes(needle) || (t.project?.name || '').toLowerCase().includes(needle) || ownerOf(t).toLowerCase().includes(needle));
    if (prio) rows = rows.filter((t) => t.priority === prio);
    if (owner) rows = rows.filter((t) => String(t.assignee?.id) === owner);
    if (closed && delay) rows = rows.filter((t) => (delay === 'late' ? isLate(t) : !isLate(t)));

    const cmp = {
      due_asc: (a, b) => dayNum(a.due_date) - dayNum(b.due_date),
      due_desc: (a, b) => dayNum(b.due_date) - dayNum(a.due_date),
      priority: (a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9),
      owner: (a, b) => ownerOf(a).localeCompare(ownerOf(b)),
      title: (a, b) => (a.title || '').localeCompare(b.title || ''),
      completed_desc: (a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')),
      delay: (a, b) => (isLate(b) ? 1 : 0) - (isLate(a) ? 1 : 0),
    }[sort];
    return cmp ? [...rows].sort(cmp) : rows;
  }, [tasks, q, sort, prio, owner, delay, closed]);

  const sortOpts = closed
    ? [['completed_desc', 'Completed (newest)'], ['due_asc', 'Due date'], ['delay', 'Late first'], ['title', 'Title A–Z']]
    : [['due_asc', 'Due (soonest)'], ['due_desc', 'Due (latest)'], ['priority', 'Priority'], ['owner', 'Owner A–Z'], ['title', 'Title A–Z']];

  return (
    <div className="tlp">
      <div className="tlp-bar">
        <input className="tlp-search" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="tlp-ctl">Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {sortOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {!closed && (
          <select className="tlp-ctl-select" value={prio} onChange={(e) => setPrio(e.target.value)}>
            <option value="">All priorities</option>
            <option value="urgent">Urgent</option><option value="high">High</option>
            <option value="medium">Medium</option><option value="low">Low</option>
          </select>
        )}
        {owners.length > 1 && (
          <select className="tlp-ctl-select" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All owners</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        {closed && (
          <select className="tlp-ctl-select" value={delay} onChange={(e) => setDelay(e.target.value)}>
            <option value="">On-time &amp; late</option>
            <option value="ontime">On time</option>
            <option value="late">Late</option>
          </select>
        )}
        <span className="tlp-count">{view.length} of {tasks.length}</span>
      </div>
      {closed
        ? <ClosedList tasks={view} onOpenTask={onOpenTask} />
        : <TaskList tasks={view} onOpenTask={onOpenTask} empty={empty} detailed currentUserId={currentUserId} />}
    </div>
  );
}
