// Lead management console API (authenticated, workspace-scoped). Public intake
// lives in index.js; this is the board, editing, and admin settings.
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { intakeLead } from '../leads.js';
import { ensureStages, listStages, stageKeys, makeStageKey } from '../leadStages.js';

const router = Router();
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
// Admins and Sales see and manage every lead; everyone else only their own.
const canManageAll = (req) => req.user.role === 'admin' || req.user.role === 'sales';
// Tell every open board in the workspace the columns changed.
const emitStages = (req) => req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('leads:stages');

router.get('/', (req, res) => {
  const all = canManageAll(req);
  const leads = db.prepare(`
    SELECT l.*, u.name AS owner_name, u.avatar_color AS owner_avatar_color
    FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.workspace_id = ? ${all ? '' : 'AND l.owner_id = ?'} ORDER BY l.created_at DESC
  `).all(...(all ? [req.workspaceId] : [req.workspaceId, req.user.id]));
  res.json({ leads });
});

// Add a lead by hand (runs the same automations as website intake). A member
// who is not manage-all can only file leads onto their own board.
router.post('/', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ownerId = canManageAll(req) ? (req.body?.owner_id || null) : req.user.id;
  const { lead } = intakeLead(req.app.get('io'), ws, {
    name: String(req.body?.name || ''), email: String(req.body?.email || ''),
    phone: String(req.body?.phone || ''), message: String(req.body?.message || ''),
    source: 'manual', owner_id: ownerId,
  });
  res.json({ lead });
});

// --- Admin settings (webhook key + auto-task workflow). Declared before /:id. ---
router.get('/settings', requireAdmin, (req, res) => {
  let ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  if (!ws.leads_intake_key) {
    db.prepare('UPDATE workspaces SET leads_intake_key = ? WHERE id = ?').run(crypto.randomBytes(24).toString('base64url'), ws.id);
    ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id);
  }
  res.json({
    key: ws.leads_intake_key,
    intake_path: '/api/leads/intake',
    task_workflow_id: ws.leads_task_workflow_id || null,
    workflows: db.prepare('SELECT id, name FROM workflows WHERE workspace_id = ? ORDER BY id').all(req.workspaceId),
  });
});

router.post('/settings/key', requireAdmin, (req, res) => {
  const key = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE workspaces SET leads_intake_key = ? WHERE id = ?').run(key, req.workspaceId);
  res.json({ key });
});

router.patch('/settings', requireAdmin, (req, res) => {
  const wfId = req.body?.task_workflow_id || null;
  if (wfId && !db.prepare('SELECT id FROM workflows WHERE id = ? AND workspace_id = ?').get(wfId, req.workspaceId)) {
    return res.status(400).json({ error: 'Unknown workflow' });
  }
  db.prepare('UPDATE workspaces SET leads_task_workflow_id = ? WHERE id = ?').run(wfId, req.workspaceId);
  res.json({ ok: true });
});

// --- Pipeline stages (columns). Read for anyone on the board; edit is admin. ---
router.get('/stages', (req, res) => {
  res.json({ stages: ensureStages(req.workspaceId) });
});

// Add a column at the end of the pipeline.
router.post('/stages', requireAdmin, (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'A name is required' });
  ensureStages(req.workspaceId);
  const pos = (db.prepare('SELECT MAX(position) AS m FROM lead_stages WHERE workspace_id = ?').get(req.workspaceId).m ?? -1) + 1;
  db.prepare('INSERT INTO lead_stages (workspace_id, key, label, position) VALUES (?, ?, ?, ?)')
    .run(req.workspaceId, makeStageKey(req.workspaceId, label), label, pos);
  emitStages(req);
  res.status(201).json({ stages: listStages(req.workspaceId) });
});

// Reorder the whole pipeline. Body: { order: [stageId, …] }. Declared before /:id.
router.patch('/stages/reorder', requireAdmin, (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : [];
  const owned = new Set(listStages(req.workspaceId).map((s) => s.id));
  const upd = db.prepare('UPDATE lead_stages SET position = ? WHERE id = ? AND workspace_id = ?');
  const tx = db.transaction(() => { order.forEach((id, i) => { if (owned.has(Number(id))) upd.run(i, Number(id), req.workspaceId); }); });
  tx();
  emitStages(req);
  res.json({ stages: listStages(req.workspaceId) });
});

// Rename a column.
router.patch('/stages/:id', requireAdmin, (req, res) => {
  const stage = db.prepare('SELECT * FROM lead_stages WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'A name is required' });
  db.prepare('UPDATE lead_stages SET label = ? WHERE id = ?').run(label, stage.id);
  emitStages(req);
  res.json({ stages: listStages(req.workspaceId) });
});

// Delete a column; its leads move to another stage (given, or the first one).
router.delete('/stages/:id', requireAdmin, (req, res) => {
  const stages = listStages(req.workspaceId);
  if (stages.length <= 1) return res.status(400).json({ error: 'Keep at least one stage' });
  const stage = stages.find((s) => s.id === Number(req.params.id));
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const fallback = stages.find((s) => s.id === Number(req.body?.move_to)) || stages.find((s) => s.id !== stage.id);
  db.prepare('UPDATE leads SET status = ? WHERE workspace_id = ? AND status = ?').run(fallback.key, req.workspaceId, stage.key);
  db.prepare('DELETE FROM lead_stages WHERE id = ?').run(stage.id);
  emitStages(req);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('leads:changed');
  res.json({ stages: listStages(req.workspaceId) });
});

// --- Single lead ---
router.patch('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if (!canManageAll(req) && lead.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your lead' });
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.status !== undefined) {
    if (!stageKeys(req.workspaceId).includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
    sets.push('status = ?'); vals.push(b.status);
  }
  if (b.owner_id !== undefined) { sets.push('owner_id = ?'); vals.push(b.owner_id || null); }
  for (const f of ['name', 'email', 'phone', 'message']) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(String(b[f]).slice(0, 4000)); }
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, lead.id);
  }
  res.json({ lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id) });
});

router.delete('/:id', (req, res) => {
  const lead = db.prepare('SELECT owner_id FROM leads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!lead) return res.json({ ok: true });
  if (!canManageAll(req) && lead.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your lead' });
  db.prepare('DELETE FROM leads WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  res.json({ ok: true });
});

export default router;
