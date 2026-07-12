import { Router } from 'express';
import db from '../db.js';

const router = Router();
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function templateWithDetail(t) {
  const steps = db.prepare('SELECT id, text, position FROM task_template_steps WHERE template_id = ? ORDER BY position, id').all(t.id);
  const tags = db.prepare('SELECT tag FROM task_template_tags WHERE template_id = ? ORDER BY tag').all(t.id).map((r) => r.tag);
  const workflow = t.default_workflow_id ? db.prepare('SELECT id, name FROM workflows WHERE id = ?').get(t.default_workflow_id) : null;
  return { ...t, steps, tags, default_workflow: workflow };
}

// Replace just the steps, or just the tags — independently, so a partial
// update (e.g. steps only) never clobbers the other list.
function replaceSteps(templateId, steps) {
  db.prepare('DELETE FROM task_template_steps WHERE template_id = ?').run(templateId);
  const insStep = db.prepare('INSERT INTO task_template_steps (template_id, text, position) VALUES (?, ?, ?)');
  (Array.isArray(steps) ? steps : []).forEach((s, i) => {
    const text = String(typeof s === 'string' ? s : s?.text || '').trim();
    if (text) insStep.run(templateId, text, i);
  });
}

function replaceTags(templateId, tags) {
  db.prepare('DELETE FROM task_template_tags WHERE template_id = ?').run(templateId);
  const insTag = db.prepare('INSERT OR IGNORE INTO task_template_tags (template_id, tag) VALUES (?, ?)');
  for (const tag of Array.isArray(tags) ? tags : []) {
    const clean = String(tag).trim().toLowerCase();
    if (clean) insTag.run(templateId, clean);
  }
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM task_templates WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ templates: rows.map(templateWithDetail) });
});

router.get('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM task_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(templateWithDetail(t));
});

router.post('/', (req, res) => {
  const { name, description = '', default_priority = 'medium', default_workflow_id = null, steps = [], tags = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Template name is required' });
  if (!PRIORITIES.includes(default_priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (default_workflow_id && !db.prepare('SELECT id FROM workflows WHERE id = ? AND workspace_id = ?').get(default_workflow_id, req.workspaceId)) {
    return res.status(400).json({ error: 'Workflow not found' });
  }
  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO task_templates (name, description, default_priority, default_workflow_id, created_by, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), description, default_priority, default_workflow_id, req.user.id, req.workspaceId);
    replaceSteps(info.lastInsertRowid, steps);
    replaceTags(info.lastInsertRowid, tags);
    return info.lastInsertRowid;
  });
  const id = create();
  req.app.get('io')?.emit('templates:changed');
  res.status(201).json(templateWithDetail(db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id)));
});

router.patch('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM task_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const { name, description, default_priority, default_workflow_id, steps, tags } = req.body;
  if (default_priority !== undefined && !PRIORITIES.includes(default_priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE task_templates SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        default_priority = COALESCE(?, default_priority),
        default_workflow_id = CASE WHEN ? THEN ? ELSE default_workflow_id END
      WHERE id = ?
    `).run(
      name?.trim() || null, description ?? null, default_priority ?? null,
      default_workflow_id !== undefined ? 1 : 0, default_workflow_id ?? null,
      t.id
    );
    if (steps !== undefined) replaceSteps(t.id, steps);
    if (tags !== undefined) replaceTags(t.id, tags);
  });
  update();
  req.app.get('io')?.emit('templates:changed');
  res.json(templateWithDetail(db.prepare('SELECT * FROM task_templates WHERE id = ?').get(t.id)));
});

router.delete('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM task_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  db.prepare('DELETE FROM task_templates WHERE id = ?').run(t.id);
  req.app.get('io')?.emit('templates:changed');
  res.json({ ok: true });
});

export default router;
