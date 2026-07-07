import { Router } from 'express';
import db from '../db.js';

const router = Router();

function workflowWithStages(wf) {
  const stages = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position').all(wf.id);
  const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(wf.id).n;
  return { ...wf, stages, task_count: taskCount };
}

router.get('/', (req, res) => {
  const workflows = db.prepare('SELECT * FROM workflows ORDER BY id').all();
  res.json({ workflows: workflows.map(workflowWithStages) });
});

router.post('/', (req, res) => {
  const { name, description = '', stages = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Workflow name is required' });
  const stageNames = stages.map((s) => (typeof s === 'string' ? s : s?.name || '').trim()).filter(Boolean);
  if (stageNames.length < 2) return res.status(400).json({ error: 'A workflow needs at least 2 stages' });

  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO workflows (name, description, created_by) VALUES (?, ?, ?)')
      .run(name.trim(), description, req.user.id);
    const insertStage = db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, ?)');
    stageNames.forEach((s, i) => insertStage.run(info.lastInsertRowid, s, i, i === stageNames.length - 1 ? 1 : 0));
    return db.prepare('SELECT * FROM workflows WHERE id = ?').get(info.lastInsertRowid);
  });
  res.status(201).json(workflowWithStages(create()));
});

router.patch('/:id', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const { name, description } = req.body;
  db.prepare('UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?')
    .run(name?.trim() || null, description ?? null, wf.id);
  res.json(workflowWithStages(db.prepare('SELECT * FROM workflows WHERE id = ?').get(wf.id)));
});

// Add a stage before the terminal "done" stage by default.
router.post('/:id/stages', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Stage name is required' });
  const max = db.prepare('SELECT MAX(position) AS p FROM workflow_stages WHERE workflow_id = ?').get(wf.id).p ?? -1;
  db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, 0)')
    .run(wf.id, name.trim(), max + 1);
  res.status(201).json(workflowWithStages(wf));
});

router.delete('/:id/stages/:stageId', (req, res) => {
  const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ? AND workflow_id = ?')
    .get(req.params.stageId, req.params.id);
  if (!stage) return res.status(404).json({ error: 'Stage not found' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM workflow_stages WHERE workflow_id = ?').get(stage.workflow_id).n;
  if (count <= 2) return res.status(400).json({ error: 'A workflow needs at least 2 stages' });
  const hasTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE stage_id = ?').get(stage.id).n;
  if (hasTasks) return res.status(400).json({ error: 'Move tasks out of this stage before deleting it' });
  db.prepare('DELETE FROM workflow_stages WHERE id = ?').run(stage.id);
  res.json(workflowWithStages(db.prepare('SELECT * FROM workflows WHERE id = ?').get(stage.workflow_id)));
});

router.delete('/:id', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  if (count <= 1) return res.status(400).json({ error: 'At least one workflow must remain' });
  const hasTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(wf.id).n;
  if (hasTasks) return res.status(400).json({ error: 'Delete or move its tasks before deleting this workflow' });
  db.prepare('DELETE FROM workflows WHERE id = ?').run(wf.id);
  res.json({ ok: true });
});

export default router;
