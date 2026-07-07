import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function taskWithMeta(task) {
  const assignee = task.assignee_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(task.assignee_id) : null;
  const creator = db.prepare('SELECT * FROM users WHERE id = ?').get(task.creator_id);
  const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ?').get(task.stage_id);
  const commentCount = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(task.id).n;
  return { ...task, assignee: publicUser(assignee), creator: publicUser(creator), stage, comment_count: commentCount };
}

function logActivity(taskId, userId, action) {
  db.prepare('INSERT INTO task_activity (task_id, user_id, action) VALUES (?, ?, ?)').run(taskId, userId, action);
}

router.get('/', (req, res) => {
  const { workflow_id, assignee_id } = req.query;
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  if (workflow_id) { sql += ' AND workflow_id = ?'; params.push(workflow_id); }
  if (assignee_id) { sql += ' AND assignee_id = ?'; params.push(assignee_id); }
  sql += ' ORDER BY updated_at DESC';
  res.json({ tasks: db.prepare(sql).all(...params).map(taskWithMeta) });
});

router.post('/', (req, res) => {
  const { title, description = '', workflow_id, assignee_id = null, priority = 'medium', due_date = null } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow_id);
  if (!wf) return res.status(400).json({ error: 'Workflow not found' });
  if (assignee_id && !db.prepare('SELECT id FROM users WHERE id = ?').get(assignee_id)) {
    return res.status(400).json({ error: 'Assignee not found' });
  }
  const firstStage = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wf.id);
  const info = db.prepare(`
    INSERT INTO tasks (title, description, workflow_id, stage_id, assignee_id, creator_id, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), description, wf.id, firstStage.id, assignee_id, req.user.id, priority, due_date);
  logActivity(info.lastInsertRowid, req.user.id, 'created this task');
  if (assignee_id) {
    const assignee = db.prepare('SELECT name FROM users WHERE id = ?').get(assignee_id);
    logActivity(info.lastInsertRowid, req.user.id, `assigned it to ${assignee.name}`);
  }
  const task = taskWithMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
  req.app.get('io')?.emit('task:changed', { task });
  if (assignee_id && assignee_id !== req.user.id) {
    req.app.get('io')?.to(`user:${assignee_id}`).emit('task:assigned', { task, by: publicUser(req.user) });
  }
  res.status(201).json(task);
});

router.get('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const comments = db.prepare(`
    SELECT tc.*, u.name AS user_name, u.avatar_color FROM task_comments tc
    JOIN users u ON u.id = tc.user_id WHERE tc.task_id = ? ORDER BY tc.id
  `).all(task.id);
  const activity = db.prepare(`
    SELECT ta.*, u.name AS user_name FROM task_activity ta
    JOIN users u ON u.id = ta.user_id WHERE ta.task_id = ? ORDER BY ta.id
  `).all(task.id);
  res.json({ task: taskWithMeta(task), comments, activity });
});

router.patch('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { title, description, stage_id, assignee_id, priority, due_date } = req.body;

  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  if (stage_id !== undefined && stage_id !== task.stage_id) {
    const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ? AND workflow_id = ?').get(stage_id, task.workflow_id);
    if (!stage) return res.status(400).json({ error: 'Stage does not belong to this workflow' });
    logActivity(task.id, req.user.id, `moved it to "${stage.name}"`);
  }
  if (assignee_id !== undefined && assignee_id !== task.assignee_id) {
    if (assignee_id !== null && !db.prepare('SELECT id FROM users WHERE id = ?').get(assignee_id)) {
      return res.status(400).json({ error: 'Assignee not found' });
    }
    const name = assignee_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(assignee_id).name : null;
    logActivity(task.id, req.user.id, name ? `assigned it to ${name}` : 'removed the assignee');
  }

  db.prepare(`
    UPDATE tasks SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      stage_id = COALESCE(?, stage_id),
      assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END,
      priority = COALESCE(?, priority),
      due_date = CASE WHEN ? THEN ? ELSE due_date END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title?.trim() || null, description ?? null, stage_id ?? null,
    assignee_id !== undefined ? 1 : 0, assignee_id ?? null,
    priority ?? null,
    due_date !== undefined ? 1 : 0, due_date ?? null,
    task.id
  );

  const updated = taskWithMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
  req.app.get('io')?.emit('task:changed', { task: updated });
  if (assignee_id && assignee_id !== task.assignee_id && assignee_id !== req.user.id) {
    req.app.get('io')?.to(`user:${assignee_id}`).emit('task:assigned', { task: updated, by: publicUser(req.user) });
  }
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  req.app.get('io')?.emit('task:deleted', { task_id: task.id, workflow_id: task.workflow_id });
  res.json({ ok: true });
});

router.post('/:id/comments', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const info = db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)')
    .run(task.id, req.user.id, content.trim());
  const comment = db.prepare(`
    SELECT tc.*, u.name AS user_name, u.avatar_color FROM task_comments tc
    JOIN users u ON u.id = tc.user_id WHERE tc.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json(comment);
});

export default router;
