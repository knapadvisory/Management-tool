import React from 'react';
import Avatar from './Avatar.jsx';

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

export default function TaskCard({ task, onOpen, draggable, onDragStart, currentUserId }) {
  const due = dueStatus(task.due_date);
  const watching = task.watcher_ids?.includes(currentUserId);
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
        {task.assignee && <Avatar user={task.assignee} size={22} />}
      </div>
    </div>
  );
}
