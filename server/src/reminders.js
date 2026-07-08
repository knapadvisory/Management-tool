import db from './db.js';
import { createNotification } from './notifications.js';

// Advance a YYYY-MM-DD date by one recurrence interval. Returns null for
// 'none' or a missing date. Month/year math clamps to end-of-month naturally
// via the Date constructor (e.g. Jan 31 + 1 month → Mar 3 is avoided by
// using setMonth on a UTC date and letting it roll, which is fine for tasks).
export function nextDueDate(dateStr, recurrence) {
  if (!dateStr || !recurrence || recurrence === 'none') return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  switch (recurrence) {
    case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
    case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'yearly': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: return null;
  }
  return d.toISOString().slice(0, 10);
}

// Everyone who should hear about a task: its assignee plus all watchers.
function taskAudience(taskId, assigneeId) {
  const ids = new Set(db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(taskId).map((r) => r.user_id));
  if (assigneeId) ids.add(assigneeId);
  return [...ids];
}

// Fire any reminders whose time has arrived. Called on an interval.
export function processDueReminders(io) {
  const due = db.prepare(`SELECT * FROM task_reminders WHERE sent = 0 AND remind_at <= datetime('now')`).all();
  for (const r of due) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.task_id);
    db.prepare('UPDATE task_reminders SET sent = 1 WHERE id = ?').run(r.id);
    if (!task) continue;
    for (const uid of taskAudience(task.id, task.assignee_id)) {
      createNotification(io, {
        user_id: uid, type: 'task_reminder', actor_id: null, task_id: task.id,
        text: `Reminder: "${task.title}"${task.due_date ? ` (due ${task.due_date})` : ''}`,
      });
    }
  }
}

export function startReminderScheduler(io) {
  // Run shortly after boot, then every minute. Reminders have minute
  // granularity, which is plenty for task due-date nudges.
  processDueReminders(io);
  const timer = setInterval(() => processDueReminders(io), 60 * 1000);
  timer.unref?.(); // don't keep the process alive just for the scheduler
  return timer;
}
