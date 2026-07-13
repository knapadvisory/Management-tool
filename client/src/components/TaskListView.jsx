import React, { useState } from 'react';
import Avatar from './Avatar.jsx';
import { dueStatus } from './TaskCard.jsx';
import { statusMeta } from '../status.js';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

export default function TaskListView({ tasks, onOpen }) {
  const [sort, setSort] = useState({ key: 'updated', dir: -1 });

  function sorted() {
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
        default: av = a.updated_at; bv = b.updated_at;
      }
      return av < bv ? dir : av > bv ? -dir : 0;
    });
    return arr;
  }

  const header = (key, label) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="list-view">
      <table className="task-table">
        <thead>
          <tr>
            {header('title', 'Task')}
            {header('board', 'Board')}
            {header('stage', 'Stage')}
            {header('status', 'Status')}
            {header('creator', 'Allotted by')}
            {header('assignee', 'Allotted to')}
            {header('priority', 'Priority')}
            {header('due', 'Due')}
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {sorted().map((t) => (
            <tr key={t.id} onClick={() => onOpen(t.id)}>
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
              <td>{t.assignee ? <span className="list-assignee"><Avatar user={t.assignee} size={20} /> {t.assignee.name}</span> : <span className="muted">—</span>}</td>
              <td><span className={`priority priority-${t.priority}`}>{t.priority}</span></td>
              <td>{t.due_date ? <span className={`due ${dueStatus(t.due_date)}`}>{t.due_date}</span> : <span className="muted">—</span>}</td>
              <td>{t.checklist_total > 0 ? `${t.checklist_done}/${t.checklist_total}` : <span className="muted">—</span>}</td>
            </tr>
          ))}
          {tasks.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 20 }}>No tasks match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
