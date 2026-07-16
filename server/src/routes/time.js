import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();

// Minutes elapsed for a running entry (started_at is a UTC 'YYYY-MM-DD HH:MM:SS').
const runningMinutes = (startedAt) => {
  if (!startedAt) return 0;
  const start = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.floor((Date.now() - start) / 60000));
};

// Shape an entry for the client, resolving live minutes for a running timer.
function entryWithMeta(e) {
  const task = e.task_id ? db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(e.task_id) : null;
  const client = e.client_id ? db.prepare('SELECT id, name FROM clients WHERE id = ?').get(e.client_id) : null;
  const minutes = e.is_running ? runningMinutes(e.started_at) : e.minutes;
  return {
    id: e.id, user_id: e.user_id, description: e.description || '',
    entry_date: e.entry_date, minutes, billable: !!e.billable,
    is_running: !!e.is_running, started_at: e.started_at, ended_at: e.ended_at,
    task, client, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(e.user_id)),
  };
}

// The client a task belongs to (so time logged on a task rolls up to its client).
const clientOfTask = (taskId, ws) => {
  if (!taskId) return null;
  const t = db.prepare('SELECT client_id FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, ws);
  return t?.client_id || null;
};
const wsTask = (taskId, ws) => taskId && db.prepare('SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, ws);
const wsClient = (clientId, ws) => clientId && db.prepare('SELECT 1 FROM clients WHERE id = ? AND workspace_id = ?').get(clientId, ws);
// The client for an entry: an explicit client, else the task's client.
const resolveClient = (body, taskId, ws) => {
  if (body.client_id && wsClient(body.client_id, ws)) return Number(body.client_id);
  return clientOfTask(taskId, ws);
};
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);

// The caller's currently-running timer, if any.
const runningFor = (userId) => db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND is_running = 1 ORDER BY id DESC LIMIT 1').get(userId);

// --- Timer -----------------------------------------------------------------

router.get('/running', (req, res) => {
  const r = runningFor(req.user.id);
  res.json({ running: r ? entryWithMeta(r) : null });
});

// Start a timer. Any existing running timer for this user is stopped first.
router.post('/start', (req, res) => {
  const taskId = req.body.task_id || null;
  if (taskId && !wsTask(taskId, req.workspaceId)) return res.status(400).json({ error: 'Task not found' });
  // Stop a currently-running timer (one per user).
  const running = runningFor(req.user.id);
  if (running) stopEntry(running);
  const info = db.prepare(`
    INSERT INTO time_entries (user_id, task_id, client_id, description, entry_date, minutes, started_at, is_running, billable, workspace_id)
    VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)
  `).run(req.user.id, taskId, resolveClient(req.body, taskId, req.workspaceId), String(req.body.description || '').trim(),
    today(), nowSql(), req.body.billable === false ? 0 : 1, req.workspaceId);
  res.status(201).json({ running: entryWithMeta(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(info.lastInsertRowid)) });
});

function stopEntry(e) {
  const minutes = runningMinutes(e.started_at);
  db.prepare('UPDATE time_entries SET is_running = 0, ended_at = ?, minutes = ? WHERE id = ?').run(nowSql(), minutes, e.id);
  return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(e.id);
}

router.post('/stop', (req, res) => {
  const running = runningFor(req.user.id);
  if (!running) return res.status(400).json({ error: 'No timer is running' });
  res.json({ entry: entryWithMeta(stopEntry(running)) });
});

// --- Manual entries + CRUD -------------------------------------------------

// Log time manually (no timer): minutes + date.
router.post('/', (req, res) => {
  const minutes = Math.max(0, Math.round(Number(req.body.minutes) || 0));
  if (!minutes) return res.status(400).json({ error: 'Enter the time spent (minutes)' });
  const taskId = req.body.task_id || null;
  if (taskId && !wsTask(taskId, req.workspaceId)) return res.status(400).json({ error: 'Task not found' });
  const entry_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.entry_date || '') ? req.body.entry_date : today();
  const info = db.prepare(`
    INSERT INTO time_entries (user_id, task_id, client_id, description, entry_date, minutes, is_running, billable, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(req.user.id, taskId, resolveClient(req.body, taskId, req.workspaceId), String(req.body.description || '').trim(),
    entry_date, minutes, req.body.billable === false ? 0 : 1, req.workspaceId);
  res.status(201).json({ entry: entryWithMeta(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(info.lastInsertRowid)) });
});

const loadEntry = (req, res) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!e) { res.status(404).json({ error: 'Entry not found' }); return null; }
  if (e.user_id !== req.user.id && req.user.role !== 'admin') { res.status(403).json({ error: 'You can only change your own time' }); return null; }
  return e;
};

router.patch('/:id', (req, res) => {
  const e = loadEntry(req, res);
  if (!e) return;
  const minutes = req.body.minutes !== undefined ? Math.max(0, Math.round(Number(req.body.minutes) || 0)) : e.minutes;
  const desc = req.body.description !== undefined ? String(req.body.description).trim() : e.description;
  const billable = req.body.billable !== undefined ? (req.body.billable ? 1 : 0) : e.billable;
  const entry_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.entry_date || '') ? req.body.entry_date : e.entry_date;
  db.prepare('UPDATE time_entries SET minutes = ?, description = ?, billable = ?, entry_date = ? WHERE id = ?')
    .run(minutes, desc, billable, entry_date, e.id);
  res.json({ entry: entryWithMeta(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(e.id)) });
});

router.delete('/:id', (req, res) => {
  const e = loadEntry(req, res);
  if (!e) return;
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

// --- Lists & summaries -----------------------------------------------------

// My entries (default), or a teammate's if admin passes ?user_id. Filters:
// from/to (dates), task_id, client_id.
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const userId = isAdmin && req.query.user_id ? Number(req.query.user_id) : req.user.id;
  const where = ['t.workspace_id = ?', 't.user_id = ?'];
  const params = [req.workspaceId, userId];
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where.push('t.entry_date >= ?'); params.push(req.query.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where.push('t.entry_date <= ?'); params.push(req.query.to); }
  if (req.query.task_id) { where.push('t.task_id = ?'); params.push(Number(req.query.task_id)); }
  if (req.query.client_id) { where.push('t.client_id = ?'); params.push(Number(req.query.client_id)); }
  const rows = db.prepare(`SELECT t.* FROM time_entries t WHERE ${where.join(' AND ')} ORDER BY t.entry_date DESC, t.id DESC`).all(...params);
  res.json({ entries: rows.map(entryWithMeta) });
});

// Today / this week (Mon-based) / this month totals for the caller (minutes).
router.get('/summary', (req, res) => {
  const uid = req.user.id; const ws = req.workspaceId;
  const sum = (clause) => db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN is_running = 1 THEN 0 ELSE minutes END), 0) AS m FROM time_entries WHERE user_id = ? AND workspace_id = ? AND ${clause}`
  ).get(uid, ws).m;
  const running = runningFor(uid);
  const liveExtra = running ? runningMinutes(running.started_at) : 0;
  res.json({
    today: sum(`entry_date = date('now')`) + (running && running.entry_date === today() ? liveExtra : 0),
    week: sum(`entry_date >= date('now','weekday 1','-7 day')`) + liveExtra,
    month: sum(`strftime('%Y-%m', entry_date) = strftime('%Y-%m','now')`) + liveExtra,
    running: running ? entryWithMeta(running) : null,
  });
});

// Admin report: hours per employee and per client over an optional date range.
router.get('/report', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ws = req.workspaceId;
  const range = []; const p = [ws];
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { range.push('entry_date >= ?'); p.push(req.query.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { range.push('entry_date <= ?'); p.push(req.query.to); }
  const rangeSql = range.length ? ' AND ' + range.join(' AND ') : '';
  const byUser = db.prepare(`
    SELECT u.id, u.name, u.avatar_color, u.avatar_url,
      COALESCE(SUM(te.minutes), 0) AS minutes,
      COUNT(DISTINCT te.task_id) AS tasks
    FROM users u LEFT JOIN time_entries te ON te.user_id = u.id AND te.is_running = 0 AND te.workspace_id = ${Number(ws)}${rangeSql.replace(/entry_date/g, 'te.entry_date')}
    WHERE u.active = 1 AND u.role != 'guest' AND u.workspace_id = ${Number(ws)}
    GROUP BY u.id HAVING SUM(te.minutes) > 0 ORDER BY minutes DESC
  `).all(...p.slice(1));
  const byClient = db.prepare(`
    SELECT c.id, c.name, COALESCE(SUM(te.minutes), 0) AS minutes
    FROM clients c JOIN time_entries te ON te.client_id = c.id AND te.is_running = 0
    WHERE c.workspace_id = ?${rangeSql.replace(/entry_date/g, 'te.entry_date')}
    GROUP BY c.id HAVING SUM(te.minutes) > 0 ORDER BY minutes DESC LIMIT 20
  `).all(...p);
  res.json({ by_user: byUser, by_client: byClient });
});

export default router;

// Aggregate helpers reused by other routers (task / client detail).
export function timeForTask(taskId) {
  const rows = db.prepare('SELECT * FROM time_entries WHERE task_id = ? AND is_running = 0 ORDER BY entry_date DESC, id DESC').all(taskId);
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  return { total_minutes: total, entries: rows.map(entryWithMeta) };
}
export function timeForClient(clientId) {
  const rows = db.prepare('SELECT * FROM time_entries WHERE client_id = ? AND is_running = 0 ORDER BY entry_date DESC, id DESC').all(clientId);
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  const billable = rows.filter((r) => r.billable).reduce((s, r) => s + r.minutes, 0);
  return { total_minutes: total, billable_minutes: billable, entries: rows.map(entryWithMeta) };
}
