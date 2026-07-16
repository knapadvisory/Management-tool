import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();

const getUser = (id) => (id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);

function assigneesFor(t) {
  const rows = db.prepare('SELECT u.* FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = ? ORDER BY u.name').all(t.id).map(publicUser);
  if (rows.length) return rows;
  const primary = t.assignee_id ? publicUser(getUser(t.assignee_id)) : null;
  return primary ? [primary] : [];
}

function liteTask(t) {
  const stage = db.prepare('SELECT name FROM workflow_stages WHERE id = ?').get(t.stage_id);
  const project = t.project_id ? db.prepare('SELECT name, color FROM projects WHERE id = ?').get(t.project_id) : null;
  return {
    id: t.id, title: t.title, priority: t.priority, due_date: t.due_date, status: t.status,
    stage: stage?.name || null,
    assignee: publicUser(getUser(t.assignee_id)),
    assignees: assigneesFor(t),
    creator: publicUser(getUser(t.creator_id)),
    project,
  };
}

// Role-aware home dashboard. Members see only tasks they created, are assigned
// to, or watch; admins see the whole firm (plus team workload).
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  const ws = Number(req.workspaceId); // integer from the JWT — safe to inline
  // Every task query is scoped to the workspace first, then to visibility.
  const scope = ` AND t.workspace_id = ${ws}` + (isAdmin ? '' :
    ` AND (t.creator_id = ${uid} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${uid}) OR EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = ${uid}))`);
  const OPEN = `t.status NOT IN ('completed','cancelled')`;

  const rows = (sql) => db.prepare(sql).all();
  const one = (sql) => db.prepare(sql).get();

  const open = one(`SELECT COUNT(*) AS n FROM tasks t WHERE ${OPEN}${scope}`).n;
  const overdue = one(`SELECT COUNT(*) AS n FROM tasks t WHERE ${OPEN} AND t.due_date IS NOT NULL AND t.due_date < date('now')${scope}`).n;
  const dueSoon = one(`SELECT COUNT(*) AS n FROM tasks t WHERE ${OPEN} AND t.due_date IS NOT NULL AND t.due_date >= date('now') AND t.due_date <= date('now','+7 day')${scope}`).n;
  const clients = one(`SELECT COUNT(DISTINCT t.project_id) AS n FROM tasks t WHERE ${OPEN} AND t.project_id IS NOT NULL${scope}`).n;

  const upcoming = rows(
    `SELECT t.* FROM tasks t WHERE ${OPEN} AND t.due_date IS NOT NULL${scope} ORDER BY t.due_date ASC LIMIT 8`
  ).map(liteTask);

  const urgent = rows(
    `SELECT t.* FROM tasks t
     WHERE ${OPEN}${scope}
       AND (t.priority IN ('high','urgent') OR (t.due_date IS NOT NULL AND t.due_date <= date('now','+2 day')))
     ORDER BY (t.due_date IS NULL), t.due_date ASC LIMIT 8`
  ).map(liteTask);

  // Board: open tasks grouped by their stage, plus recently-completed count.
  const board = rows(
    `SELECT s.name AS stage, COUNT(*) AS count
     FROM tasks t JOIN workflow_stages s ON s.id = t.stage_id
     WHERE ${OPEN}${scope} GROUP BY s.id ORDER BY s.position`
  );
  const doneCount = one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.status = 'completed' AND t.archived_at IS NULL${scope}`).n;

  // All in-scope open tasks (for the member "all tasks" list / admin overview).
  const allTasks = rows(
    `SELECT t.* FROM tasks t WHERE ${OPEN}${scope} ORDER BY (t.due_date IS NULL), t.due_date ASC LIMIT 50`
  ).map(liteTask);

  // Team workload (admins only): open tasks per assignee.
  let workload = [];
  if (isAdmin) {
    workload = db.prepare(
      `SELECT u.id, u.name, u.avatar_color, u.avatar_url, COUNT(t.id) AS count
       FROM users u
       LEFT JOIN task_assignees ta ON ta.user_id = u.id
       LEFT JOIN tasks t ON t.id = ta.task_id AND t.status NOT IN ('completed','cancelled') AND t.archived_at IS NULL AND t.workspace_id = ${ws}
       WHERE u.active = 1 AND u.role != 'guest' AND u.workspace_id = ${ws} GROUP BY u.id HAVING count > 0 ORDER BY count DESC`
    ).all();
  }

  // Recent activity across visible tasks.
  const activity = db.prepare(
    `SELECT a.id, a.action, a.created_at, a.task_id, u.name AS user_name, u.avatar_color AS user_color, t.title AS task_title
     FROM task_activity a
     JOIN users u ON u.id = a.user_id
     JOIN tasks t ON t.id = a.task_id
     WHERE 1=1${scope}
     ORDER BY a.id DESC LIMIT 12`
  ).all();

  // Tasks closed this month (a period KPI, alongside the all-time done count).
  const closedMonth = one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.completed_at IS NOT NULL AND strftime('%Y-%m', t.completed_at) = strftime('%Y-%m','now')${scope}`).n;

  // Overdue aging: how long overdue things have been sitting (0-15 / 15-30 /
  // 30-60 / 60+ days) — for open tasks (scoped) and open compliance filings.
  const ageBuckets = (dateExpr, from, extra = '') => one(`
    SELECT
      SUM(CASE WHEN julianday('now') - julianday(${dateExpr}) <= 15 THEN 1 ELSE 0 END) AS d15,
      SUM(CASE WHEN julianday('now') - julianday(${dateExpr}) > 15 AND julianday('now') - julianday(${dateExpr}) <= 30 THEN 1 ELSE 0 END) AS d30,
      SUM(CASE WHEN julianday('now') - julianday(${dateExpr}) > 30 AND julianday('now') - julianday(${dateExpr}) <= 60 THEN 1 ELSE 0 END) AS d60,
      SUM(CASE WHEN julianday('now') - julianday(${dateExpr}) > 60 THEN 1 ELSE 0 END) AS d60plus,
      COUNT(*) AS total
    FROM ${from} WHERE ${extra}`);
  const taskAging = ageBuckets('t.due_date', 'tasks t', `${OPEN} AND t.due_date IS NOT NULL AND t.due_date < date('now')${scope}`);
  const filingAging = ageBuckets('d.due_date', `client_deadlines d JOIN clients c ON c.id = d.client_id`, `c.workspace_id = ${ws} AND d.completed = 0 AND d.due_date < date('now')`);

  // Upcoming closures: compliance filings due in the next 15/30/45/60 days.
  const closureBuckets = one(`
    SELECT
      SUM(CASE WHEN julianday(d.due_date) - julianday('now') <= 15 THEN 1 ELSE 0 END) AS d15,
      SUM(CASE WHEN julianday(d.due_date) - julianday('now') > 15 AND julianday(d.due_date) - julianday('now') <= 30 THEN 1 ELSE 0 END) AS d30,
      SUM(CASE WHEN julianday(d.due_date) - julianday('now') > 30 AND julianday(d.due_date) - julianday('now') <= 45 THEN 1 ELSE 0 END) AS d45,
      SUM(CASE WHEN julianday(d.due_date) - julianday('now') > 45 AND julianday(d.due_date) - julianday('now') <= 60 THEN 1 ELSE 0 END) AS d60,
      COUNT(*) AS total
    FROM client_deadlines d JOIN clients c ON c.id = d.client_id
    WHERE c.workspace_id = ${ws} AND d.completed = 0 AND d.due_date >= date('now') AND d.due_date <= date('now','+60 day')`);
  const closureList = db.prepare(`
    SELECT d.id, d.title, d.due_date, c.name AS client_name, u.name AS assignee_name, u.avatar_color AS assignee_color
    FROM client_deadlines d JOIN clients c ON c.id = d.client_id LEFT JOIN users u ON u.id = d.assignee_id
    WHERE c.workspace_id = ${ws} AND d.completed = 0 AND d.due_date >= date('now') AND d.due_date <= date('now','+60 day')
    ORDER BY d.due_date LIMIT 12`).all();

  // This financial year (India: Apr → Mar): tasks assigned vs completed per month.
  const now = new Date();
  const fyStart = (now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
  const fyFrom = `${fyStart}-04-01`;
  const fyTo = `${fyStart + 1}-04-01`;
  const assignedByMonth = Object.fromEntries(db.prepare(
    `SELECT strftime('%Y-%m', t.created_at) AS m, COUNT(*) AS n FROM tasks t
     WHERE t.created_at >= '${fyFrom}' AND t.created_at < '${fyTo}'${scope} GROUP BY m`).all().map((r) => [r.m, r.n]));
  const completedByMonth = Object.fromEntries(db.prepare(
    `SELECT strftime('%Y-%m', t.completed_at) AS m, COUNT(*) AS n FROM tasks t
     WHERE t.completed_at IS NOT NULL AND t.completed_at >= '${fyFrom}' AND t.completed_at < '${fyTo}'${scope} GROUP BY m`).all().map((r) => [r.m, r.n]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const yearMonths = Array.from({ length: 12 }, (_, i) => {
    const mIdx = (3 + i) % 12;                 // Apr..Mar
    const yr = fyStart + (mIdx < 3 ? 1 : 0);
    const key = `${yr}-${String(mIdx + 1).padStart(2, '0')}`;
    return { key, label: MON[mIdx], assigned: assignedByMonth[key] || 0, completed: completedByMonth[key] || 0 };
  });

  res.json({
    role: isAdmin ? 'admin' : 'member',
    summary: { open, overdue, due_soon: dueSoon, clients, closed_month: closedMonth },
    upcoming, urgent, board, done_count: doneCount, all_tasks: allTasks, workload, activity,
    aging: { tasks: taskAging, filings: filingAging },
    closures: { buckets: closureBuckets, list: closureList },
    year: { fy: `${fyStart}–${fyStart + 1}`, months: yearMonths },
  });
});

export default router;
