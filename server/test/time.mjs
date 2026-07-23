/**
 * Timesheets: running timer, manual entries, summary, per-task/client rollup,
 * and the admin report. Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TIME_PORT || 3991;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-time-'));
let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };
const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'time-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() { for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } } throw new Error('no boot'); }
async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  await waitForServer();
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Time Co', name: 'Alice', email: 'a@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token; const slug = owner.data.workspace.slug;
  await req('POST', `/api/workspaces/${slug}/register`, { body: { name: 'Bob', email: 'b@b.test', password: 'secret123' } });
  const bobId = (await req('GET', '/api/admin/users/pending', { token: a })).data.users.find((u) => u.email === 'b@b.test').id;
  await req('POST', `/api/admin/users/${bobId}/approve`, { token: a });
  const b = (await req('POST', '/api/auth/login', { body: { email: 'b@b.test', password: 'secret123' } })).data.token;
  const wf = (await req('GET', '/api/workflows', { token: a })).data.workflows[0];
  const client = await req('POST', '/api/clients', { token: a, body: { name: 'Acme Pvt Ltd' } });
  const task = await req('POST', '/api/tasks', { token: a, body: { title: 'File GST', workflow_id: wf.id, client_id: client.data.id, assignee_ids: [bobId] } });
  const taskId = task.data.id;

  console.log('Timer');
  const start = await req('POST', '/api/time/start', { token: b, body: { task_id: taskId, description: 'working' } });
  check('a timer can be started against a task', start.status === 201 && start.data.running.is_running && start.data.running.task?.id === taskId);
  check('time logged on a task rolls up to its client', start.data.running.client?.id === client.data.id);
  const running = await req('GET', '/api/time/running', { token: b });
  check('the running timer is reported', running.data.running && running.data.running.id === start.data.running.id);
  const start2 = await req('POST', '/api/time/start', { token: b, body: { task_id: taskId } });
  check('starting a second timer replaces the first (one per user)', start2.status === 201 && start2.data.running.id !== start.data.running.id);
  const stillOne = await req('GET', '/api/time', { token: b });
  check('the earlier timer was stopped, not left running', stillOne.data.entries.filter((e) => e.is_running).length === 1);
  const stop = await req('POST', '/api/time/stop', { token: b });
  check('the timer can be stopped', stop.status === 200 && !stop.data.entry.is_running);
  const noRun = await req('POST', '/api/time/stop', { token: b });
  check('stopping with no timer is a clean error', noRun.status === 400);

  console.log('Manual entries');
  const manual = await req('POST', '/api/time', { token: b, body: { task_id: taskId, minutes: 90, description: 'review', entry_date: today() } });
  check('time can be logged manually', manual.status === 201 && manual.data.entry.minutes === 90);
  const noMin = await req('POST', '/api/time', { token: b, body: { task_id: taskId, minutes: 0 } });
  check('a manual entry needs minutes', noMin.status === 400);
  const edited = await req('PATCH', `/api/time/${manual.data.entry.id}`, { token: b, body: { minutes: 120, billable: false } });
  check('an entry can be edited', edited.data.entry.minutes === 120 && edited.data.entry.billable === false);
  const bobCantEditAlice = await req('POST', '/api/time', { token: a, body: { task_id: taskId, minutes: 30 } });
  const aliceEntryId = bobCantEditAlice.data.entry.id;
  const forbidden = await req('DELETE', `/api/time/${aliceEntryId}`, { token: b });
  check('a user cannot delete a teammate’s entry', forbidden.status === 403);

  console.log('Summary + rollups');
  const summary = await req('GET', '/api/time/summary', { token: b });
  check('summary totals today’s minutes', summary.data.today >= 120);
  const taskDetail = await req('GET', `/api/tasks/${taskId}`, { token: b });
  check('task detail carries a time total + entries', taskDetail.data.time.total_minutes >= 120 && taskDetail.data.time.entries.length >= 1);
  const clientDetail = await req('GET', `/api/clients/${client.data.id}`, { token: a });
  check('client detail rolls up time from its tasks', clientDetail.data.time.total_minutes >= 120);

  console.log('Admin report');
  const report = await req('GET', '/api/time/report', { token: a });
  check('admin report lists hours per employee', report.data.by_user.some((u) => u.id === bobId && u.minutes >= 120));
  check('admin report lists hours per client', report.data.by_client.some((c) => c.id === client.data.id && c.minutes >= 120));
  const memberReport = await req('GET', '/api/time/report', { token: b });
  check('a member cannot see the firm-wide report', memberReport.status === 403);

  console.log('Dashboard wiring');
  const dash = await req('GET', '/api/dashboard', { token: b });
  check('dashboard reports the caller’s hours', dash.data.hours && dash.data.hours.today >= 120);
  const adminDash = await req('GET', '/api/dashboard', { token: a });
  check('dashboard resource performance shows hours per person (admin)', Array.isArray(adminDash.data.resource_performance) && adminDash.data.resource_performance.some((r) => r.id === bobId));
}
main().catch((e) => { console.error('FATAL', e); failures++; }).finally(() => { server.kill(); rmSync(dataDir, { recursive: true, force: true }); console.log(failures ? `\n${failures} FAILED` : '\nAll time tests passed'); process.exit(failures ? 1 : 0); });
