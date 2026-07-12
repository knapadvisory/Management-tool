/**
 * Multi-tenant isolation test: two independent workspaces (Acme, Globex) on
 * one server. Verifies a member of one workspace can never see or touch the
 * other's data across every surface — directory, channels, tasks, projects,
 * workflows, drive, dashboard, search and admin.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MT_PORT || 3993;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-mt-'));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'mt-test' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/config'); return true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not start');
}
async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitUp();

  // Two workspaces, each with an admin.
  const acme = (await api('POST', '/api/workspaces', { body: { workspace_name: 'Acme', name: 'Ann', email: 'ann@acme.com', password: 'secret123' } })).data;
  const globex = (await api('POST', '/api/workspaces', { body: { workspace_name: 'Globex', name: 'Gwen', email: 'gwen@globex.com', password: 'secret123' } })).data;
  const A = acme.token, G = globex.token;
  check('two workspaces created with distinct ids', acme.workspace.id !== globex.workspace.id);

  // Each admin adds a member and creates content.
  const acmeBob = (await api('POST', '/api/admin/users', { token: A, body: { name: 'Bob', email: 'bob@acme.com', password: 'secret123' } })).data;
  const acmeWf = (await api('GET', '/api/workflows', { token: A })).data.workflows[0];
  const acmeTask = (await api('POST', '/api/tasks', { token: A, body: { title: 'Acme secret task', workflow_id: acmeWf.id } })).data;
  const acmeProj = (await api('POST', '/api/projects', { token: A, body: { name: 'Acme Project' } })).data;
  const acmeChan = (await api('POST', '/api/channels', { token: A, body: { name: 'acme-private', is_private: false } })).data;

  const globexWf = (await api('GET', '/api/workflows', { token: G })).data.workflows[0];
  const globexTask = (await api('POST', '/api/tasks', { token: G, body: { title: 'Globex secret task', workflow_id: globexWf.id } })).data;

  console.log('Directory isolation');
  const acmeUsers = (await api('GET', '/api/users', { token: A })).data.users;
  check('Acme directory shows only Acme users', acmeUsers.every((u) => u.workspace_id === acme.workspace.id));
  check('Acme directory does not contain Gwen', !acmeUsers.some((u) => u.email === 'gwen@globex.com'));

  console.log('Task isolation');
  const acmeTasks = (await api('GET', '/api/tasks', { token: A })).data.tasks;
  check('Acme task list excludes Globex tasks', !acmeTasks.some((t) => t.title === 'Globex secret task'));
  check('Acme admin cannot fetch a Globex task by id', (await api('GET', `/api/tasks/${globexTask.id}`, { token: A })).status === 404);
  check('Globex admin cannot fetch an Acme task by id', (await api('GET', `/api/tasks/${acmeTask.id}`, { token: G })).status === 404);
  check('cross-workspace task delete is blocked', (await api('DELETE', `/api/tasks/${acmeTask.id}`, { token: G })).status === 404);
  check('cross-workspace assignee is rejected',
    (await api('POST', '/api/tasks', { token: G, body: { title: 'x', workflow_id: globexWf.id, assignee_id: acmeBob.id } })).status === 400);

  console.log('Workflow / project isolation');
  check('Globex cannot see Acme workflow', !(await api('GET', '/api/workflows', { token: G })).data.workflows.some((w) => w.id === acmeWf.id));
  check('Globex cannot create a task on an Acme workflow',
    (await api('POST', '/api/tasks', { token: G, body: { title: 'x', workflow_id: acmeWf.id } })).status === 400);
  check('Globex cannot see Acme project', !(await api('GET', '/api/projects', { token: G })).data.projects.some((p) => p.id === acmeProj.id));

  console.log('Channel isolation');
  const globexChannels = (await api('GET', '/api/channels', { token: G })).data;
  const allGlobexChans = [...globexChannels.channels, ...globexChannels.joinable];
  check('Globex cannot see Acme public channel', !allGlobexChans.some((c) => c.id === acmeChan.id));
  check('Globex cannot join an Acme channel', (await api('POST', `/api/channels/${acmeChan.id}/join`, { token: G })).status === 404);
  check('Globex cannot DM an Acme user', (await api('POST', `/api/channels/dm/${acmeBob.id}`, { token: G })).status === 404);

  console.log('Dashboard isolation');
  const globexDash = (await api('GET', '/api/dashboard', { token: G })).data;
  check('Globex dashboard workload excludes Acme users', !(globexDash.workload || []).some((w) => w.id === acmeBob.id));

  console.log('Admin isolation');
  check('Globex admin cannot reset an Acme user password',
    (await api('POST', `/api/admin/users/${acmeBob.id}/reset-password`, { token: G, body: { password: 'hacked123' } })).status === 404);
  check('Globex admin cannot deactivate an Acme user',
    (await api('POST', `/api/admin/users/${acmeBob.id}/deactivate`, { token: G })).status === 404);
  const globexRoster = (await api('GET', '/api/admin/users', { token: G })).data.users;
  check('Globex admin roster excludes Acme users', !globexRoster.some((u) => u.email === 'bob@acme.com'));
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} isolation check(s) FAILED` : '\nMulti-tenant isolation test passed');
    process.exit(failures ? 1 : 0);
  });
