/**
 * Unit test for the reminder scheduler and recurrence date math. Runs the
 * real db + reminders modules against a throwaway database (no HTTP), so it
 * can drive processDueReminders() directly instead of waiting on the timer.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'teamhub-rem-'));
process.env.JWT_SECRET = 'reminders-test';

const { default: db } = await import('../src/db.js');
const { nextDueDate, processDueReminders } = await import('../src/reminders.js');

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

// --- nextDueDate ---
check('daily advance', nextDueDate('2026-07-10', 'daily') === '2026-07-11');
check('weekly advance', nextDueDate('2026-07-10', 'weekly') === '2026-07-17');
check('monthly advance', nextDueDate('2026-01-15', 'monthly') === '2026-02-15');
check('yearly advance', nextDueDate('2026-07-10', 'yearly') === '2027-07-10');
check('month rollover', nextDueDate('2026-12-20', 'monthly') === '2027-01-20');
check('none returns null', nextDueDate('2026-07-10', 'none') === null);
check('missing date returns null', nextDueDate(null, 'weekly') === null);

// --- processDueReminders ---
// Seed the minimum graph: a user, a workflow+stage, a task, and reminders.
const u = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)')
  .run('Rem User', 'rem@test.local', 'x', '#4f46e5');
const userId = u.lastInsertRowid;
const wf = db.prepare(`INSERT INTO workflows (name) VALUES ('WF')`).run();
const stage = db.prepare('INSERT INTO workflow_stages (workflow_id, name, position) VALUES (?, ?, 0)').run(wf.lastInsertRowid, 'To Do');
const t = db.prepare('INSERT INTO tasks (title, workflow_id, stage_id, creator_id, assignee_id) VALUES (?, ?, ?, ?, ?)')
  .run('Reminder task', wf.lastInsertRowid, stage.lastInsertRowid, userId, userId);
const taskId = t.lastInsertRowid;

// One reminder already due, one in the far future.
db.prepare(`INSERT INTO task_reminders (task_id, remind_at) VALUES (?, datetime('now','-1 minute'))`).run(taskId);
db.prepare(`INSERT INTO task_reminders (task_id, remind_at) VALUES (?, datetime('now','+1 day'))`).run(taskId);

processDueReminders(null); // io=null: notifications persist, socket emit is a no-op

const sent = db.prepare('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ? AND sent = 1').get(taskId).n;
const pending = db.prepare('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ? AND sent = 0').get(taskId).n;
check('due reminder marked sent', sent === 1);
check('future reminder left pending', pending === 1);

const notif = db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND type = 'task_reminder'`).all(userId);
check('reminder produced a notification for the assignee', notif.length === 1);
check('notification points at the task', notif[0]?.task_id === taskId);

// Idempotent: running again fires nothing new.
processDueReminders(null);
const notifAfter = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'task_reminder'`).get(userId).n;
check('a sent reminder does not fire twice', notifAfter === 1);

rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} reminder check(s) FAILED` : '\nReminder test passed');
process.exit(failures ? 1 : 0);
