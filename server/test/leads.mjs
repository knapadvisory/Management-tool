/**
 * Lead management: keyed public intake from the website, auto follow-up task,
 * new-lead notifications, and the pipeline board CRUD. Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.LEADS_PORT || 3995;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-leads-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'leads-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body, form } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();

  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Advisory Co', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;

  // Admin fetches settings → an intake key is minted, workflows are listed.
  const settings = await req('GET', '/api/leads/settings', { token: a });
  check('settings mint an intake key', settings.status === 200 && !!settings.data.key);
  check('workflows are offered for the auto-task', Array.isArray(settings.data.workflows) && settings.data.workflows.length > 0);
  const key = settings.data.key;
  const wfId = settings.data.workflows[0].id;

  // Point auto-tasks at the default workflow.
  await req('PATCH', '/api/leads/settings', { token: a, body: { task_workflow_id: wfId } });

  // Intake is refused without a valid key.
  const noKey = await req('POST', '/api/leads/intake', { body: { name: 'X' } });
  check('intake without a key is rejected', noKey.status === 400);
  const badKey = await req('POST', '/api/leads/intake?key=nope', { body: { name: 'X' } });
  check('intake with a wrong key is rejected', badKey.status === 403);

  // The website posts a form-encoded enquiry (like the PHP form).
  const intake = await req('POST', `/api/leads/intake?key=${encodeURIComponent(key)}`, {
    form: { name: 'Varun', email: 'varun.krrish@gmail.com', phone: '9560936794', message: 'How much to close a CG account?' },
  });
  check('a website enquiry is accepted (form-encoded)', intake.status === 200 && intake.data.ok === true);

  // It shows on the board, with a follow-up task auto-created.
  const list = await req('GET', '/api/leads', { token: a });
  check('the lead appears on the board', list.data.leads.length === 1 && list.data.leads[0].name === 'Varun');
  const lead = list.data.leads[0];
  check('source is website', lead.source === 'website');
  check('a follow-up task was auto-created and linked', !!lead.task_id);
  check('new lead starts in the "new" column', lead.status === 'new');

  // The admin was notified.
  const notifs = await req('GET', '/api/notifications', { token: a });
  check('admin got a new-lead notification', (notifs.data.notifications || notifs.data || []).some((n) => n.type === 'lead'));

  // Move it along the pipeline + assign an owner.
  const ownerId = owner.data.user.id;
  const moved = await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { status: 'qualified', owner_id: ownerId } });
  check('status + owner update', moved.data.lead.status === 'qualified' && moved.data.lead.owner_id === ownerId);
  const bad = await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { status: 'banana' } });
  check('an invalid status is rejected', bad.status === 400);

  // Rotating the key invalidates the old one.
  const rotated = await req('POST', '/api/leads/settings/key', { token: a });
  check('the key can be rotated', rotated.data.key && rotated.data.key !== key);
  const oldKey = await req('POST', `/api/leads/intake?key=${encodeURIComponent(key)}`, { body: { name: 'Y' } });
  check('the old key stops working after rotation', oldKey.status === 403);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll leads tests passed');
    process.exit(failures ? 1 : 0);
  });
