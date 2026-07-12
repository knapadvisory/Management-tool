import { Router } from 'express';
import db from '../db.js';

const router = Router();
const COLORS = ['#4f46e5', '#e01e5a', '#2eb67d', '#ecb22e', '#0ea5e9', '#f97316', '#7c3aed', '#db2777'];

function projectWithMeta(p) {
  const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(p.id).n;
  const openCount = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks t JOIN workflow_stages s ON s.id = t.stage_id
    WHERE t.project_id = ? AND s.is_done = 0
  `).get(p.id).n;
  return { ...p, task_count: taskCount, open_count: openCount };
}

router.get('/', (req, res) => {
  res.json({ projects: db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY name').all(req.workspaceId).map(projectWithMeta) });
});

router.post('/', (req, res) => {
  const { name, description = '', color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  const chosen = COLORS.includes(color) ? color : COLORS[Math.floor(Math.random() * COLORS.length)];
  const info = db.prepare('INSERT INTO projects (name, description, color, created_by, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), description, chosen, req.user.id, req.workspaceId);
  const project = projectWithMeta(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
  req.app.get('io')?.emit('projects:changed');
  res.status(201).json(project);
});

router.patch('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { name, description, color } = req.body;
  db.prepare('UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color) WHERE id = ?')
    .run(name?.trim() || null, description ?? null, COLORS.includes(color) ? color : null, project.id);
  req.app.get('io')?.emit('projects:changed');
  res.json(projectWithMeta(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id)));
});

router.delete('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // Tasks keep existing; they just lose their project association.
  db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  req.app.get('io')?.emit('projects:changed');
  res.json({ ok: true });
});

export default router;
