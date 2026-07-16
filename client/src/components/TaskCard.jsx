import React from 'react';
import Avatar from './Avatar.jsx';
import { statusMeta } from '../status.js';

// Returns 'overdue' | 'due-soon' | '' for a YYYY-MM-DD date against today.
export function dueStatus(due) {
  if (!due) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diffDays = Math.round((d - today) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 2) return 'due-soon';
  return '';
}

// From the viewer's perspective: is this task theirs, allotted to them, or one
// they allotted to someone else?
function assigneesOf(task) {
  return task.assignees?.length ? task.assignees : (task.assignee ? [task.assignee] : []);
}
function relationship(task, me) {
  const c = task.creator?.id;
  const ids = assigneesOf(task).map((a) => a.id);
  const iAmAssignee = ids.includes(me);
  if (iAmAssignee && c === me) return { text: 'Mine', cls: 'self' };
  if (iAmAssignee) return { text: 'For you', cls: 'to-me' };       // allotted to me by someone
  if (c === me && ids.length) return { text: 'You allotted', cls: 'by-me' }; // I allotted to someone
  if (c === me) return { text: 'You created', cls: 'by-me' };
  return null; // not involving me (e.g. an admin viewing everyone's tasks)
}
const firstName = (u) => (u ? u.name.split(' ')[0] : null);

export default function TaskCard({ task, onOpen, draggable, onDragStart, currentUserId }) {
  const due = dueStatus(task.due_date);
  const watching = task.watcher_ids?.includes(currentUserId);
  const rel = relationship(task, currentUserId);
  const { creator } = task;
  const assignees = assigneesOf(task);
  const samePerson = creator && assignees.length === 1 && creator.id === assignees[0].id;
  return (
    <div
      className="task-card"
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={() => onOpen(task.id)}
    >
      {task.project && (
        <div className="task-project" style={{ color: task.project.color }}>
          <span className="project-dot" style={{ background: task.project.color }} />
          {task.project.name}
        </div>
      )}
      <div className="task-title">{task.title}</div>

      {task.tags?.length > 0 && (
        <div className="task-tags">
          {task.tags.map((t) => <span key={t} className="task-tag">{t}</span>)}
        </div>
      )}

      <div className="task-meta">
        {task.status && task.status !== 'in_progress' && (
          <span className="status-badge sm" style={{ background: statusMeta(task.status).color }}
            title={task.status_reason ? `${statusMeta(task.status).label}: ${task.status_reason}` : statusMeta(task.status).label}>
            {statusMeta(task.status).label}
          </span>
        )}
        <span className={`priority priority-${task.priority}`}>{task.priority}</span>
        {task.due_date && <span className={`due ${due}`}>📅 {task.due_date}</span>}
        {task.recurrence && task.recurrence !== 'none' && <span title={`Repeats ${task.recurrence}`}>🔁</span>}
        {task.reminder_count > 0 && <span title={`${task.reminder_count} reminder(s)`}>🔔 {task.reminder_count}</span>}
        {task.checklist_total > 0 && (
          <span className={`checklist-badge ${task.checklist_done === task.checklist_total ? 'complete' : ''}`}>
            ☑ {task.checklist_done}/{task.checklist_total}
          </span>
        )}
        {task.attachment_count > 0 && <span>📎 {task.attachment_count}</span>}
        {task.comment_count > 0 && <span>💬 {task.comment_count}</span>}
        {watching && <span title="You're watching this">👁</span>}
      </div>

      {/* Allotter → allottee, so you can see who's involved without opening it. */}
      <div className="task-people">
        {rel && <span className={`rel-tag rel-${rel.cls}`}>{rel.text}</span>}
        {samePerson ? (
          <span className="task-person" title={`Created by ${creator.name} for themselves`}>
            <Avatar user={creator} size={18} /><span className="task-person-name">{firstName(creator)}</span>
          </span>
        ) : (
          <>
            {creator && (
              <span className="task-person" title={`Allotted by ${creator.name}`}>
                <Avatar user={creator} size={18} /><span className="task-person-name">{firstName(creator)}</span>
              </span>
            )}
            <span className="task-arrow" aria-hidden>→</span>
            {assignees.length ? (
              <span className="task-assignees" title={`Allotted to ${assignees.map((a) => a.name).join(', ')}`}>
                {assignees.slice(0, 3).map((a) => (
                  <span key={a.id} className="task-person">
                    <Avatar user={a} size={18} />
                    {assignees.length === 1 && <span className="task-person-name">{firstName(a)}</span>}
                  </span>
                ))}
                {assignees.length > 3 && <span className="task-person-name">+{assignees.length - 3}</span>}
              </span>
            ) : (
              <span className="task-person muted">Unassigned</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
