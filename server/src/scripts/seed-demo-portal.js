/**
 * Seed a self-contained CLIENT-PORTAL DEMO for showcasing to a prospect.
 *
 * Creates (or refreshes) a demo client with a pre-revenue manufacturing budget
 * (Actual-vs-Budget), a few statutory filings, open document requests and a
 * message thread, plus a portal login — then prints a 30-day sign-in link.
 *
 * Run it inside the running server (its DB + JWT secret are already in scope):
 *
 *   docker exec teamhub node src/scripts/seed-demo-portal.js
 *   docker exec teamhub node src/scripts/seed-demo-portal.js <workspaceId> <baseUrl>
 *
 * Re-running it wipes and rebuilds the demo cleanly, so the link and data stay
 * consistent. It never touches any other client's data.
 */
import jwt from 'jsonwebtoken';
import db from '../db.js';
import { JWT_SECRET } from '../auth.js';
import { createBudget, seedDemoManufacturing } from '../budgets.js';

const args = process.argv.slice(2);
const wsArg = args.find((a) => /^\d+$/.test(a));
const baseArg = args.find((a) => /^https?:\/\//.test(a));
const BASE = (baseArg || process.env.APP_URL || 'https://dashboard.knapadvisory.com').replace(/\/$/, '');

const DEMO_CLIENT = 'Acme Robotics (Demo)';
const DEMO_EMAIL = 'demo.client@knapadvisory.com';
const DEMO_NAME = 'Riya Menon';

const ws = wsArg
  ? db.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(wsArg))
  : db.prepare('SELECT * FROM workspaces ORDER BY id LIMIT 1').get();
if (!ws) { console.error('No workspace found. Pass a workspace id as the first argument.'); process.exit(1); }

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => ymd(new Date(Date.now() + n * 86400000));

const run = db.transaction(() => {
  // 1. Demo client (reuse by name so re-runs are idempotent).
  let client = db.prepare('SELECT * FROM clients WHERE workspace_id = ? AND name = ?').get(ws.id, DEMO_CLIENT);
  if (!client) {
    const info = db.prepare("INSERT INTO clients (name, type, status, notes, email) VALUES (?, 'company', 'active', ?, '')")
      .run(DEMO_CLIENT, 'Pre-revenue manufacturing startup developing its first product. Demo account.');
    client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  }
  const cid = client.id;

  // Clean the demo client's own data so a re-run rebuilds it exactly.
  db.prepare('DELETE FROM budgets WHERE client_id = ?').run(cid);
  db.prepare('DELETE FROM client_deadlines WHERE client_id = ?').run(cid);
  db.prepare('DELETE FROM document_requests WHERE client_id = ?').run(cid);
  db.prepare('DELETE FROM portal_messages WHERE client_id = ?').run(cid);

  // 2. Budget with the manufacturing demo dataset, dated to the current FY,
  //    with actuals filled up to the current month.
  const now = new Date();
  const fyYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const fyStart = `${fyYear}-04`;
  const elapsed = Math.max(1, Math.min(12, (now.getUTCFullYear() - fyYear) * 12 + (now.getUTCMonth() - 3) + 1));
  const budgetId = createBudget(ws.id, { client_id: cid, name: `FY ${fyYear}-${String((fyYear + 1) % 100).padStart(2, '0')} · Product Development Budget`, fy_start: fyStart, months: 12, created_by: null, demo: false });
  seedDemoManufacturing(budgetId, { elapsed });

  // 3. A few statutory filings (some filed, some upcoming/overdue).
  const insDeadline = db.prepare("INSERT INTO client_deadlines (client_id, title, due_date, recurrence, completed) VALUES (?, ?, ?, ?, ?)");
  insDeadline.run(cid, 'GST return — GSTR-3B', addDays(9), 'monthly', 0);
  insDeadline.run(cid, 'TDS payment (Q current)', addDays(-3), 'quarterly', 0);   // overdue, for contrast
  insDeadline.run(cid, 'Provisional patent — status review', addDays(40), 'none', 0);
  insDeadline.run(cid, 'Startup India recognition', addDays(-30), 'none', 1);      // filed

  // 4. Open document requests the client would answer from the portal.
  const insReq = db.prepare("INSERT INTO document_requests (client_id, workspace_id, title, note, due_date, status) VALUES (?, ?, ?, ?, ?, 'pending')");
  insReq.run(cid, ws.id, 'Latest bank statement', 'For the cash-flow review.', addDays(7));
  insReq.run(cid, ws.id, 'Equipment purchase invoices', 'To capitalise the tooling spend correctly.', addDays(10));
  insReq.run(cid, ws.id, 'Updated cap table', 'Ahead of the next funding round.', addDays(14));

  // 5. A short message thread so the portal looks lived-in.
  const insMsg = db.prepare("INSERT INTO portal_messages (client_id, workspace_id, sender, author_name, body) VALUES (?, ?, ?, ?, ?)");
  insMsg.run(cid, ws.id, 'staff', 'Your Advisor', `Hi ${DEMO_NAME.split(' ')[0]} — we've loaded your product-development budget. Open the Budget tab to see spend vs plan for the year so far.`);
  insMsg.run(cid, ws.id, 'client', DEMO_NAME, 'Thanks! This is exactly the visibility we needed. Reviewing the R&D and tooling lines now.');

  // 6. Portal login (reuse by email).
  let pu = db.prepare('SELECT * FROM portal_users WHERE client_id = ? AND lower(email) = ?').get(cid, DEMO_EMAIL);
  if (pu) {
    db.prepare("UPDATE portal_users SET active = 1, name = ? WHERE id = ?").run(DEMO_NAME, pu.id);
  } else {
    const info = db.prepare('INSERT INTO portal_users (client_id, workspace_id, name, email) VALUES (?, ?, ?, ?)')
      .run(cid, ws.id, DEMO_NAME, DEMO_EMAIL);
    pu = db.prepare('SELECT * FROM portal_users WHERE id = ?').get(info.lastInsertRowid);
  }
  return { pu, budgetId, cid };
});

const { pu } = run();

// A 30-day sign-in link so the prospect can explore the demo at their leisure
// (the normal magic link lasts 45 minutes; this one is meant for a showcase).
const magic = jwt.sign({ pid: pu.id, purpose: 'portal-magic' }, JWT_SECRET, { expiresIn: '30d' });
const link = `${BASE}/portal?token=${magic}`;

console.log('\n✅ Demo client portal is ready.\n');
console.log(`   Workspace   : ${ws.name} (id ${ws.id})`);
console.log(`   Demo client : ${DEMO_CLIENT}`);
console.log(`   Login as    : ${DEMO_NAME} <${DEMO_EMAIL}>`);
console.log('\n🔗 Share this sign-in link (valid 30 days):\n');
console.log(`   ${link}\n`);
console.log('   It opens the client portal straight into their dashboard — no password.');
console.log('   Re-run this script any time to refresh the demo (and get a new link).\n');
