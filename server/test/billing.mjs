/**
 * Billing & Payment automation: completing a task offers to raise an invoice,
 * which spawns a task on the configured board, assigned to the responsible
 * teammate at High priority, with the previous owner kept in the loop.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BILLING_PORT || 3993;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-billing-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'billing-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
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
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Advisory Co', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const admin = owner.data.token;

  // The default board (has a Done stage) and a dedicated Billing & Payment board.
  const wfs = await req('GET', '/api/workflows', { token: admin });
  const mainWf = wfs.data.workflows[0];
  const billing = await req('POST', '/api/workflows', { token: admin, body: { name: 'Billing & Payment', stages: ['To raise', 'Invoiced', 'Paid'] } });
  const billingWfId = billing.data.id;

  // Two teammates: Sam does the work, Riya is responsible for invoicing.
  const samU = await req('POST', '/api/admin/users', { token: admin, body: { name: 'Sam', email: 'sam@a.test', password: 'secret123', role: 'member' } });
  const samId = samU.data.id;
  const riyaU = await req('POST', '/api/admin/users', { token: admin, body: { name: 'Riya', email: 'riya@a.test', password: 'secret123', role: 'member' } });
  const riyaId = riyaU.data.id;
  const sam = (await req('POST', '/api/auth/login', { body: { email: 'sam@a.test', password: 'secret123' } })).data.token;
  const riya = (await req('POST', '/api/auth/login', { body: { email: 'riya@a.test', password: 'secret123' } })).data.token;

  // Only an admin may set the rules.
  const forbidden = await req('GET', '/api/tasks/billing/settings', { token: sam });
  check('a member cannot read the billing rules', forbidden.status === 403);

  // Turning it on without a board is rejected.
  const noBoard = await req('PATCH', '/api/tasks/billing/settings', { token: admin, body: { enabled: true } });
  check('enabling with no board chosen is rejected', noBoard.status === 400);

  // Configure the rules.
  const set = await req('PATCH', '/api/tasks/billing/settings', { token: admin, body: { enabled: true, workflow_id: billingWfId, assignee_id: riyaId, priority: 'high' } });
  check('the admin can save the billing rules', set.status === 200 && set.data.enabled === true && set.data.workflow_id === billingWfId && set.data.assignee_id === riyaId && set.data.priority === 'high');

  // A task Sam owns.
  const created = await req('POST', '/api/tasks', { token: admin, body: { title: 'GST filing for Acme', workflow_id: mainWf.id, assignee_ids: [samId] } });
  const taskId = created.data.id;
  check('the task is created and owned by Sam', created.status === 201 && created.data.assignee?.id === samId);

  // Sam completes it → the completer is prompted to raise an invoice.
  const done = await req('PATCH', `/api/tasks/${taskId}`, { token: sam, body: { status: 'completed' } });
  check('completing a task asks whether to raise an invoice', done.status === 200 && done.data.invoice_prompt === true);

  // Sam says Yes → the invoice task is raised on the Billing board.
  const raised = await req('POST', `/api/tasks/${taskId}/raise-invoice`, { token: sam });
  const inv = raised.data.task;
  check('an invoice task is created', raised.status === 200 && !!inv?.id);
  check('the invoice task is on the Billing & Payment board', inv && inv.workflow_id === billingWfId);
  check('the invoice task is assigned to the responsible teammate', inv && inv.assignee?.id === riyaId);
  check('the invoice task is High priority by default', inv && inv.priority === 'high');
  check('the invoice task links back to the source task', inv && inv.source_task?.id === taskId);
  check('the invoice task title names the source', inv && /Raise invoice/.test(inv.title));

  // The previous owner (Sam) is kept in the loop as a watcher.
  const invFull = await req('GET', `/api/tasks/${inv.id}`, { token: admin });
  const watcherIds = (invFull.data.watchers || []).map((w) => w.id);
  check('the previous task owner is kept in the loop', watcherIds.includes(samId));
  check('the responsible teammate watches it too', watcherIds.includes(riyaId));

  // Saying Yes again doesn't create a second invoice task.
  const again = await req('POST', `/api/tasks/${taskId}/raise-invoice`, { token: sam });
  check('raising an invoice twice is de-duplicated', again.data.already === true && again.data.task?.id === inv.id);

  // Completing the invoice task itself must not prompt for another invoice.
  const invDone = await req('PATCH', `/api/tasks/${inv.id}`, { token: riya, body: { status: 'completed' } });
  check('completing an invoice task does not loop', invDone.status === 200 && !invDone.data.invoice_prompt);

  // With automation off, completion no longer prompts.
  await req('PATCH', '/api/tasks/billing/settings', { token: admin, body: { enabled: false } });
  const t2 = await req('POST', '/api/tasks', { token: admin, body: { title: 'ROC filing', workflow_id: mainWf.id, assignee_ids: [samId] } });
  const d2 = await req('PATCH', `/api/tasks/${t2.data.id}`, { token: sam, body: { status: 'completed' } });
  check('no prompt when billing automation is off', d2.status === 200 && !d2.data.invoice_prompt);
  const blocked = await req('POST', `/api/tasks/${t2.data.id}/raise-invoice`, { token: sam });
  check('raising an invoice is refused while automation is off', blocked.status === 400);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll billing tests passed');
    process.exit(failures ? 1 : 0);
  });
