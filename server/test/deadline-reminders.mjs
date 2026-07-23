/**
 * Compliance deadline reminders: the hourly sweep nudges whoever files a client
 * deadline as it approaches (T-3 / T-1 / day-of / overdue), falls back to admins
 * when unassigned, and never double-sends. Exercised by importing the scheduler
 * directly against a temp DB (no HTTP needed).
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'teamhub-dl-'));
process.env.JWT_SECRET = 'test';

const db = (await import('../src/db.js')).default;
const { processDeadlineReminders } = await import('../src/reminders.js');

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

// The scheduler works in IST — mirror that when building test dates.
const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plusDays = (n) => new Date(new Date(istToday + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

const ws = db.prepare("INSERT INTO workspaces (name, slug) VALUES ('Firm', 'firm')").run().lastInsertRowid;
const mkUser = (name, email, role) => db.prepare(
  `INSERT INTO users (name, email, password_hash, avatar_color, role, active, approved, deleted, workspace_id)
   VALUES (?, ?, 'x', '#000', ?, 1, 1, 0, ?)`,
).run(name, email, role, ws).lastInsertRowid;
const asha = mkUser('Asha', 'asha@f.test', 'member');
const admin = mkUser('Admin', 'admin@f.test', 'admin');
const client = db.prepare("INSERT INTO clients (name, workspace_id, created_by) VALUES ('Acme', ?, ?)").run(ws, admin).lastInsertRowid;

const mkDl = (title, due, assignee) => db.prepare(
  'INSERT INTO client_deadlines (client_id, title, due_date, recurrence, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
).run(client, title, due, 'monthly', assignee, admin).lastInsertRowid;

const dueToday = mkDl('GSTR-3B', istToday, asha);   // day-of → fires
mkDl('GSTR-1', plusDays(3), asha);                  // T-3 → fires
mkDl('TDS', plusDays(2), asha);                     // no milestone → silent
mkDl('ROC', istToday, null);                        // unassigned → admins

const notifsFor = (uid) => db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'deadline_reminder'").all(uid);

console.log('Deadline reminders');
processDeadlineReminders(null);

check('assignee is reminded for a due-today deadline', notifsFor(asha).some((x) => x.text.includes('GSTR-3B') && x.text.includes('due today')));
check('assignee is reminded 3 days out', notifsFor(asha).some((x) => x.text.includes('GSTR-1') && x.text.includes('in 3 days')));
check('a deadline 2 days out is not reminded yet', !notifsFor(asha).some((x) => x.text.includes('TDS')));
check('an unassigned filing falls back to admins', notifsFor(admin).some((x) => x.text.includes('ROC')));
check('members are not nudged about someone else’s unassigned filing', !notifsFor(asha).some((x) => x.text.includes('ROC')));

const before = db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='deadline_reminder'").get().n;
processDeadlineReminders(null);
const after = db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='deadline_reminder'").get().n;
check('a second sweep sends nothing new (dedup)', before === after && before > 0);

// Once it slips a day, an overdue nudge goes out (a fresh milestone).
db.prepare('UPDATE client_deadlines SET due_date = ? WHERE id = ?').run(plusDays(-1), dueToday);
processDeadlineReminders(null);
check('an overdue deadline nudges once', notifsFor(asha).some((x) => x.text.includes('Overdue') && x.text.includes('GSTR-3B')));

if (failures) { console.error(`\n${failures} deadline-reminder check(s) FAILED`); process.exit(1); }
console.log('\nAll deadline-reminder tests passed');
process.exit(0);
