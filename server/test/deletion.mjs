/**
 * Public account/data-deletion requests (Google Play requirement): anyone can
 * file one without logging in; admins see and mark them handled.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DELETION_PORT || 3993;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-deletion-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'deletion-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();

  // The page is public.
  const page = await fetch(BASE + '/delete-account');
  check('the /delete-account page is public', page.status === 200);

  // Anyone can file a request without auth; a bad email is rejected.
  const bad = await req('POST', '/api/account-deletion-request', { body: { email: 'not-an-email' } });
  check('invalid email is rejected', bad.status === 400);
  const ok = await req('POST', '/api/account-deletion-request', { body: { email: 'leaver@x.test', name: 'Lee', message: 'please delete' } });
  check('a valid request is accepted without login', ok.status === 200 && ok.data.ok === true);

  // An admin sees it and can mark it handled.
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Del Co', name: 'Ada', email: 'ada@d.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;
  const list = await req('GET', '/api/admin/deletion-requests', { token: a });
  check('admin sees the pending request', list.data.requests.length === 1 && list.data.requests[0].email === 'leaver@x.test');

  const id = list.data.requests[0].id;
  await req('POST', `/api/admin/deletion-requests/${id}/handle`, { token: a });
  const after = await req('GET', '/api/admin/deletion-requests', { token: a });
  check('handled requests drop off the pending list', after.data.requests.length === 0);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll deletion tests passed');
    process.exit(failures ? 1 : 0);
  });
