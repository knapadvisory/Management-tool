/**
 * Signup-gate test for the multi-tenant model:
 *  - Workspace CREATION can be gated by a global WORKSPACE_SIGNUP_CODE.
 *  - Joining a workspace is gated by that workspace's allowed email domains.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

function boot(port, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'teamhub-gate-'));
  const proc = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, JWT_SECRET: 'gate-test', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { proc, dir };
}
async function waitUp(base) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/config'); return true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
}
async function jpost(base, url, body, token) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function jpatch(base, url, body, token) {
  const res = await fetch(base + url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  // --- Workspace creation gated by a global code ---
  const gated = boot(4620, { WORKSPACE_SIGNUP_CODE: 'letmein' });
  const gBase = 'http://localhost:4620';
  check('gated server starts', await waitUp(gBase));
  const cfg = await (await fetch(gBase + '/api/config')).json();
  check('config advertises workspace code required', cfg.workspace_signup_code_required === true);
  check('create workspace without code is rejected',
    (await jpost(gBase, '/api/workspaces', { workspace_name: 'X', name: 'A', email: 'a@x.co', password: 'secret123' })).status === 403);
  check('create workspace with wrong code is rejected',
    (await jpost(gBase, '/api/workspaces', { workspace_name: 'X', name: 'A', email: 'a@x.co', password: 'secret123', code: 'nope' })).status === 403);
  check('create workspace with correct code succeeds',
    (await jpost(gBase, '/api/workspaces', { workspace_name: 'X', name: 'A', email: 'a@x.co', password: 'secret123', code: 'letmein' })).status === 201);
  gated.proc.kill();
  rmSync(gated.dir, { recursive: true, force: true });

  // --- Open creation + per-workspace domain-gated joining ---
  const open = boot(4621, {});
  const oBase = 'http://localhost:4621';
  check('open server starts', await waitUp(oBase));
  const cfg2 = await (await fetch(oBase + '/api/config')).json();
  check('config advertises no workspace code required', cfg2.workspace_signup_code_required === false);

  const ws = await jpost(oBase, '/api/workspaces', { workspace_name: 'Acme', name: 'Admin', email: 'admin@acme.com', password: 'secret123' });
  check('open workspace creation succeeds', ws.status === 201);
  const slug = ws.data.workspace.slug;
  const adminToken = ws.data.token;

  // With no domain policy, any email may join.
  check('join with any email succeeds when open',
    (await jpost(oBase, `/api/workspaces/${slug}/register`, { name: 'Open', email: 'open@gmail.com', password: 'secret123' })).status === 201);

  // Admin restricts joins to the work domain.
  await jpatch(oBase, '/api/admin/settings', { allowed_signup_domains: 'acme.com' }, adminToken);
  check('join with off-domain email is rejected',
    (await jpost(oBase, `/api/workspaces/${slug}/register`, { name: 'Bad', email: 'bad@gmail.com', password: 'secret123' })).status === 403);
  check('join with work-domain email succeeds',
    (await jpost(oBase, `/api/workspaces/${slug}/register`, { name: 'Good', email: 'good@acme.com', password: 'secret123' })).status === 201);

  open.proc.kill();
  rmSync(open.dir, { recursive: true, force: true });
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    console.log(failures ? `\n${failures} gate check(s) FAILED` : '\nSignup-gate test passed');
    process.exit(failures ? 1 : 0);
  });
