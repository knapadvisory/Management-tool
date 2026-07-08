import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';
import { createNotification } from '../notifications.js';
import { nextDueDate } from '../reminders.js';

const router = Router();
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const STATUSES = ['in_progress', 'completed', 'hold', 'cancelled'];
const STATUS_LABEL = { in_progress: 'In Progress', completed: 'Completed', hold: 'On Hold', cancelled: 'Cancelled' };
const NEEDS_REASON = (s) => s === 'hold' || s === 'cancelled';

const getUser = (id) => (id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);

// Accept an ISO datetime (the client sends UTC) and store it as a SQLite
// "YYYY-MM-DD HH:MM:SS" UTC string, comparable to datetime('now'). null if unparseable.
function normalizeRemindAt(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function taskWithMeta(task) {
  const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ?').get(task.stage_id);
  const workflow = db.prepare('SELECT id, name FROM workflows WHERE id = ?').get(task.workflow_id);
  const project = task.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) : null;
  const commentCount = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(task.id).n;
  const tags = db.prepare('SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag').all(task.id).map((r) => r.tag);
  const cl = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_done), 0) AS done FROM task_checklist WHERE task_id = ?').get(task.id);
  const watcherIds = db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task.id).map((r) => r.user_id);
  const attachmentCount = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?').get(task.id).n;
  const reminderCount = db.prepare('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ? AND sent = 0').get(task.id).n;
  return {
    ...task,
    assignee: publicUser(getUser(task.assignee_id)),
    creator: publicUser(getUser(task.creator_id)),
    stage,
    workflow,
    project,
    comment_count: commentCount,
    tags,
    checklist_total: cl.total,
    checklist_done: cl.done,
    watcher_ids: watcherIds,
    attachment_count: attachmentCount,
    reminder_count: reminderCount,
  };
}

function logActivity(taskId, userId, action) {
  db.prepare('INSERT INTO task_activity (task_id, user_id, action) VALUES (?, ?, ?)').run(taskId, userId, action);
}

function addWatcher(taskId, userId) {
  if (userId) db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
}

// Notify everyone watching a task (except whoever triggered the change):
// a transient toast plus a persistent inbox entry.
function notifyWatchers(req, task, text, type = 'task_update') {
  const io = req.app.get('io');
  if (!io) return;
  const watchers = db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task.id);
  for (const { user_id } of watchers) {
    if (user_id !== req.user.id) {
      io.to(`user:${user_id}`).emit('task:notify', { task_id: task.id, title: task.title, text, by: publicUser(req.user) });
      createNotification(io, {
        user_id, type, actor_id: req.user.id, task_id: task.id,
        text: `${req.user.name} ${text} on "${task.title}"`,
      });
    }
  }
}

// Super admins supervise every task; everyone else sees only tasks they
// created, are assigned to, or watch.
function canSeeTask(user, task) {
  if (user.role === 'admin') return true;
  if (task.creator_id === user.id || task.assignee_id === user.id) return true;
  return !!db.prepare('SELECT 1 FROM task_watchers WHERE task_id = ? AND user_id = ?').get(task.id, user.id);
}

// Who should receive live updates about a task: the people involved in it
// plus every active admin (so admins' boards stay in sync for supervision).
function recipientsForTask(task) {
  const ids = new Set(db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task.id).map((r) => r.user_id));
  if (task.creator_id) ids.add(task.creator_id);
  if (task.assignee_id) ids.add(task.assignee_id);
  for (const { id } of db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1`).all()) ids.add(id);
  return [...ids];
}

function emitChanged(req, taskId) {
  const task = taskWithMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  const io = req.app.get('io');
  if (io) for (const uid of recipientsForTask(task)) io.to(`user:${uid}`).emit('task:changed', { task });
  return task;
}

// When a recurring task is completed, clone it into the first stage with the
// due date advanced by its repeat rule. Tags, checklist (reset) and reminders
// (shifted by the same interval) carry over. Returns the new task or null.
function spawnNextOccurrence(req, task) {
  const newDue = nextDueDate(task.due_date, task.recurrence);
  if (!newDue) return null;
  const firstStage = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(task.workflow_id);
  if (!firstStage) return null;

  const info = db.prepare(`
    INSERT INTO tasks (title, description, workflow_id, project_id, stage_id, assignee_id, creator_id, priority, due_date, recurrence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.title, task.description, task.workflow_id, task.project_id, firstStage.id,
    task.assignee_id, task.creator_id, task.priority, newDue, task.recurrence);
  const newId = info.lastInsertRowid;

  for (const { tag } of db.prepare('SELECT tag FROM task_tags WHERE task_id = ?').all(task.id)) {
    db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)').run(newId, tag);
  }
  const steps = db.prepare('SELECT text, position FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(task.id);
  const insStep = db.prepare('INSERT INTO task_checklist (task_id, text, position, is_done) VALUES (?, ?, ?, 0)');
  steps.forEach((s) => insStep.run(newId, s.text, s.position));
  for (const uid of db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task.id).map((r) => r.user_id)) {
    addWatcher(newId, uid);
  }
  // Shift each future reminder forward by the same number of days as the due date moved.
  const shiftDays = Math.round((new Date(newDue + 'T00:00:00Z') - new Date(task.due_date + 'T00:00:00Z')) / 86400000);
  for (const rem of db.prepare('SELECT remind_at FROM task_reminders WHERE task_id = ?').all(task.id)) {
    const at = new Date(rem.remind_at.replace(' ', 'T') + 'Z');
    if (Number.isNaN(at.getTime())) continue;
    at.setUTCDate(at.getUTCDate() + shiftDays);
    db.prepare('INSERT INTO task_reminders (task_id, remind_at, created_by) VALUES (?, ?, ?)')
      .run(newId, at.toISOString().slice(0, 19).replace('T', ' '), req.user.id);
  }
  logActivity(newId, req.user.id, `created automatically (repeats ${task.recurrence}) — due ${newDue}`);
  emitChanged(req, newId);
  notifyWatchers(req, db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId), `is up next (repeats ${task.recurrence}, due ${newDue})`, 'task_recurred');
  return newId;
}

function loadTask(req, res) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
  if (!canSeeTask(req.user, task)) { res.status(403).json({ error: 'You do not have access to this task' }); return null; }
  return task;
}

// --- Tasks list & CRUD ---

router.get('/', (req, res) => {
  const { workflow_id, project_id, assignee_id, tag, overdue, watching } = req.query;
  let sql = 'SELECT DISTINCT t.* FROM tasks t';
  const where = ['1=1'];
  const params = [];
  if (tag) { sql += ' JOIN task_tags tt ON tt.task_id = t.id'; where.push('tt.tag = ?'); params.push(tag); }
  if (watching) { sql += ' JOIN task_watchers tw ON tw.task_id = t.id AND tw.user_id = ?'; params.push(req.user.id); }
  if (workflow_id) { where.push('t.workflow_id = ?'); params.push(workflow_id); }
  if (project_id) { where.push('t.project_id = ?'); params.push(project_id); }
  if (assignee_id) { where.push('t.assignee_id = ?'); params.push(assignee_id); }
  if (overdue) { where.push(`t.due_date IS NOT NULL AND t.due_date < date('now')`); }
  // Non-admins see only tasks they created, are assigned to, or watch.
  if (req.user.role !== 'admin') {
    where.push(`(t.creator_id = ? OR t.assignee_id = ? OR EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = ?))`);
    params.push(req.user.id, req.user.id, req.user.id);
  }
  sql += ' WHERE ' + where.join(' AND ') + ' ORDER BY t.updated_at DESC';
  res.json({ tasks: db.prepare(sql).all(...params).map(taskWithMeta) });
});

router.post('/', (req, res) => {
  const { title, description = '', workflow_id, project_id = null, assignee_id = null,
    priority = 'medium', due_date = null, tags = [], checklist = [], recurrence = 'none', reminders = [] } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (!RECURRENCES.includes(recurrence)) return res.status(400).json({ error: 'Invalid recurrence' });
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow_id);
  if (!wf) return res.status(400).json({ error: 'Workflow not found' });
  if (assignee_id && !getUser(assignee_id)) return res.status(400).json({ error: 'Assignee not found' });
  if (project_id && !db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id)) {
    return res.status(400).json({ error: 'Project not found' });
  }
  const firstStage = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wf.id);
  const info = db.prepare(`
    INSERT INTO tasks (title, description, workflow_id, project_id, stage_id, assignee_id, creator_id, priority, due_date, recurrence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), description, wf.id, project_id, firstStage.id, assignee_id, req.user.id, priority, due_date, recurrence);
  const taskId = info.lastInsertRowid;

  const insReminder = db.prepare('INSERT INTO task_reminders (task_id, remind_at, created_by) VALUES (?, ?, ?)');
  (Array.isArray(reminders) ? reminders : []).forEach((r) => {
    const at = normalizeRemindAt(r);
    if (at) insReminder.run(taskId, at, req.user.id);
  });

  for (const tag of tags) {
    const clean = String(tag).trim().toLowerCase();
    if (clean) db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)').run(taskId, clean);
  }
  // Steps supplied at creation (e.g. copied from a template) become the checklist.
  const insStep = db.prepare('INSERT INTO task_checklist (task_id, text, position) VALUES (?, ?, ?)');
  (Array.isArray(checklist) ? checklist : []).forEach((s, i) => {
    const text = String(typeof s === 'string' ? s : s?.text || '').trim();
    if (text) insStep.run(taskId, text, i);
  });
  logActivity(taskId, req.user.id, 'created this task');
  addWatcher(taskId, req.user.id);
  if (assignee_id) {
    logActivity(taskId, req.user.id, `assigned it to ${getUser(assignee_id).name}`);
    addWatcher(taskId, assignee_id);
  }

  const task = emitChanged(req, taskId);
  if (assignee_id && assignee_id !== req.user.id) {
    const io = req.app.get('io');
    io?.to(`user:${assignee_id}`).emit('task:assigned', { task, by: publicUser(req.user) });
    createNotification(io, { user_id: assignee_id, type: 'task_assigned', actor_id: req.user.id, task_id: taskId, text: `${req.user.name} assigned you "${task.title}"` });
  }
  res.status(201).json(task);
});

router.get('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const comments = db.prepare(`
    SELECT tc.*, u.name AS user_name, u.avatar_color FROM task_comments tc
    JOIN users u ON u.id = tc.user_id WHERE tc.task_id = ? ORDER BY tc.id
  `).all(task.id);
  const activity = db.prepare(`
    SELECT ta.*, u.name AS user_name FROM task_activity ta
    JOIN users u ON u.id = ta.user_id WHERE ta.task_id = ? ORDER BY ta.id
  `).all(task.id);
  const checklist = db.prepare('SELECT * FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(task.id);
  const watchers = db.prepare(`
    SELECT u.* FROM task_watchers tw JOIN users u ON u.id = tw.user_id WHERE tw.task_id = ?
  `).all(task.id).map(publicUser);
  const attachments = db.prepare('SELECT id, original_name, mime_type, size FROM attachments WHERE task_id = ? ORDER BY id').all(task.id);
  const reminders = db.prepare('SELECT id, remind_at, sent FROM task_reminders WHERE task_id = ? ORDER BY remind_at').all(task.id);
  res.json({ task: taskWithMeta(task), comments, activity, checklist, watchers, attachments, reminders });
});

router.patch('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const { title, description, stage_id, assignee_id, priority, due_date, project_id, recurrence, status, status_reason } = req.body;

  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  if (recurrence !== undefined && !RECURRENCES.includes(recurrence)) {
    return res.status(400).json({ error: 'Invalid recurrence' });
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  // Putting a task on hold or cancelling it requires a reason.
  const statusChanged = status !== undefined && status !== task.status;
  if (statusChanged && NEEDS_REASON(status) && !(status_reason || '').trim()) {
    return res.status(400).json({ error: `A reason is required to mark a task as ${STATUS_LABEL[status]}` });
  }

  let movedToDone = false;
  if (stage_id !== undefined && stage_id !== task.stage_id) {
    const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ? AND workflow_id = ?').get(stage_id, task.workflow_id);
    if (!stage) return res.status(400).json({ error: 'Stage does not belong to this workflow' });
    const oldStage = db.prepare('SELECT * FROM workflow_stages WHERE id = ?').get(task.stage_id);
    logActivity(task.id, req.user.id, `moved it to "${stage.name}"`);
    notifyWatchers(req, task, `moved to "${stage.name}"`, 'task_moved');
    movedToDone = !!stage.is_done && !oldStage?.is_done;
  }
  if (assignee_id !== undefined && assignee_id !== task.assignee_id) {
    if (assignee_id !== null && !getUser(assignee_id)) return res.status(400).json({ error: 'Assignee not found' });
    const name = assignee_id ? getUser(assignee_id).name : null;
    logActivity(task.id, req.user.id, name ? `assigned it to ${name}` : 'removed the assignee');
    if (assignee_id) addWatcher(task.id, assignee_id);
  }
  if (project_id !== undefined && project_id !== null && !db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id)) {
    return res.status(400).json({ error: 'Project not found' });
  }

  // Notify watchers of other meaningful edits (title, priority, due date, repeat).
  if (title !== undefined && title.trim() && title.trim() !== task.title) {
    logActivity(task.id, req.user.id, `renamed it to "${title.trim()}"`);
    notifyWatchers(req, task, 'renamed the task', 'task_update');
  }
  if (priority !== undefined && priority !== task.priority) {
    logActivity(task.id, req.user.id, `changed priority to ${priority}`);
    notifyWatchers(req, task, `changed priority to ${priority}`, 'task_update');
  }
  if (due_date !== undefined && (due_date || null) !== (task.due_date || null)) {
    logActivity(task.id, req.user.id, due_date ? `set the due date to ${due_date}` : 'cleared the due date');
    notifyWatchers(req, task, due_date ? `set the due date to ${due_date}` : 'cleared the due date', 'task_update');
  }
  if (recurrence !== undefined && recurrence !== task.recurrence) {
    logActivity(task.id, req.user.id, recurrence === 'none' ? 'turned off repeat' : `set it to repeat ${recurrence}`);
  }

  // Status lifecycle change (with reason for hold/cancelled).
  let completedNow = false;
  let reasonWrite = 0;
  let reasonValue = null;
  if (statusChanged) {
    const reason = NEEDS_REASON(status) ? (status_reason || '').trim() : '';
    reasonWrite = 1;
    reasonValue = reason;
    const suffix = reason ? ` — ${reason}` : '';
    logActivity(task.id, req.user.id, `set status to ${STATUS_LABEL[status]}${suffix}`);
    notifyWatchers(req, task, `marked it ${STATUS_LABEL[status]}${suffix}`, 'task_status');
    completedNow = status === 'completed';
  }

  db.prepare(`
    UPDATE tasks SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      stage_id = COALESCE(?, stage_id),
      assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END,
      priority = COALESCE(?, priority),
      due_date = CASE WHEN ? THEN ? ELSE due_date END,
      project_id = CASE WHEN ? THEN ? ELSE project_id END,
      recurrence = COALESCE(?, recurrence),
      status = COALESCE(?, status),
      status_reason = CASE WHEN ? THEN ? ELSE status_reason END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title?.trim() || null, description ?? null, stage_id ?? null,
    assignee_id !== undefined ? 1 : 0, assignee_id ?? null,
    priority ?? null,
    due_date !== undefined ? 1 : 0, due_date ?? null,
    project_id !== undefined ? 1 : 0, project_id ?? null,
    recurrence ?? null,
    status ?? null,
    reasonWrite, reasonValue,
    task.id
  );

  const updated = emitChanged(req, task.id);
  if (assignee_id && assignee_id !== task.assignee_id && assignee_id !== req.user.id) {
    const io = req.app.get('io');
    io?.to(`user:${assignee_id}`).emit('task:assigned', { task: updated, by: publicUser(req.user) });
    createNotification(io, { user_id: assignee_id, type: 'task_assigned', actor_id: req.user.id, task_id: task.id, text: `${req.user.name} assigned you "${updated.title}"` });
  }
  // Completing a recurring task — via a done stage or the Completed status —
  // generates its next occurrence automatically (only once per request).
  if (movedToDone || completedNow) spawnNextOccurrence(req, db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  // Only super admins may delete a task; everyone else changes its status.
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can delete a task. Change its status instead.' });
  }
  const task = loadTask(req, res);
  if (!task) return;
  // Tell watchers before the row (and its watcher rows) disappear.
  notifyWatchers(req, task, 'deleted this task', 'task_deleted');
  const recipients = recipientsForTask(task);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  const io = req.app.get('io');
  if (io) for (const uid of recipients) io.to(`user:${uid}`).emit('task:deleted', { task_id: task.id, workflow_id: task.workflow_id });
  res.json({ ok: true });
});

// --- Comments ---

router.post('/:id/comments', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const info = db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)')
    .run(task.id, req.user.id, content.trim());
  addWatcher(task.id, req.user.id);
  notifyWatchers(req, task, 'added a note', 'task_note');
  emitChanged(req, task.id);
  const comment = db.prepare(`
    SELECT tc.*, u.name AS user_name, u.avatar_color FROM task_comments tc
    JOIN users u ON u.id = tc.user_id WHERE tc.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json(comment);
});

// --- Task chat (real-time; messages sent over sockets) ---

router.get('/:id/chat', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const messages = db.prepare(`
    SELECT tm.*, u.name AS user_name, u.avatar_color FROM task_messages tm
    JOIN users u ON u.id = tm.user_id WHERE tm.task_id = ? ORDER BY tm.id
  `).all(task.id);
  res.json({ messages });
});

// --- Reminders ---

router.post('/:id/reminders', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const at = normalizeRemindAt(req.body.remind_at);
  if (!at) return res.status(400).json({ error: 'A valid reminder time is required' });
  db.prepare('INSERT INTO task_reminders (task_id, remind_at, created_by) VALUES (?, ?, ?)').run(task.id, at, req.user.id);
  addWatcher(task.id, req.user.id);
  emitChanged(req, task.id);
  res.status(201).json(db.prepare('SELECT id, remind_at, sent FROM task_reminders WHERE task_id = ? ORDER BY remind_at').all(task.id));
});

router.delete('/:id/reminders/:reminderId', (req, res) => {
  db.prepare('DELETE FROM task_reminders WHERE id = ? AND task_id = ?').run(req.params.reminderId, req.params.id);
  emitChanged(req, req.params.id);
  res.json(db.prepare('SELECT id, remind_at, sent FROM task_reminders WHERE task_id = ? ORDER BY remind_at').all(req.params.id));
});

// --- Checklist ---

router.post('/:id/checklist', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Checklist item text is required' });
  const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM task_checklist WHERE task_id = ?').get(task.id).p;
  db.prepare('INSERT INTO task_checklist (task_id, text, position) VALUES (?, ?, ?)').run(task.id, text, max + 1);
  emitChanged(req, task.id);
  res.status(201).json(db.prepare('SELECT * FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(task.id));
});

router.patch('/:id/checklist/:itemId', (req, res) => {
  const item = db.prepare('SELECT * FROM task_checklist WHERE id = ? AND task_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const { is_done, text } = req.body;
  db.prepare('UPDATE task_checklist SET is_done = COALESCE(?, is_done), text = COALESCE(?, text) WHERE id = ?')
    .run(is_done === undefined ? null : is_done ? 1 : 0, text?.trim() || null, item.id);
  emitChanged(req, req.params.id);
  res.json(db.prepare('SELECT * FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(req.params.id));
});

router.delete('/:id/checklist/:itemId', (req, res) => {
  db.prepare('DELETE FROM task_checklist WHERE id = ? AND task_id = ?').run(req.params.itemId, req.params.id);
  emitChanged(req, req.params.id);
  res.json(db.prepare('SELECT * FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(req.params.id));
});

// --- Tags ---

router.post('/:id/tags', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const tag = (req.body.tag || '').trim().toLowerCase();
  if (!tag || tag.length > 30) return res.status(400).json({ error: 'Tag must be 1–30 characters' });
  db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)').run(task.id, tag);
  res.json(emitChanged(req, task.id));
});

router.delete('/:id/tags/:tag', (req, res) => {
  db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag = ?').run(req.params.id, decodeURIComponent(req.params.tag));
  res.json(emitChanged(req, req.params.id));
});

// --- Watchers ---

router.post('/:id/watch', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  addWatcher(task.id, req.user.id);
  res.json(emitChanged(req, task.id));
});

router.delete('/:id/watch', (req, res) => {
  db.prepare('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json(emitChanged(req, req.params.id));
});

// --- Attachments (files were uploaded via /api/uploads first) ---

router.post('/:id/attachments', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const { attachment_ids = [] } = req.body;
  const link = db.prepare('UPDATE attachments SET task_id = ? WHERE id = ? AND uploader_id = ? AND task_id IS NULL AND message_id IS NULL');
  for (const aid of attachment_ids) link.run(task.id, aid, req.user.id);
  emitChanged(req, task.id);
  res.json(db.prepare('SELECT id, original_name, mime_type, size FROM attachments WHERE task_id = ? ORDER BY id').all(task.id));
});

router.delete('/:id/attachments/:attId', (req, res) => {
  db.prepare('DELETE FROM attachments WHERE id = ? AND task_id = ?').run(req.params.attId, req.params.id);
  emitChanged(req, req.params.id);
  res.json(db.prepare('SELECT id, original_name, mime_type, size FROM attachments WHERE task_id = ? ORDER BY id').all(req.params.id));
});

// Distinct tags across all tasks, for filter menus.
router.get('/meta/tags', (req, res) => {
  res.json({ tags: db.prepare('SELECT DISTINCT tag FROM task_tags ORDER BY tag').all().map((r) => r.tag) });
});

export default router;
