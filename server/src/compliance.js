import db from './db.js';

// Advance a YYYY-MM-DD date by one recurrence step (monthly/quarterly/yearly).
export function advanceDate(dateStr, recurrence) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (recurrence === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (recurrence === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

// Mark a deadline as filed and, if it recurs, spawn the next period's deadline
// (carrying the same assignee). Used both from the client UI and when the
// deadline's linked task is completed.
export function completeDeadline(dl, userId) {
  db.prepare("UPDATE client_deadlines SET completed = 1, completed_at = datetime('now') WHERE id = ?").run(dl.id);
  if (dl.recurrence && dl.recurrence !== 'none') {
    const next = advanceDate(dl.due_date, dl.recurrence);
    if (next) db.prepare(`
      INSERT INTO client_deadlines (client_id, title, due_date, recurrence, assignee_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(dl.client_id, dl.title, next, dl.recurrence, dl.assignee_id || null, userId);
  }
}

// When a task that was generated from a deadline is completed, tick the
// deadline off (and roll it forward). Returns how many deadlines were closed.
export function completeDeadlinesForTask(taskId, userId) {
  const dls = db.prepare('SELECT * FROM client_deadlines WHERE task_id = ? AND completed = 0').all(taskId);
  for (const dl of dls) completeDeadline(dl, userId);
  return dls.length;
}
