/**
 * Compliance automation — document-request auto-chase. The hourly sweep chases
 * a client whose requested document is still pending: a nudge 2 days out and on
 * the due day, then a firmer chase every 3rd day once overdue — each an FYI to
 * the requesting staff, never double-sent, and suppressed when a workspace
 * turns auto-chase off. Driven by importing the scheduler against a temp DB.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'teamhub-chase-'));
process.env.JWT_SECRET = 'test';

const db = (await import('../src/db.js')).default;
const { setSetting } = await import('../src/db.js');
const { processDocumentRequestChases } = await import('../src/reminders.js');

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

// The sweep works in IST — mirror that when building test dates.
const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plusDays = (n) => new Date(new Date(istToday + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

const ws = db.prepare("INSERT INTO workspaces (name, slug) VALUES ('Firm', 'firm')").run().lastInsertRowid;
const admin = db.prepare(
  `INSERT INTO users (name, email, password_hash, avatar_color, role, active, approved, deleted, workspace_id)
   VALUES ('Admin', 'admin@f.test', 'x', '#000', 'admin', 1, 1, 0, ?)`,
).run(ws).lastInsertRowid;
const client = db.prepare("INSERT INTO clients (name, workspace_id, created_by) VALUES ('Acme', ?, ?)").run(ws, admin).lastInsertRowid;

const mkReq = (title, due) => db.prepare(
  "INSERT INTO document_requests (client_id, workspace_id, title, due_date, status, requested_by) VALUES (?, ?, ?, ?, 'pending', ?)",
).run(client, ws, title, due, admin).lastInsertRowid;

const dueToday = mkReq('Bank statements', istToday);   // day-of → chase
mkReq('PAN copy', plusDays(2));                        // T-2 → chase
mkReq('Rent agreement', plusDays(5));                  // far off → silent
const received = mkReq('GST invoices', plusDays(-1));  // overdue but already received → silent
db.prepare("UPDATE document_requests SET status = 'received' WHERE id = ?").run(received);

const chases = () => db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'doc_request_chase'").all(admin);

console.log('Document-request auto-chase');
processDocumentRequestChases(null);

check('a request due today is chased', chases().some((x) => x.text.includes('Bank statements') && x.text.includes('due today')));
check('a request due in 2 days is chased', chases().some((x) => x.text.includes('PAN copy') && x.text.includes('in 2 days')));
check('a request due far out is not chased yet', !chases().some((x) => x.text.includes('Rent agreement')));
check('an already-received request is never chased', !chases().some((x) => x.text.includes('GST invoices')));

const before = chases().length;
processDocumentRequestChases(null);
check('a second sweep chases nothing new (dedup)', chases().length === before && before > 0);

// Once it slips a day overdue, a firmer chase goes out (a fresh milestone).
db.prepare('UPDATE document_requests SET due_date = ? WHERE id = ?').run(plusDays(-1), dueToday);
processDocumentRequestChases(null);
check('an overdue request is chased again', chases().some((x) => x.text.includes('Bank statements') && x.text.includes('overdue')));

// A workspace can switch auto-chase off — no further chases fire.
setSetting(`autochase_enabled:${ws}`, '0');
const offBefore = chases().length;
db.prepare('UPDATE document_requests SET due_date = ? WHERE id = ?').run(plusDays(-4), dueToday); // would be a new milestone
processDocumentRequestChases(null);
check('turning auto-chase off suppresses chasing', chases().length === offBefore);

if (failures) { console.error(`\n${failures} auto-chase check(s) FAILED`); process.exit(1); }
console.log('\nAll auto-chase tests passed');
process.exit(0);
