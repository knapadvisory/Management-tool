// Lead management console API (authenticated, workspace-scoped). Public intake
// lives in index.js; this is the board, editing, and admin settings.
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { intakeLead } from '../leads.js';

const router = Router();
const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

router.get('/', (req, res) => {
  const leads = db.prepare(`
    SELECT l.*, u.name AS owner_name, u.avatar_color AS owner_avatar_color
    FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.workspace_id = ? ORDER BY l.created_at DESC
  `).all(req.workspaceId);
  res.json({ leads });
});

// Add a lead by hand (runs the same automations as website intake).
router.post('/', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const { lead } = intakeLead(req.app.get('io'), ws, {
    name: String(req.body?.name || ''), email: String(req.body?.email || ''),
    phone: String(req.body?.phone || ''), message: String(req.body?.message || ''),
    source: 'manual', owner_id: req.body?.owner_id || null,
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

// --- Single lead ---
router.patch('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
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
  db.prepare('DELETE FROM leads WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  res.json({ ok: true });
});

export default router;
