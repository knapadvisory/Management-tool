/**
 * WhatsApp task bot: config + webhook verification, inbound command parsing
 * (create / list / done), number linking, unknown-sender handling and dedupe.
 * Runs the real server in WA_DRY_RUN so outbound is captured, not sent.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WA_PORT || 3992;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-wa-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'wa-secret', WORKSPACE_SIGNUP_CODE: 'boot', WA_DRY_RUN: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await sleep(200); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const PNID = '109999';
function inbound(from, text, id) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'E', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000', phone_number_id: PNID },
    messages: [{ from, id, timestamp: '1', type: 'text', text: { body: text } }],
  } }] }] };
}
async function send(from, text, id) {
  await req('POST', '/api/whatsapp/webhook', { body: inbound(from, text, id) });
  await sleep(150); // webhook acks then processes async
}
async function outbox() { return (await req('GET', '/api/whatsapp/_outbox')).data.outbox || []; }

async function main() {
  await waitForServer();
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Advisory Co', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;
  const wfs = await req('GET', '/api/workflows', { token: a });
  const wfId = wfs.data.workflows[0].id;

  // Configure the Cloud API connection.
  await req('PUT', '/api/whatsapp/config', { token: a, body: { phone_number_id: PNID, access_token: 'EAA-test', enabled: true, task_workflow_id: wfId } });
  const cfg = await req('GET', '/api/whatsapp/config', { token: a });
  check('config saves and hides the token', cfg.data.enabled && cfg.data.phone_number_id === PNID && cfg.data.has_token === true && !('access_token' in cfg.data));
  check('a webhook URL and verify token are provided', cfg.data.webhook_url.endsWith('/api/whatsapp/webhook') && !!cfg.data.verify_token);
  const verify = cfg.data.verify_token;

  // Meta verification handshake.
  const good = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=chal123`);
  check('webhook verification echoes the challenge', good.status === 200 && (await good.text()) === 'chal123');
  const bad = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  check('webhook verification rejects a wrong token', bad.status === 403);

  // Link numbers: Ann (self) and Ravi (by admin).
  await req('PUT', '/api/whatsapp/me', { token: a, body: { whatsapp_number: '+91 98123 00001' } });
  await req('POST', '/api/admin/users', { token: a, body: { name: 'Ravi', email: 'ravi@a.test', password: 'secret123', role: 'member' } });
  const ravi = (await req('POST', '/api/auth/login', { body: { email: 'ravi@a.test', password: 'secret123' } })).data;
  await req('PUT', `/api/whatsapp/users/${ravi.user.id}`, { token: a, body: { whatsapp_number: '919812300002' } });

  // Ann messages the bot to create a task assigned to Ravi, due tomorrow.
  await send('919812300001', 'task Call Sharma about GST tomorrow @ravi', 'wamid.1');
  const tasks = await req('GET', '/api/tasks', { token: a });
  const t = (tasks.data.tasks || tasks.data || []).find((x) => x.title.startsWith('Call Sharma'));
  check('a task is created from a WhatsApp message', !!t);
  check('the task is assigned to the named teammate', t && t.assignee_id === ravi.user.id);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  check('the due date is parsed', t && t.due_date === tomorrow);
  const ob1 = await outbox();
  check('the sender gets a confirmation reply', ob1.some((m) => m.to === '919812300001' && /created/i.test(m.text)));
  check('the assignee gets a WhatsApp nudge', ob1.some((m) => m.to === '919812300002' && /assigned/i.test(m.text)));

  // Ravi lists his tasks, then completes it.
  await send('919812300002', 'my tasks', 'wamid.2');
  check('“my tasks” lists the assignee’s task', (await outbox()).some((m) => m.to === '919812300002' && m.text.includes(String(t.id)) && m.text.includes('Call Sharma')));
  await send('919812300002', `done ${t.id}`, 'wamid.3');
  const after = await req('GET', '/api/tasks', { token: a });
  const doneTask = (after.data.tasks || after.data || []).find((x) => x.id === t.id);
  check('“done <id>” completes the task', doneTask && doneTask.status === 'completed');

  // Unknown number is turned away; duplicate message ids are ignored.
  await send('910000000000', 'task hello', 'wamid.4');
  check('an unlinked number is told to link', (await outbox()).some((m) => m.to === '910000000000' && /link/i.test(m.text)));
  const before = (await req('GET', '/api/tasks', { token: a })).data.tasks.length;
  await send('919812300001', 'task Duplicate check', 'wamid.5');
  await send('919812300001', 'task Duplicate check', 'wamid.5'); // same id → ignored
  const count = (await req('GET', '/api/tasks', { token: a })).data.tasks.filter((x) => x.title === 'Duplicate check').length;
  check('a repeated message id is processed only once', count === 1);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll WhatsApp tests passed');
    process.exit(failures ? 1 : 0);
  });
