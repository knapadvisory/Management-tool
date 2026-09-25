/**
 * Budgeting + Actual-vs-Budget: create a client budget, seed the manufacturing
 * demo, edit lines/cells, and read the report — both staff-side and read-only
 * through the client portal.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BUDGET_PORT || 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-budget-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'budget-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'MakerLabs', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;

  const client = await req('POST', '/api/clients', { token: a, body: { name: 'Acme Robotics (Pre-launch)' } });
  const clientId = client.data.id;
  check('a client can be created', client.status === 201 && !!clientId);

  // Create a budget with the manufacturing demo dataset.
  const made = await req('POST', '/api/budgets', { token: a, body: { name: 'FY 2026-27 Product Build', client_id: clientId, fy_start: '2026-04', months: 12, demo: true } });
  const rep = made.data;
  check('a demo budget is created with lines', made.status === 201 && rep.lines.length > 10);
  check('the report spans 12 months', rep.period.length === 12);
  check('the demo has budgeted spend', rep.totals.budget > 0);
  check('the demo has actuals recorded (YTD)', rep.totals.actual > 0);
  check('the variance equals budget minus actual', Math.abs(rep.totals.variance - (rep.totals.budget - rep.totals.actual)) < 0.01);
  check('capex is tracked apart from operating expense', rep.totals.by_kind.capex.budget > 0 && rep.totals.by_kind.expense.budget > 0);
  check('a nominal revenue line exists (pre-revenue)', rep.totals.by_kind.revenue.budget > 0);
  check('sections group the lines (R&D, Capex, …)', rep.sections.some((s) => /Research/.test(s.name)) && rep.sections.some((s) => /Capex/.test(s.name)));
  check('a monthly trend is returned', Array.isArray(rep.totals.monthly) && rep.totals.monthly.length === 12);
  const budgetId = rep.budget.id;

  // Actuals should only be filled for the elapsed months (YTD), not the whole year.
  const filledMonths = rep.totals.monthly.filter((m) => m.actual > 0).length;
  check('actuals stop at the year-to-date point', filledMonths > 0 && filledMonths < 12);

  // Add a custom line and set one of its cells.
  const withLine = await req('POST', `/api/budgets/${budgetId}/lines`, { token: a, body: { category: 'Contingency', section: 'Operations', kind: 'expense' } });
  const contingency = withLine.data.lines.find((l) => l.category === 'Contingency');
  check('a custom line can be added', withLine.status === 201 && !!contingency);
  const firstMonth = rep.period[0].key;
  const cellSet = await req('PUT', `/api/budgets/${budgetId}/cell`, { token: a, body: { line_id: contingency.id, month: firstMonth, budget: 25000, actual: 12000 } });
  const cLine = cellSet.data.lines.find((l) => l.id === contingency.id);
  check('a cell budget/actual can be set', cLine.total_budget === 25000 && cLine.total_actual === 12000);

  // A cell outside the budget's months is rejected.
  const badCell = await req('PUT', `/api/budgets/${budgetId}/cell`, { token: a, body: { line_id: contingency.id, month: '2099-01', budget: 1 } });
  check('a cell outside the period is rejected', badCell.status === 400);

  // Listing budgets for the client.
  const list = await req('GET', `/api/budgets?client_id=${clientId}`, { token: a });
  check('budgets list for a client', list.status === 200 && list.data.budgets.some((b) => b.id === budgetId));

  // --- Client portal: read-only Actual-vs-Budget ---
  const invite = await req('POST', `/api/clients/${clientId}/portal-invite`, { token: a, body: { email: 'ceo@acme.test', name: 'Riya' } });
  const magic = new URL(invite.data.link).searchParams.get('token');
  const sess = await req('POST', '/api/portal/login', { body: { token: magic } });
  const ptoken = sess.data.token;
  check('a client can sign in to the portal', sess.status === 200 && !!ptoken);
  const prep = await req('GET', '/api/portal/budget', { token: ptoken });
  check('the portal serves the budget report', prep.status === 200 && prep.data.report && prep.data.report.budget.id === budgetId);
  check('the portal report carries the totals', prep.data.report.totals.budget > 0 && prep.data.report.totals.actual > 0);

  // A brand-new client with no budget returns null (portal shows an empty state).
  const client2 = await req('POST', '/api/clients', { token: a, body: { name: 'No Budget Co' } });
  const inv2 = await req('POST', `/api/clients/${client2.data.id}/portal-invite`, { token: a, body: { email: 'x@nobudget.test' } });
  const sess2 = await req('POST', '/api/portal/login', { body: { token: new URL(inv2.data.link).searchParams.get('token') } });
  const empty = await req('GET', '/api/portal/budget', { token: sess2.data.token });
  check('a client with no budget gets an empty report', empty.status === 200 && empty.data.report === null);

  // Only an admin can delete a budget.
  const del = await req('DELETE', `/api/budgets/${budgetId}`, { token: a });
  check('an admin can delete a budget', del.status === 200 && del.data.ok === true);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll budget tests passed');
    process.exit(failures ? 1 : 0);
  });
