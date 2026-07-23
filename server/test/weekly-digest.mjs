/**
 * Weekly "due this week" digest: each assignee gets a Monday summary of their
 * own filings due Mon–Sun, admins get a firm-wide one, and it's sent once per
 * week. Tests sendWeeklyDigest directly with an explicit week (no clock gate).
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'teamhub-wd-'));
process.env.JWT_SECRET = 'test';

const db = (await import('../src/db.js')).default;
const { sendWeeklyDigest } = await import('../src/reminders.js');

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const WEEK_START = '2026-08-03'; // a Monday
const WEEK_END = '2026-08-09';   // the Sunday

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

mkDl('GSTR-3B', '2026-08-05', asha);   // in the week, Asha's
mkDl('GSTR-1', '2026-08-07', asha);    // in the week, Asha's
mkDl('ROC', '2026-08-06', null);       // in the week, unassigned → firm-wide only
mkDl('TDS', '2026-08-15', asha);       // NEXT week → excluded

const digests = (uid) => db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'deadline_digest'").all(uid);

console.log('Weekly digest');
sendWeeklyDigest(null, WEEK_START, WEEK_END);

check('assignee gets one personal digest for the week', digests(asha).length === 1);
check('the personal digest counts only this week’s filings (2, not 3)', digests(asha).some((d) => d.text.includes('2 filings due this week')));
check('the personal digest excludes next week’s filing', !digests(asha).some((d) => d.text.includes('TDS')));
check('admin gets a firm-wide digest', digests(admin).length === 1);
check('the firm-wide digest spans all 3 in-week filings (incl. unassigned)', digests(admin).some((d) => d.text.includes('3 filings due across the firm')));

const before = db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='deadline_digest'").get().n;
sendWeeklyDigest(null, WEEK_START, WEEK_END);
const after = db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='deadline_digest'").get().n;
check('running again the same week sends nothing new (once per week)', before === after && before > 0);

if (failures) { console.error(`\n${failures} weekly-digest check(s) FAILED`); process.exit(1); }
console.log('\nAll weekly-digest tests passed');
process.exit(0);
