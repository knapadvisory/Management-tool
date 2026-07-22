// Practice Analytics — one firm-wide (or per-person) performance dashboard.
// Reads data the practice already generates: tasks + ratings + time entries +
// client compliance deadlines. Nothing here writes.
//
// Mounted staff-only in index.js:
//   app.use('/api/analytics', requireAuth, blockGuests, analyticsRouter);
//
// Scope rule (decided with the practice): admins see the whole firm and can
// focus a single person via ?user_id; every other staff member sees only their
// own numbers, no matter what they pass.
import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();

// --- date helpers -----------------------------------------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);

// Resolve ?period into a [from, to] window (inclusive, YYYY-MM-DD) plus the
// immediately-preceding window of equal length (for the "vs last period" delta).
function resolvePeriod(period) {
  const now = new Date();
  const to = iso(now);
  let from;
  if (period === 'week') {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - 6); from = iso(d);
  } else if (period === 'quarter') {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - 89); from = iso(d);
  } else if (period === 'fy') {
    // Indian financial year: 1 Apr – 31 Mar.
    const y = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    from = `${y}-04-01`;
  } else { // month (default) — calendar month to date
    from = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  }
  const span = daysBetween(from, to);
  const prevTo = new Date(from); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - span);
  return { from, to, prevFrom: iso(prevFrom), prevTo: iso(prevTo), span };
}

// Percentage change of `cur` vs `prev`, guarding divide-by-zero.
function pctDelta(cur, prev) {
  if (!prev) return cur ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

// GET /api/analytics?period=month&user_id=&client_id=
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const ws = Number(req.workspaceId);
  const today = iso(new Date());
  const { from, to, prevFrom, prevTo } = resolvePeriod(req.query.period);

  // Focus: members are pinned to themselves; admins may focus one person.
  const focusUser = isAdmin
    ? (req.query.user_id ? Number(req.query.user_id) : null)
    : req.user.id;
  const clientId = req.query.client_id ? Number(req.query.client_id) : null;

  // A reusable "this task belongs to the focused person" clause (assignee set
  // OR legacy primary assignee). Appends its params to `p`.
  const taskScope = (alias, p) => {
    if (!focusUser) return '';
    p.push(focusUser, focusUser);
    return ` AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = ${alias}.id AND ta.user_id = ?) OR ${alias}.assignee_id = ?)`;
  };
  const clientClause = (alias, p) => {
    if (!clientId) return '';
    p.push(clientId);
    return ` AND ${alias}.client_id = ?`;
  };

  // --- KPI: tasks completed (this period vs previous) ---
  const completedCount = (a, b) => {
    const p = [ws, a, b];
    const sql = `SELECT COUNT(*) n FROM tasks t WHERE t.workspace_id = ? AND t.completed_at IS NOT NULL AND date(t.completed_at) BETWEEN ? AND ?${taskScope('t', p)}${clientClause('t', p)}`;
    return db.prepare(sql).get(...p).n;
  };
  const doneNow = completedCount(from, to);
  const donePrev = completedCount(prevFrom, prevTo);

  // --- KPI: on-time completion rate (tasks with a due date, done on/before it) ---
  const onTime = () => {
    const p = [ws, from, to];
    const rows = db.prepare(
      `SELECT t.due_date, t.completed_at FROM tasks t
       WHERE t.workspace_id = ? AND t.completed_at IS NOT NULL AND date(t.completed_at) BETWEEN ? AND ?
         AND t.due_date IS NOT NULL AND t.due_date != ''${taskScope('t', p)}${clientClause('t', p)}`
    ).all(...p);
    if (!rows.length) return { rate: null, n: 0 };
    const good = rows.filter((r) => iso(new Date(r.completed_at)) <= r.due_date).length;
    return { rate: Math.round((good / rows.length) * 100), n: rows.length };
  };

  // --- KPI: average quality rating (done ratings for the ratee, rated in period) ---
  const quality = (a, b) => {
    const p = [ws, a, b];
    let sql = `SELECT ROUND(AVG(stars), 2) avg, COUNT(*) n FROM task_ratings r
       WHERE r.workspace_id = ? AND r.status = 'done' AND r.stars IS NOT NULL AND date(r.rated_at) BETWEEN ? AND ?`;
    if (focusUser) { sql += ' AND r.ratee_id = ?'; p.push(focusUser); }
    return db.prepare(sql).get(...p);
  };
  const qNow = quality(from, to);

  // --- KPI: billable hours (billable minutes logged in period) ---
  const hours = (a, b) => {
    const p = [ws, a, b];
    let sql = `SELECT
        COALESCE(SUM(CASE WHEN billable = 1 THEN minutes ELSE 0 END), 0) billable,
        COALESCE(SUM(minutes), 0) total
      FROM time_entries WHERE workspace_id = ? AND is_running = 0 AND entry_date BETWEEN ? AND ?`;
    if (focusUser) { sql += ' AND user_id = ?'; p.push(focusUser); }
    if (clientId) { sql += ' AND client_id = ?'; p.push(clientId); }
    return db.prepare(sql).get(...p);
  };
  const hNow = hours(from, to);
  const hPrev = hours(prevFrom, prevTo);

  // --- KPI: overdue filings (open deadlines already past due) ---
  const overdueFilings = () => {
    const p = [ws, today];
    let sql = `SELECT COUNT(*) n FROM client_deadlines d
      JOIN clients c ON c.id = d.client_id
      WHERE c.workspace_id = ? AND d.completed = 0 AND d.due_date < ?`;
    if (clientId) { sql += ' AND d.client_id = ?'; p.push(clientId); }
    if (focusUser) { sql += ' AND d.assignee_id = ?'; p.push(focusUser); }
    return db.prepare(sql).get(...p).n;
  };

  const summary = {
    tasks_completed: { value: doneNow, delta: pctDelta(doneNow, donePrev) },
    on_time: onTime(),
    quality: { value: qNow.avg, count: qNow.n },
    billable_hours: {
      hours: Math.round(hNow.billable / 6) / 10, // 1 decimal
      total_hours: Math.round(hNow.total / 6) / 10,
      billable_pct: hNow.total ? Math.round((hNow.billable / hNow.total) * 100) : 0,
      delta: pctDelta(hNow.billable, hPrev.billable),
    },
    overdue_filings: overdueFilings(),
  };

  // --- Throughput series: completed vs newly-assigned, bucketed across period ---
  const buckets = 8;
  const span = Math.max(1, daysBetween(from, to));
  const step = span / buckets;
  const series = Array.from({ length: buckets }, (_, i) => {
    const s = new Date(from); s.setUTCDate(s.getUTCDate() + Math.round(i * step));
    const e = new Date(from); e.setUTCDate(e.getUTCDate() + Math.round((i + 1) * step) - 1);
    return { label: iso(s), from: iso(s), to: iso(e), completed: 0, assigned: 0 };
  });
  const bucketOf = (dateStr) => {
    const off = daysBetween(from, dateStr);
    return Math.min(buckets - 1, Math.max(0, Math.floor(off / step)));
  };
  {
    const pc = [ws, from, to];
    const compRows = db.prepare(
      `SELECT date(t.completed_at) d FROM tasks t WHERE t.workspace_id = ? AND t.completed_at IS NOT NULL AND date(t.completed_at) BETWEEN ? AND ?${taskScope('t', pc)}${clientClause('t', pc)}`
    ).all(...pc);
    for (const r of compRows) series[bucketOf(r.d)].completed++;
    const pa = [ws, from, to];
    const asgRows = db.prepare(
      `SELECT date(t.created_at) d FROM tasks t WHERE t.workspace_id = ? AND date(t.created_at) BETWEEN ? AND ?${taskScope('t', pa)}${clientClause('t', pa)}`
    ).all(...pa);
    for (const r of asgRows) series[bucketOf(r.d)].assigned++;
  }

  // --- Team workload leaderboard (admins: whole firm; members: just them) ---
  // Placeholder order matches the SQL text: today (overdue cutoff), ws (tasks
  // join), ws (users filter), then the optional focused user.
  const wlParams = [today, ws, ws];
  let wlSql = `
    SELECT u.id, u.name, u.avatar_color, u.avatar_url,
      COUNT(DISTINCT CASE WHEN t.status IN ('in_progress','hold') AND s.is_done = 0 THEN t.id END) AS open_tasks,
      COUNT(DISTINCT CASE WHEN t.status IN ('in_progress','hold') AND s.is_done = 0
            AND t.due_date IS NOT NULL AND t.due_date != '' AND t.due_date < ? THEN t.id END) AS overdue,
      (SELECT ROUND(AVG(stars), 1) FROM task_ratings r WHERE r.ratee_id = u.id AND r.status = 'done' AND r.stars IS NOT NULL) AS avg_rating
    FROM users u
    LEFT JOIN task_assignees ta ON ta.user_id = u.id
    LEFT JOIN tasks t ON t.id = ta.task_id AND t.workspace_id = ?
    LEFT JOIN workflow_stages s ON s.id = t.stage_id
    WHERE u.workspace_id = ? AND u.active = 1 AND u.deleted = 0 AND u.role != 'guest'`;
  if (focusUser) { wlSql += ' AND u.id = ?'; wlParams.push(focusUser); }
  wlSql += ' GROUP BY u.id ORDER BY open_tasks DESC, u.name';
  const workload = db.prepare(wlSql).all(...wlParams);

  // --- Compliance status (open vs filed vs overdue) + breakdown by filing type ---
  // Placeholder order: due_soon cutoff, overdue cutoff, then workspace.
  const compP = [today, today, ws];
  let compSql = `
    SELECT
      SUM(CASE WHEN d.completed = 1 THEN 1 ELSE 0 END) AS filed,
      SUM(CASE WHEN d.completed = 0 AND d.due_date >= ? THEN 1 ELSE 0 END) AS due_soon,
      SUM(CASE WHEN d.completed = 0 AND d.due_date < ? THEN 1 ELSE 0 END) AS overdue,
      COUNT(*) AS total
    FROM client_deadlines d JOIN clients c ON c.id = d.client_id
    WHERE c.workspace_id = ?`;
  if (clientId) { compSql += ' AND d.client_id = ?'; compP.push(clientId); }
  if (focusUser) { compSql += ' AND d.assignee_id = ?'; compP.push(focusUser); }
  const compliance = db.prepare(compSql).get(...compP);

  const typeP = [ws];
  let typeSql = `SELECT d.title AS name, COUNT(*) AS n FROM client_deadlines d JOIN clients c ON c.id = d.client_id WHERE c.workspace_id = ?`;
  if (clientId) { typeSql += ' AND d.client_id = ?'; typeP.push(clientId); }
  if (focusUser) { typeSql += ' AND d.assignee_id = ?'; typeP.push(focusUser); }
  typeSql += ' GROUP BY d.title ORDER BY n DESC LIMIT 6';
  const complianceByType = db.prepare(typeSql).all(...typeP);

  // --- Quality trend: avg rating by calendar month, last 6 months ---
  const qtP = [ws];
  let qtSql = `SELECT strftime('%Y-%m', r.rated_at) AS ym, ROUND(AVG(r.stars), 2) AS avg, COUNT(*) AS n
    FROM task_ratings r
    WHERE r.workspace_id = ? AND r.status = 'done' AND r.stars IS NOT NULL AND r.rated_at >= date('now','-6 months')`;
  if (focusUser) { qtSql += ' AND r.ratee_id = ?'; qtP.push(focusUser); }
  qtSql += ` GROUP BY ym ORDER BY ym`;
  const qualityTrend = db.prepare(qtSql).all(...qtP);

  // --- Billable hours by client (top 8 this period) ---
  const bcP = [ws, from, to];
  let bcSql = `SELECT c.id, c.name, COALESCE(SUM(te.minutes), 0) AS minutes
    FROM clients c JOIN time_entries te ON te.client_id = c.id AND te.is_running = 0 AND te.billable = 1
    WHERE c.workspace_id = ? AND te.entry_date BETWEEN ? AND ?`;
  if (focusUser) { bcSql += ' AND te.user_id = ?'; bcP.push(focusUser); }
  bcSql += ' GROUP BY c.id HAVING SUM(te.minutes) > 0 ORDER BY minutes DESC LIMIT 8';
  const timeByClient = db.prepare(bcP.length ? bcSql : bcSql).all(...bcP)
    .map((r) => ({ id: r.id, name: r.name, hours: Math.round(r.minutes / 6) / 10 }));

  // --- Needs attention: overdue + soonest-due open filings, ranked by urgency ---
  const naP = [ws];
  let naSql = `SELECT d.id, d.title, d.due_date, c.name AS client_name,
      u.id AS owner_id, u.name AS owner_name, u.avatar_color, u.avatar_url
    FROM client_deadlines d
    JOIN clients c ON c.id = d.client_id
    LEFT JOIN users u ON u.id = d.assignee_id
    WHERE c.workspace_id = ? AND d.completed = 0`;
  if (clientId) { naSql += ' AND d.client_id = ?'; naP.push(clientId); }
  if (focusUser) { naSql += ' AND d.assignee_id = ?'; naP.push(focusUser); }
  naSql += ` ORDER BY d.due_date ASC LIMIT 12`;
  const attention = db.prepare(naSql).all(...naP).map((r) => ({
    id: r.id, title: r.title, due_date: r.due_date, client_name: r.client_name,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name, avatar_color: r.avatar_color, avatar_url: r.avatar_url } : null,
    days_overdue: daysBetween(r.due_date, today), // >0 overdue, <=0 upcoming
  }));

  res.json({
    scope: { is_admin: isAdmin, focus_user: focusUser, client_id: clientId, period: req.query.period || 'month', from, to },
    summary,
    throughput: series,
    workload,
    compliance: { ...compliance, by_type: complianceByType },
    quality_trend: qualityTrend,
    time_by_client: timeByClient,
    attention,
  });
});

// GET /api/analytics/ratings?user_id=  — the Appraisals view.
// Employee ranking by average rating + every rated task (who was rated, who
// rated them, the stars and comment). All-time so the leaderboard is stable.
// Admins see the whole firm (and may focus one person); members see only the
// ratings they themselves received.
router.get('/ratings', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const ws = Number(req.workspaceId);
  const focusUser = isAdmin
    ? (req.query.user_id ? Number(req.query.user_id) : null)
    : req.user.id;

  // Per-employee leaderboard: average, count, and the 1–5 star distribution.
  const rankP = [ws, ws];
  let rankSql = `
    SELECT u.id, u.name, u.avatar_color, u.avatar_url,
      ROUND(AVG(r.stars), 2) AS avg, COUNT(*) AS count,
      SUM(CASE WHEN r.stars = 1 THEN 1 ELSE 0 END) AS d1,
      SUM(CASE WHEN r.stars = 2 THEN 1 ELSE 0 END) AS d2,
      SUM(CASE WHEN r.stars = 3 THEN 1 ELSE 0 END) AS d3,
      SUM(CASE WHEN r.stars = 4 THEN 1 ELSE 0 END) AS d4,
      SUM(CASE WHEN r.stars = 5 THEN 1 ELSE 0 END) AS d5,
      ROUND(AVG(CASE WHEN r.rated_at >= date('now','-30 day') THEN r.stars END), 2) AS avg_30,
      ROUND(AVG(CASE WHEN r.rated_at <  date('now','-30 day') THEN r.stars END), 2) AS avg_prev
    FROM users u
    JOIN task_ratings r ON r.ratee_id = u.id AND r.status = 'done' AND r.stars IS NOT NULL AND r.workspace_id = ?
    WHERE u.workspace_id = ? AND u.deleted = 0`;
  if (focusUser) { rankSql += ' AND u.id = ?'; rankP.push(focusUser); }
  rankSql += ' GROUP BY u.id HAVING count > 0 ORDER BY avg DESC, count DESC';
  const ranking = db.prepare(rankSql).all(...rankP).map((r) => ({
    id: r.id, name: r.name, avatar_color: r.avatar_color, avatar_url: r.avatar_url,
    avg: r.avg, count: r.count,
    dist: [r.d1, r.d2, r.d3, r.d4, r.d5],
    trend: r.avg_30 != null && r.avg_prev != null ? Math.round((r.avg_30 - r.avg_prev) * 100) / 100 : null,
  }));

  // Every rated task: what it was, who was rated, who rated them.
  const taskP = [ws];
  let taskSql = `
    SELECT r.task_id, t.title, t.client_id, cl.name AS client_name,
      r.stars, r.comment, r.role, r.rated_at,
      ratee.id AS ratee_id, ratee.name AS ratee_name, ratee.avatar_color AS ratee_color, ratee.avatar_url AS ratee_url,
      rater.id AS rater_id, rater.name AS rater_name
    FROM task_ratings r
    JOIN tasks t ON t.id = r.task_id
    JOIN users ratee ON ratee.id = r.ratee_id
    LEFT JOIN users rater ON rater.id = r.rater_id
    LEFT JOIN clients cl ON cl.id = t.client_id
    WHERE r.workspace_id = ? AND r.status = 'done' AND r.stars IS NOT NULL`;
  if (focusUser) { taskSql += ' AND r.ratee_id = ?'; taskP.push(focusUser); }
  taskSql += ' ORDER BY r.rated_at DESC LIMIT 300';
  const tasks = db.prepare(taskSql).all(...taskP).map((r) => ({
    task_id: r.task_id, title: r.title, client_name: r.client_name,
    stars: r.stars, comment: r.comment, role: r.role, rated_at: r.rated_at,
    ratee: { id: r.ratee_id, name: r.ratee_name, avatar_color: r.ratee_color, avatar_url: r.ratee_url },
    rater: r.rater_id ? { id: r.rater_id, name: r.rater_name } : null,
  }));

  // Ratings still waiting to be given (reminds managers what's outstanding).
  const pendP = [ws];
  let pendSql = `SELECT COUNT(*) n FROM task_ratings WHERE workspace_id = ? AND status = 'pending'`;
  if (focusUser) { pendSql += ' AND ratee_id = ?'; pendP.push(focusUser); }
  const pending = db.prepare(pendSql).get(...pendP).n;

  // Firm-wide distribution + headline numbers.
  const overall = tasks.reduce((a, t) => { a.sum += t.stars; a.dist[t.stars - 1]++; return a; }, { sum: 0, dist: [0, 0, 0, 0, 0] });
  const avgAll = tasks.length ? Math.round((overall.sum / tasks.length) * 100) / 100 : null;

  res.json({
    scope: { is_admin: isAdmin, focus_user: focusUser },
    ranking,
    tasks,
    pending,
    summary: { total_ratings: tasks.length, avg: avgAll, distribution: overall.dist, rated_people: ranking.length },
  });
});

export default router;
