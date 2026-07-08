import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const getUser = (id) => (id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);

function taskWithMeta(task) {
  const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ?').get(task.stage_id);
  const project = task.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) : null;
  const commentCount = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(task.id).n;
  const tags = db.prepare('SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag').all(task.id).map((r) => r.tag);
  const cl = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_done), 0) AS done FROM task_checklist WHERE task_id = ?').get(task.id);
  const watcherIds = db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task.id).map((r) => r.user_id);
  const attachmentCount = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?').get(task.id).n;
  return {
    ...task,
    assignee: publicUser(getUser(task.assignee_id)),
    creator: publicUser(getUser(task.creator_id)),
    stage,
    project,
    comment_count: commentCount,
    tags,
    checklist_total: cl.total,
    checklist_done: cl.done,
    watcher_ids: watcherIds,
    attachment_count: attachmentCount,
  };
}

function logActivity(taskId, userId, action) {
  db.prepare('INSERT INTO task_activity (task_id, user_id, action) VALUES (?, ?, ?)').run(taskId, userId, action);
}

function addWatcher(taskId, userId) {
  if (userId) db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
}

// Notify everyone watching a task (except whoever triggered the change).
function notifyWatchers(req, task, text) {
  const io = req.app.get('io');
  if (!io) return;
  const watchers = db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(task.id);
  for (const { user_id } of watchers) {
    if (user_id !== req.user.id) {
      io.to(`user:${user_id}`).emit('task:notify', { task_id: task.id, title: task.title, text, by: publicUser(req.user) });
    }
  }
}

function emitChanged(req, taskId) {
  const task = taskWithMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  req.app.get('io')?.emit('task:changed', { task });
  return task;
}

function loadTask(req, res) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
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
  sql += ' WHERE ' + where.join(' AND ') + ' ORDER BY t.updated_at DESC';
  res.json({ tasks: db.prepare(sql).all(...params).map(taskWithMeta) });
});

router.post('/', (req, res) => {
  const { title, description = '', workflow_id, project_id = null, assignee_id = null,
    priority = 'medium', due_date = null, tags = [], checklist = [] } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow_id);
  if (!wf) return res.status(400).json({ error: 'Workflow not found' });
  if (assignee_id && !getUser(assignee_id)) return res.status(400).json({ error: 'Assignee not found' });
  if (project_id && !db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id)) {
    return res.status(400).json({ error: 'Project not found' });
  }
  const firstStage = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wf.id);
  const info = db.prepare(`
    INSERT INTO tasks (title, description, workflow_id, project_id, stage_id, assignee_id, creator_id, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), description, wf.id, project_id, firstStage.id, assignee_id, req.user.id, priority, due_date);
  const taskId = info.lastInsertRowid;

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
    req.app.get('io')?.to(`user:${assignee_id}`).emit('task:assigned', { task, by: publicUser(req.user) });
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
  res.json({ task: taskWithMeta(task), comments, activity, checklist, watchers, attachments });
});

router.patch('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  const { title, description, stage_id, assignee_id, priority, due_date, project_id } = req.body;

  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  if (stage_id !== undefined && stage_id !== task.stage_id) {
    const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ? AND workflow_id = ?').get(stage_id, task.workflow_id);
    if (!stage) return res.status(400).json({ error: 'Stage does not belong to this workflow' });
    logActivity(task.id, req.user.id, `moved it to "${stage.name}"`);
    notifyWatchers(req, task, `moved to "${stage.name}"`);
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

  db.prepare(`
    UPDATE tasks SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      stage_id = COALESCE(?, stage_id),
      assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END,
      priority = COALESCE(?, priority),
      due_date = CASE WHEN ? THEN ? ELSE due_date END,
      project_id = CASE WHEN ? THEN ? ELSE project_id END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title?.trim() || null, description ?? null, stage_id ?? null,
    assignee_id !== undefined ? 1 : 0, assignee_id ?? null,
    priority ?? null,
    due_date !== undefined ? 1 : 0, due_date ?? null,
    project_id !== undefined ? 1 : 0, project_id ?? null,
    task.id
  );

  const updated = emitChanged(req, task.id);
  if (assignee_id && assignee_id !== task.assignee_id && assignee_id !== req.user.id) {
    req.app.get('io')?.to(`user:${assignee_id}`).emit('task:assigned', { task: updated, by: publicUser(req.user) });
  }
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  req.app.get('io')?.emit('task:deleted', { task_id: task.id, workflow_id: task.workflow_id });
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
  notifyWatchers(req, task, 'commented');
  emitChanged(req, task.id);
  const comment = db.prepare(`
    SELECT tc.*, u.name AS user_name, u.avatar_color FROM task_comments tc
    JOIN users u ON u.id = tc.user_id WHERE tc.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json(comment);
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
