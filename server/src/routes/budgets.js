// Budgeting console API (authenticated, workspace-scoped). Staff create a budget
// per client, enter the budgeted and actual amounts per line per month, and read
// the Actual-vs-Budget report. The same report is served read-only to the client
// through the portal (see routes/portal.js).
import { Router } from 'express';
import db from '../db.js';
import { budgetReport, createBudget, seedDemoManufacturing, monthList } from '../budgets.js';

const router = Router();
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
const KINDS = ['expense', 'capex', 'revenue'];

// A budget the caller's workspace owns, or null (after answering) if not found.
function ownBudget(req, res) {
  const b = db.prepare('SELECT * FROM budgets WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!b) { res.status(404).json({ error: 'Budget not found' }); return null; }
  return b;
}
// A line that belongs to a budget in the caller's workspace.
function ownLine(req, res, lineId) {
  const l = db.prepare(`SELECT l.* FROM budget_lines l JOIN budgets b ON b.id = l.budget_id
    WHERE l.id = ? AND b.workspace_id = ?`).get(lineId, req.workspaceId);
  if (!l) { res.status(404).json({ error: 'Line not found' }); return null; }
  return l;
}

// List budgets (optionally for one client).
router.get('/', (req, res) => {
  const clientId = req.query.client_id ? Number(req.query.client_id) : null;
  const rows = clientId
    ? db.prepare('SELECT * FROM budgets WHERE workspace_id = ? AND client_id = ? ORDER BY id DESC').all(req.workspaceId, clientId)
    : db.prepare('SELECT * FROM budgets WHERE workspace_id = ? ORDER BY id DESC').all(req.workspaceId);
  const budgets = rows.map((b) => ({
    ...b,
    client: b.client_id ? db.prepare('SELECT id, name FROM clients WHERE id = ?').get(b.client_id) : null,
    line_count: db.prepare('SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?').get(b.id).n,
  }));
  res.json({ budgets });
});

// Create a budget; `demo: true` fills it with the manufacturing demo dataset.
router.post('/', (req, res) => {
  const { name, client_id = null, fy_start, months = 12, currency = 'INR', demo = false } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'A budget name is required' });
  if (!/^\d{4}-\d{2}$/.test(String(fy_start || ''))) return res.status(400).json({ error: 'Start month must be YYYY-MM' });
  if (client_id && !db.prepare('SELECT 1 FROM clients WHERE id = ? AND workspace_id = ?').get(client_id, req.workspaceId)) {
    return res.status(400).json({ error: 'Unknown client' });
  }
  const id = createBudget(req.workspaceId, {
    client_id, name: String(name).trim().slice(0, 120), fy_start,
    months: Number(months) || 12, currency: String(currency || 'INR').slice(0, 8),
    created_by: req.user.id, demo: !!demo,
  });
  res.status(201).json(budgetReport(id));
});

// Full Actual-vs-Budget report.
router.get('/:id', (req, res) => {
  if (!ownBudget(req, res)) return;
  res.json(budgetReport(req.params.id));
});

// Rename / re-note / re-date a budget.
router.patch('/:id', (req, res) => {
  const b = ownBudget(req, res); if (!b) return;
  const body = req.body || {}; const sets = []; const vals = [];
  if (body.name !== undefined) { if (!String(body.name).trim()) return res.status(400).json({ error: 'A name is required' }); sets.push('name = ?'); vals.push(String(body.name).trim().slice(0, 120)); }
  if (body.notes !== undefined) { sets.push('notes = ?'); vals.push(String(body.notes).slice(0, 4000)); }
  if (body.fy_start !== undefined) { if (!/^\d{4}-\d{2}$/.test(String(body.fy_start))) return res.status(400).json({ error: 'Start month must be YYYY-MM' }); sets.push('fy_start = ?'); vals.push(body.fy_start); }
  if (body.months !== undefined) { sets.push('months = ?'); vals.push(Math.max(1, Math.min(36, Number(body.months) || 12))); }
  if (body.currency !== undefined) { sets.push('currency = ?'); vals.push(String(body.currency).slice(0, 8)); }
  if (sets.length) db.prepare(`UPDATE budgets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, b.id);
  res.json(budgetReport(b.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const b = ownBudget(req, res); if (!b) return;
  db.prepare('DELETE FROM budgets WHERE id = ?').run(b.id);
  res.json({ ok: true });
});

// Replace all lines/cells with the demo manufacturing dataset.
router.post('/:id/seed-demo', (req, res) => {
  const b = ownBudget(req, res); if (!b) return;
  seedDemoManufacturing(b.id, { elapsed: Math.max(0, Math.min(b.months, Number(req.body?.elapsed) || 6)) });
  res.json(budgetReport(b.id));
});

// Add a line (category). Seeds an empty cell for every month.
router.post('/:id/lines', (req, res) => {
  const b = ownBudget(req, res); if (!b) return;
  const { category, section = 'Operating', kind = 'expense' } = req.body || {};
  if (!String(category || '').trim()) return res.status(400).json({ error: 'A category name is required' });
  const sort = (db.prepare('SELECT MAX(sort) AS m FROM budget_lines WHERE budget_id = ?').get(b.id).m ?? -1) + 1;
  const lineId = db.prepare('INSERT INTO budget_lines (budget_id, section, category, kind, sort) VALUES (?, ?, ?, ?, ?)')
    .run(b.id, String(section).trim().slice(0, 80) || 'Operating', String(category).trim().slice(0, 120), KINDS.includes(kind) ? kind : 'expense', sort).lastInsertRowid;
  const insCell = db.prepare('INSERT OR IGNORE INTO budget_cells (line_id, month, budget, actual) VALUES (?, ?, 0, 0)');
  for (const m of monthList(b.fy_start, b.months)) insCell.run(lineId, m);
  res.status(201).json(budgetReport(b.id));
});

router.patch('/lines/:lineId', (req, res) => {
  const l = ownLine(req, res, req.params.lineId); if (!l) return;
  const body = req.body || {}; const sets = []; const vals = [];
  if (body.category !== undefined) { if (!String(body.category).trim()) return res.status(400).json({ error: 'A category name is required' }); sets.push('category = ?'); vals.push(String(body.category).trim().slice(0, 120)); }
  if (body.section !== undefined) { sets.push('section = ?'); vals.push(String(body.section).trim().slice(0, 80) || 'Operating'); }
  if (body.kind !== undefined) { sets.push('kind = ?'); vals.push(KINDS.includes(body.kind) ? body.kind : 'expense'); }
  if (sets.length) db.prepare(`UPDATE budget_lines SET ${sets.join(', ')} WHERE id = ?`).run(...vals, l.id);
  res.json(budgetReport(l.budget_id));
});

router.delete('/lines/:lineId', (req, res) => {
  const l = ownLine(req, res, req.params.lineId); if (!l) return;
  db.prepare('DELETE FROM budget_lines WHERE id = ?').run(l.id);
  res.json(budgetReport(l.budget_id));
});

// Upsert one cell's budget and/or actual amount.
router.put('/:id/cell', (req, res) => {
  const b = ownBudget(req, res); if (!b) return;
  const { line_id, month } = req.body || {};
  const l = line_id && db.prepare('SELECT * FROM budget_lines WHERE id = ? AND budget_id = ?').get(line_id, b.id);
  if (!l) return res.status(400).json({ error: 'Unknown line' });
  if (!monthList(b.fy_start, b.months).includes(String(month))) return res.status(400).json({ error: 'Month is outside this budget' });
  const num = (v) => (v === undefined || v === null || v === '' ? null : Math.max(0, Math.round(Number(v) * 100) / 100));
  const bud = num(req.body.budget); const act = num(req.body.actual);
  const existing = db.prepare('SELECT * FROM budget_cells WHERE line_id = ? AND month = ?').get(l.id, month);
  if (existing) {
    db.prepare('UPDATE budget_cells SET budget = COALESCE(?, budget), actual = COALESCE(?, actual) WHERE id = ?')
      .run(bud, act, existing.id);
  } else {
    db.prepare('INSERT INTO budget_cells (line_id, month, budget, actual) VALUES (?, ?, ?, ?)')
      .run(l.id, month, bud || 0, act || 0);
  }
  res.json(budgetReport(b.id));
});

export default router;
