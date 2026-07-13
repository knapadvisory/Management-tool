import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();

const getUser = (id) => (id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);

function liteTask(t) {
  const stage = db.prepare('SELECT name FROM workflow_stages WHERE id = ?').get(t.stage_id);
  const project = t.project_id ? db.prepare('SELECT name, color FROM projects WHERE id = ?').get(t.project_id) : null;
  return {
    id: t.id, title: t.title, priority: t.priority, due_date: t.due_date, status: t.status,
    stage: stage?.name || null,
    assignee: publicUser(getUser(t.assignee_id)),
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
    ` AND (t.creator_id = ${uid} OR t.assignee_id = ${uid} OR EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = ${uid}))`);
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
      `SELECT u.id, u.name, u.avatar_color, COUNT(t.id) AS count
       FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status NOT IN ('completed','cancelled') AND t.workspace_id = ${ws}
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

  res.json({
    role: isAdmin ? 'admin' : 'member',
    summary: { open, overdue, due_soon: dueSoon, clients },
    upcoming, urgent, board, done_count: doneCount, all_tasks: allTasks, workload, activity,
  });
});

export default router;
