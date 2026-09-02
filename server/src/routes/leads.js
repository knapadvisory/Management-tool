// Lead management console API (authenticated, workspace-scoped). Public intake
// lives in index.js; this is the board, editing, and admin settings.
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { intakeLead, runStageAutomations } from '../leads.js';
import { ensureStages, listStages, stageKeys, makeStageKey } from '../leadStages.js';

const router = Router();
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
// Admins and Sales see and manage every lead; everyone else only their own.
const canManageAll = (req) => req.user.role === 'admin' || req.user.role === 'sales';
// Tell every open board in the workspace the columns changed.
const emitStages = (req) => req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('leads:stages');
// Load a lead the caller is allowed to touch, or send the right error. Returns
// the lead on success, or null after having already answered the response.
function accessibleLead(req, res) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!lead) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!canManageAll(req) && lead.owner_id !== req.user.id) { res.status(403).json({ error: 'Not your lead' }); return null; }
  return lead;
}

router.get('/', (req, res) => {
  const all = canManageAll(req);
  const leads = db.prepare(`
    SELECT l.*, u.name AS owner_name, u.avatar_color AS owner_avatar_color,
      (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = l.id) AS note_count,
      (SELECT MIN(remind_at) FROM lead_reminders r WHERE r.lead_id = l.id AND r.sent = 0) AS next_reminder
    FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.workspace_id = ? ${all ? '' : 'AND l.owner_id = ?'} ORDER BY l.created_at DESC
  `).all(...(all ? [req.workspaceId] : [req.workspaceId, req.user.id]));
  res.json({ leads });
});

// Pipeline analytics for managers (admin / sales), over every lead.
router.get('/analytics', (req, res) => {
  if (!canManageAll(req)) return res.status(403).json({ error: 'Managers only' });
  const ws = req.workspaceId;
  ensureStages(ws);

  const byStage = db.prepare(`
    SELECT s.label, s.outcome, s.position, COUNT(l.id) AS count
    FROM lead_stages s
    LEFT JOIN leads l ON l.status = s.key AND l.workspace_id = s.workspace_id
    WHERE s.workspace_id = ? GROUP BY s.id ORDER BY s.position, s.id
  `).all(ws);

  const total = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?').get(ws).n;
  const won = byStage.filter((s) => s.outcome === 'won').reduce((a, s) => a + s.count, 0);
  const lost = byStage.filter((s) => s.outcome === 'lost').reduce((a, s) => a + s.count, 0);
  const open = total - won - lost;
  const conversion = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;

  const bySource = db.prepare('SELECT source, COUNT(*) AS count FROM leads WHERE workspace_id = ? GROUP BY source ORDER BY count DESC').all(ws);
  const newThisWeek = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= datetime('now', '-7 days')").get(ws).n;
  const newThisMonth = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= datetime('now', '-30 days')").get(ws).n;

  const avgRow = db.prepare(`
    SELECT AVG(julianday(l.closed_at) - julianday(l.created_at)) AS d
    FROM leads l JOIN lead_stages s ON s.key = l.status AND s.workspace_id = l.workspace_id
    WHERE l.workspace_id = ? AND s.outcome = 'won' AND l.closed_at IS NOT NULL
  `).get(ws);
  const avgDaysToWin = avgRow.d != null ? Math.round(avgRow.d * 10) / 10 : null;

  const topOwners = db.prepare(`
    SELECT u.name, u.avatar_color, COUNT(*) AS won
    FROM leads l JOIN lead_stages s ON s.key = l.status AND s.workspace_id = l.workspace_id
    JOIN users u ON u.id = l.owner_id
    WHERE l.workspace_id = ? AND s.outcome = 'won'
    GROUP BY l.owner_id ORDER BY won DESC LIMIT 5
  `).all(ws);

  res.json({ total, won, lost, open, conversion, avgDaysToWin, newThisWeek, newThisMonth, byStage, bySource, topOwners });
});

// Add a lead by hand (runs the same automations as website intake). A member
// who is not manage-all can only file leads onto their own board.
router.post('/', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ownerId = canManageAll(req) ? (req.body?.owner_id || null) : req.user.id;
  // Where the lead came from, e.g. referral / walk-in / phone. Kept short and
  // normalised so it groups cleanly in analytics; falls back to 'manual'.
  const source = String(req.body?.source || '').trim().toLowerCase().slice(0, 30) || 'manual';
  const { lead } = intakeLead(req.app.get('io'), ws, {
    name: String(req.body?.name || ''), email: String(req.body?.email || ''),
    phone: String(req.body?.phone || ''), message: String(req.body?.message || ''),
    source, owner_id: ownerId,
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

// Rename a column and/or set its automations (auto_task, auto_reminder_days).
router.patch('/stages/:id', requireAdmin, (req, res) => {
  const stage = db.prepare('SELECT * FROM lead_stages WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.label !== undefined) {
    const label = String(b.label).trim();
    if (!label) return res.status(400).json({ error: 'A name is required' });
    sets.push('label = ?'); vals.push(label);
  }
  if (b.auto_task !== undefined) { sets.push('auto_task = ?'); vals.push(b.auto_task ? 1 : 0); }
  if (b.auto_reminder_days !== undefined) {
    const d = b.auto_reminder_days === null || b.auto_reminder_days === '' ? null : Math.max(0, Math.min(365, parseInt(b.auto_reminder_days, 10) || 0));
    sets.push('auto_reminder_days = ?'); vals.push(d);
  }
  if (b.outcome !== undefined) {
    const o = ['open', 'won', 'lost'].includes(b.outcome) ? b.outcome : 'open';
    sets.push('outcome = ?'); vals.push(o);
  }
  if (sets.length) db.prepare(`UPDATE lead_stages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, stage.id);
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
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);

  // Entering a new stage fires that stage's automations and stamps closed_at
  // when the stage is a won/lost outcome (cleared when moved back to open).
  if (b.status !== undefined && b.status !== lead.status) {
    const stage = db.prepare('SELECT * FROM lead_stages WHERE workspace_id = ? AND key = ?').get(req.workspaceId, b.status);
    if (stage && stage.outcome !== 'open') {
      if (!lead.closed_at) db.prepare("UPDATE leads SET closed_at = datetime('now') WHERE id = ?").run(lead.id);
    } else {
      db.prepare('UPDATE leads SET closed_at = NULL WHERE id = ?').run(lead.id);
    }
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
    runStageAutomations(req.app.get('io'), ws, updated, stage, req.user.id);
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

// --- Notes / remarks ---
router.get('/:id/notes', (req, res) => {
  if (!accessibleLead(req, res)) return;
  const notes = db.prepare(`
    SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name, u.avatar_color AS author_color
    FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.lead_id = ? ORDER BY n.id DESC
  `).all(req.params.id);
  res.json({ notes });
});

router.post('/:id/notes', (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const body = String(req.body?.body || '').trim().slice(0, 5000);
  if (!body) return res.status(400).json({ error: 'A note is required' });
  const info = db.prepare('INSERT INTO lead_notes (workspace_id, lead_id, user_id, body) VALUES (?, ?, ?, ?)')
    .run(req.workspaceId, lead.id, req.user.id, body);
  db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(lead.id);
  const note = db.prepare(`
    SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name, u.avatar_color AS author_color
    FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?
  `).get(info.lastInsertRowid);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('leads:changed');
  res.status(201).json({ note });
});

router.delete('/:id/notes/:noteId', (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const note = db.prepare('SELECT * FROM lead_notes WHERE id = ? AND lead_id = ?').get(req.params.noteId, lead.id);
  if (!note) return res.json({ ok: true });
  if (note.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the author or an admin can delete this note' });
  db.prepare('DELETE FROM lead_notes WHERE id = ?').run(note.id);
  res.json({ ok: true });
});

// --- Tasks raised from this lead ---
router.get('/:id/tasks', (req, res) => {
  if (!accessibleLead(req, res)) return;
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.priority, t.due_date, s.name AS stage_name, s.is_done,
           u.name AS assignee_name, u.avatar_color AS assignee_color
    FROM tasks t
    LEFT JOIN workflow_stages s ON s.id = t.stage_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.lead_id = ? ORDER BY t.id DESC
  `).all(req.params.id);
  res.json({ tasks });
});

// --- Follow-up reminders ---
router.get('/:id/reminders', (req, res) => {
  if (!accessibleLead(req, res)) return;
  const reminders = db.prepare('SELECT id, remind_at, note, sent, user_id FROM lead_reminders WHERE lead_id = ? ORDER BY remind_at').all(req.params.id);
  res.json({ reminders });
});

router.post('/:id/reminders', (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  // Store as UTC "YYYY-MM-DD HH:MM:SS" so it compares against datetime('now').
  const d = new Date(req.body?.remind_at);
  if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'A valid reminder time is required' });
  const at = d.toISOString().slice(0, 19).replace('T', ' ');
  const note = String(req.body?.note || '').trim().slice(0, 500);
  db.prepare('INSERT INTO lead_reminders (workspace_id, lead_id, user_id, remind_at, note) VALUES (?, ?, ?, ?, ?)')
    .run(req.workspaceId, lead.id, req.user.id, at, note);
  res.status(201).json({ reminders: db.prepare('SELECT id, remind_at, note, sent, user_id FROM lead_reminders WHERE lead_id = ? ORDER BY remind_at').all(lead.id) });
});

router.delete('/:id/reminders/:reminderId', (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  db.prepare('DELETE FROM lead_reminders WHERE id = ? AND lead_id = ?').run(req.params.reminderId, lead.id);
  res.json({ reminders: db.prepare('SELECT id, remind_at, note, sent, user_id FROM lead_reminders WHERE lead_id = ? ORDER BY remind_at').all(lead.id) });
});

export default router;
