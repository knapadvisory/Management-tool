import db from './db.js';
import { createNotification } from './notifications.js';
import { emailEnabled, sendMail, layout } from './email.js';

// Advance a YYYY-MM-DD date by one recurrence interval. Returns null for
// 'none' or a missing date. Month/year math clamps to end-of-month naturally
// via the Date constructor (e.g. Jan 31 + 1 month → Mar 3 is avoided by
// using setMonth on a UTC date and letting it roll, which is fine for tasks).
export function nextDueDate(dateStr, recurrence) {
  if (!dateStr || !recurrence || recurrence === 'none') return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  switch (recurrence) {
    case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
    case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'yearly': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: return null;
  }
  return d.toISOString().slice(0, 10);
}

// Everyone who should hear about a task: its assignee plus all watchers.
function taskAudience(taskId, assigneeId) {
  const ids = new Set(db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(taskId).map((r) => r.user_id));
  if (assigneeId) ids.add(assigneeId);
  return [...ids];
}

// Fire any reminders whose time has arrived. Called on an interval.
export function processDueReminders(io) {
  const due = db.prepare(`SELECT * FROM task_reminders WHERE sent = 0 AND remind_at <= datetime('now')`).all();
  for (const r of due) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.task_id);
    db.prepare('UPDATE task_reminders SET sent = 1 WHERE id = ?').run(r.id);
    if (!task) continue;
    for (const uid of taskAudience(task.id, task.assignee_id)) {
      createNotification(io, {
        user_id: uid, type: 'task_reminder', actor_id: null, task_id: task.id,
        text: `Reminder: "${task.title}"${task.due_date ? ` (due ${task.due_date})` : ''}`,
      });
    }
  }
}

export function startReminderScheduler(io) {
  // Run shortly after boot, then every minute. Reminders have minute
  // granularity, which is plenty for task due-date nudges.
  processDueReminders(io);
  const timer = setInterval(() => processDueReminders(io), 60 * 1000);
  timer.unref?.(); // don't keep the process alive just for the scheduler
  return timer;
}

// --- Compliance deadline reminders -------------------------------------------
// A CA firm's worst outcome is a missed statutory filing. This turns the
// compliance board proactive: it nudges whoever files a client deadline as it
// approaches (3 days out, the day before, the day itself) and once more when it
// slips overdue — in-app + push always, and email for the urgent ones.

const IST_OFFSET_MIN = 330; // Asia/Kolkata (no DST) — the firm's working calendar day.

// Today's date (YYYY-MM-DD) in IST.
function istToday() {
  return new Date(Date.now() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

// Whole days from IST-today to a YYYY-MM-DD due date (negative = overdue).
function daysUntilDue(due) {
  const today = new Date(istToday() + 'T00:00:00Z').getTime();
  const target = new Date(due + 'T00:00:00Z').getTime();
  return Math.round((target - today) / 86400000);
}

// Which milestone (if any) a deadline that is `days` away should fire now.
function dueKind(days) {
  if (days === 3) return 'due_3d';
  if (days === 1) return 'due_1d';
  if (days === 0) return 'due_0d';
  if (days === -1) return 'overdue'; // a single nudge the morning after
  return null;
}

function fmtDue(due) {
  const dt = new Date(due + 'T00:00:00Z');
  return Number.isNaN(dt.getTime()) ? due
    : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Who to nudge: the person who files it, or — if nobody's assigned — the
// workspace admins, so an unowned filing can't silently slip.
function deadlineAudience(d) {
  if (d.assignee_id) return [d.assignee_id];
  return db.prepare(
    `SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1 AND approved = 1 AND deleted = 0`,
  ).all(d.workspace_id).map((r) => r.id);
}

export function processDeadlineReminders(io) {
  const rows = db.prepare(`
    SELECT d.id, d.title, d.due_date, d.assignee_id, d.task_id, c.name AS client_name, c.workspace_id
    FROM client_deadlines d JOIN clients c ON c.id = d.client_id
    WHERE d.completed = 0 AND d.due_date IS NOT NULL AND d.due_date != ''
  `).all();

  const markSent = db.prepare('INSERT OR IGNORE INTO deadline_reminders_sent (deadline_id, due_date, kind) VALUES (?, ?, ?)');
  let sent = 0;
  for (const d of rows) {
    const kind = dueKind(daysUntilDue(d.due_date));
    if (!kind) continue;
    // INSERT OR IGNORE + changes tells us atomically whether this is the first
    // time — so a restart mid-hour can't double-send.
    if (markSent.run(d.id, d.due_date, kind).changes === 0) continue;

    const phrase = kind === 'due_3d' ? 'is due in 3 days'
      : kind === 'due_1d' ? 'is due tomorrow'
        : kind === 'due_0d' ? 'is due today' : 'is overdue';
    const text = kind === 'overdue'
      ? `⚠ Overdue: ${d.title} for ${d.client_name} (was due ${fmtDue(d.due_date)})`
      : `⏳ ${d.title} for ${d.client_name} ${phrase} (${fmtDue(d.due_date)})`;
    const urgent = kind === 'due_0d' || kind === 'overdue';

    for (const uid of deadlineAudience(d)) {
      // task_id (if the deadline has a linked task) makes the bell entry clickable.
      createNotification(io, { user_id: uid, type: 'deadline_reminder', actor_id: null, task_id: d.task_id || null, text });
      if (urgent && emailEnabled()) {
        const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(uid);
        if (u?.email && !String(u.email).endsWith('@teamhub.guest')) {
          sendMail({
            to: u.email,
            subject: kind === 'overdue' ? `Overdue filing: ${d.title} — ${d.client_name}` : `Due today: ${d.title} — ${d.client_name}`,
            html: layout('Compliance reminder', `<p>Hi ${u.name || 'there'},</p><p>${text}.</p><p>Open TeamHub → Clients → Compliance board to action it.</p>`),
          });
        }
      }
      sent += 1;
    }
  }
  return sent;
}

export function startDeadlineReminderScheduler(io) {
  // Day-granular milestones, so an hourly sweep is ample. Runs once on boot to
  // catch anything due, then hourly.
  processDeadlineReminders(io);
  const timer = setInterval(() => processDeadlineReminders(io), 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

// --- Weekly "due this week" digest -------------------------------------------
// A Monday-morning summary so everyone starts the week knowing their compliance
// load: each person gets their own filings due Mon–Sun; admins get a firm-wide
// view. Complements the day-by-day reminders above with a planning overview.

const DIGEST_HOUR_IST = 9; // send from 9am IST on Monday

// A Date whose UTC fields read as the IST wall clock (so getUTCDay/Hours = IST).
function istNow() { return new Date(Date.now() + IST_OFFSET_MIN * 60000); }

// Monday (YYYY-MM-DD) of the current IST week.
function istWeekStart(now = istNow()) {
  const dow = now.getUTCDay();            // 0=Sun … 6=Sat
  const back = dow === 0 ? 6 : dow - 1;   // days since Monday
  return new Date(now.getTime() - back * 86400000).toISOString().slice(0, 10);
}

const addDays = (ymd, n) => new Date(new Date(ymd + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

// Send one person their digest (in-app + push, and email when configured).
function digestTo(io, userId, list, headline, firmWide = false) {
  const first = list[0];
  const text = `📅 ${headline} — first up: ${first.title} for ${first.client_name} (${fmtDue(first.due_date)})`;
  createNotification(io, { user_id: userId, type: 'deadline_digest', actor_id: null, text });
  if (emailEnabled()) {
    const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
    if (u?.email && !String(u.email).endsWith('@teamhub.guest')) {
      const items = list.map((r) => `<li><strong>${fmtDue(r.due_date)}</strong> — ${r.title} · ${r.client_name}${firmWide && !r.assignee_id ? ' <em>(unassigned)</em>' : ''}</li>`).join('');
      sendMail({
        to: u.email,
        subject: firmWide ? `This week: ${list.length} filing${list.length === 1 ? '' : 's'} due across the firm` : `Your week: ${list.length} filing${list.length === 1 ? '' : 's'} due`,
        html: layout('Filings due this week', `<p>Hi ${u.name || 'there'},</p><p>${headline}:</p><ul>${items}</ul><p>Open TeamHub → Clients → Compliance board to plan the week.</p>`),
      });
    }
  }
  return 1;
}

// Build + send digests for one week. Idempotent per (workspace, week) via
// weekly_digest_sent, so repeated ticks are safe.
export function sendWeeklyDigest(io, weekStart, weekEnd) {
  const mark = db.prepare('INSERT OR IGNORE INTO weekly_digest_sent (workspace_id, week_start) VALUES (?, ?)');
  let sent = 0;
  for (const w of db.prepare('SELECT id FROM workspaces').all()) {
    if (mark.run(w.id, weekStart).changes === 0) continue; // already done this week

    const rows = db.prepare(`
      SELECT d.title, d.due_date, d.assignee_id, c.name AS client_name
      FROM client_deadlines d JOIN clients c ON c.id = d.client_id
      WHERE c.workspace_id = ? AND d.completed = 0 AND d.due_date >= ? AND d.due_date <= ?
      ORDER BY d.due_date
    `).all(w.id, weekStart, weekEnd);
    if (rows.length === 0) continue;

    const admins = db.prepare(
      `SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1 AND approved = 1 AND deleted = 0`,
    ).all(w.id);
    const adminIds = new Set(admins.map((a) => a.id));

    // Personal digests for the people who actually file them (skip admins —
    // they get the firm-wide one, which already covers their items).
    const byAssignee = new Map();
    for (const r of rows) {
      if (!r.assignee_id || adminIds.has(r.assignee_id)) continue;
      if (!byAssignee.has(r.assignee_id)) byAssignee.set(r.assignee_id, []);
      byAssignee.get(r.assignee_id).push(r);
    }
    for (const [uid, list] of byAssignee) {
      sent += digestTo(io, uid, list, `You have ${list.length} filing${list.length === 1 ? '' : 's'} due this week`);
    }
    for (const a of admins) {
      sent += digestTo(io, a.id, rows, `${rows.length} filing${rows.length === 1 ? '' : 's'} due across the firm this week`, true);
    }
  }
  return sent;
}

export function processWeeklyDigest(io) {
  const weekStart = istWeekStart();
  // Hold until Monday 9am IST (the shifted clock lets us compare directly).
  const threshold = new Date(`${weekStart}T${String(DIGEST_HOUR_IST).padStart(2, '0')}:00:00Z`).getTime();
  if (istNow().getTime() < threshold) return 0;
  return sendWeeklyDigest(io, weekStart, addDays(weekStart, 6));
}

export function startWeeklyDigestScheduler(io) {
  // Hourly is fine — the once-per-week guard makes repeated ticks no-ops.
  processWeeklyDigest(io);
  const timer = setInterval(() => processWeeklyDigest(io), 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

// Tasks that have been "done" for more than 7 days are auto-archived so the
// Done column doesn't grow without bound. Users can still archive sooner by
// hand, or restore anything from the archive. Runs hourly (background sweep).
export function autoArchiveDone() {
  const info = db.prepare(`
    UPDATE tasks SET archived_at = datetime('now')
    WHERE archived_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at <= datetime('now', '-7 days')
  `).run();
  return info.changes;
}

export function startAutoArchiveScheduler() {
  autoArchiveDone();
  const timer = setInterval(autoArchiveDone, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
