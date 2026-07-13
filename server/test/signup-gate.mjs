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
  // --- Company creation always needs a code (env bootstrap or a DB code) ---
  const srv = boot(4620, { WORKSPACE_SIGNUP_CODE: 'letmein' });
  const gBase = 'http://localhost:4620';
  check('server starts', await waitUp(gBase));
  const cfg = await (await fetch(gBase + '/api/config')).json();
  check('config says a company code is required', cfg.company_code_required === true);
  check('create company without code is rejected',
    (await jpost(gBase, '/api/workspaces', { workspace_name: 'X', name: 'A', email: 'a@x.co', password: 'secret123' })).status === 403);
  check('create company with wrong code is rejected',
    (await jpost(gBase, '/api/workspaces', { workspace_name: 'X', name: 'A', email: 'a@x.co', password: 'secret123', code: 'nope' })).status === 403);
  check('create company with the bootstrap code succeeds',
    (await jpost(gBase, '/api/workspaces', { workspace_name: 'KNAP', name: 'A', email: 'a@x.co', password: 'secret123', code: 'letmein' })).status === 201);

  // --- Per-workspace domain sorting (never blocks) ---
  const oBase = gBase;
  const ws = await jpost(oBase, '/api/workspaces', { workspace_name: 'Acme', name: 'Admin', email: 'admin@acme.com', password: 'secret123', code: 'letmein' });
  check('company creation succeeds', ws.status === 201);
  const slug = ws.data.workspace.slug;
  const adminToken = ws.data.token;

  // Anyone may register (work OR personal) — it always lands as pending.
  check('join with a personal email succeeds (pending)',
    (await jpost(oBase, `/api/workspaces/${slug}/register`, { name: 'Open', email: 'open@gmail.com', password: 'secret123' })).data.pending === true);

  // With work domains set, requests are sorted work vs personal (never blocked).
  await jpatch(oBase, '/api/admin/settings', { allowed_signup_domains: 'acme.com' }, adminToken);
  check('off-domain email still allowed (not blocked)',
    (await jpost(oBase, `/api/workspaces/${slug}/register`, { name: 'Perso', email: 'perso@gmail.com', password: 'secret123' })).status === 201);
  check('work-domain email allowed',
    (await jpost(oBase, `/api/workspaces/${slug}/register`, { name: 'Worky', email: 'worky@acme.com', password: 'secret123' })).status === 201);
  const pend = await (await fetch(oBase + '/api/admin/users/pending', { headers: { Authorization: 'Bearer ' + adminToken } })).json();
  check('pending list is categorized', pend.categorized === true);
  check('work-domain request flagged work_email', pend.users.find((u) => u.email === 'worky@acme.com')?.work_email === true);
  check('personal request flagged not-work', pend.users.find((u) => u.email === 'perso@gmail.com')?.work_email === false);

  srv.proc.kill();
  rmSync(srv.dir, { recursive: true, force: true });
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    console.log(failures ? `\n${failures} gate check(s) FAILED` : '\nSignup-gate test passed');
    process.exit(failures ? 1 : 0);
  });
