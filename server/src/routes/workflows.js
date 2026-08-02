import { Router } from 'express';
import db from '../db.js';

const router = Router();

function workflowWithStages(wf) {
  const stages = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position').all(wf.id);
  // How many (active) tasks sit in each stage — powers the distribution bars.
  const perStage = db.prepare('SELECT stage_id, COUNT(*) AS n FROM tasks WHERE workflow_id = ? AND archived_at IS NULL GROUP BY stage_id').all(wf.id);
  const counts = Object.fromEntries(perStage.map((r) => [r.stage_id, r.n]));
  const withCounts = stages.map((s) => ({ ...s, task_count: counts[s.id] || 0 }));
  const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(wf.id).n;
  return { ...wf, stages: withCounts, task_count: taskCount };
}

router.get('/', (req, res) => {
  const workflows = db.prepare('SELECT * FROM workflows WHERE workspace_id = ? ORDER BY id').all(req.workspaceId);
  res.json({ workflows: workflows.map(workflowWithStages) });
});

router.post('/', (req, res) => {
  const { name, description = '', stages = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Workflow name is required' });
  const stageNames = stages.map((s) => (typeof s === 'string' ? s : s?.name || '').trim()).filter(Boolean);
  if (stageNames.length < 2) return res.status(400).json({ error: 'A workflow needs at least 2 stages' });

  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO workflows (name, description, created_by, workspace_id) VALUES (?, ?, ?, ?)')
      .run(name.trim(), description, req.user.id, req.workspaceId);
    const insertStage = db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, ?)');
    stageNames.forEach((s, i) => insertStage.run(info.lastInsertRowid, s, i, i === stageNames.length - 1 ? 1 : 0));
    return db.prepare('SELECT * FROM workflows WHERE id = ?').get(info.lastInsertRowid);
  });
  res.status(201).json(workflowWithStages(create()));
});

router.patch('/:id', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const { name, description } = req.body;
  db.prepare('UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?')
    .run(name?.trim() || null, description ?? null, wf.id);
  res.json(workflowWithStages(db.prepare('SELECT * FROM workflows WHERE id = ?').get(wf.id)));
});

// Add a stage. Appends by default, or inserts at `position` (0-based index)
// when given, shifting later stages down — so a column can go in between.
router.post('/:id/stages', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const { name, position } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Stage name is required' });
  const stages = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position, id').all(wf.id);
  db.transaction(() => {
    let pos;
    if (Number.isInteger(position) && position >= 0 && position < stages.length) {
      pos = stages[position].position; // slot in at this index…
      db.prepare('UPDATE workflow_stages SET position = position + 1 WHERE workflow_id = ? AND position >= ?').run(wf.id, pos);
    } else {
      pos = (stages.length ? stages[stages.length - 1].position : -1) + 1; // …or append at the end
    }
    db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, 0)').run(wf.id, name.trim(), pos);
  })();
  res.status(201).json(workflowWithStages(wf));
});

// Rename a stage and/or set whether it's a "done" column (completes tasks).
router.patch('/:id/stages/:stageId', (req, res) => {
  if (!db.prepare('SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId)) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  const stage = db.prepare('SELECT * FROM workflow_stages WHERE id = ? AND workflow_id = ?').get(req.params.stageId, req.params.id);
  if (!stage) return res.status(404).json({ error: 'Stage not found' });
  const { name, is_done } = req.body;
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Stage name cannot be empty' });
  db.prepare('UPDATE workflow_stages SET name = COALESCE(?, name), is_done = COALESCE(?, is_done) WHERE id = ?')
    .run(name?.trim() || null, is_done === undefined ? null : (is_done ? 1 : 0), stage.id);
  res.json(workflowWithStages(db.prepare('SELECT * FROM workflows WHERE id = ?').get(stage.workflow_id)));
});

// Reorder a workflow's stages — body { order: [stageId, …] } lists every stage
// in its new left-to-right order.
router.patch('/:id/stages-order', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
  if (!order) return res.status(400).json({ error: 'Provide the new stage order.' });
  const ids = db.prepare('SELECT id FROM workflow_stages WHERE workflow_id = ?').all(wf.id).map((r) => r.id);
  const sameSet = order.length === ids.length && ids.every((id) => order.includes(id));
  if (!sameSet) return res.status(400).json({ error: 'The order must list exactly this workflow’s stages.' });
  db.transaction(() => {
    const upd = db.prepare('UPDATE workflow_stages SET position = ? WHERE id = ? AND workflow_id = ?');
    order.forEach((id, i) => upd.run(i, id, wf.id));
  })();
  res.json(workflowWithStages(db.prepare('SELECT * FROM workflows WHERE id = ?').get(wf.id)));
});

router.delete('/:id/stages/:stageId', (req, res) => {
  if (!db.prepare('SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId)) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
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
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ?').get(req.workspaceId).n;
  if (count <= 1) return res.status(400).json({ error: 'At least one workflow must remain' });
  const hasTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(wf.id).n;
  if (hasTasks) return res.status(400).json({ error: 'Delete or move its tasks before deleting this workflow' });
  db.prepare('DELETE FROM workflows WHERE id = ?').run(wf.id);
  res.json({ ok: true });
});

export default router;
