/**
 * KNAP-HRMS bridge: /api/hr config, SSO token minting (format must match the
 * HRMS SsoController), and admin-only gating. Boots the real server with the
 * HR env configured.
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.HR_PORT || 3991;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-hr-'));
const SSO_SECRET = 'hr-sso-secret';

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'hr-secret', WORKSPACE_SIGNUP_CODE: 'boot',
    TEAMHUB_SSO_SECRET: SSO_SECRET, TEAMHUB_API_TOKEN: 'hr-api-token',
    HR_URL: 'https://hr.example.test', HR_INTERNAL_URL: 'http://127.0.0.1:9', // unroutable → fast fail
  },
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

// Re-verify a handoff token the way the HRMS SsoController does.
function verify(token, secret) {
  const [b, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  if (expected !== sig) return null;
  return JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
}

async function main() {
  await waitForServer();
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'HR Co', name: 'Alice', email: 'a@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token; const slug = owner.data.workspace.slug;
  await req('POST', `/api/workspaces/${slug}/register`, { body: { name: 'Bob', email: 'b@b.test', password: 'secret123' } });
  const pend = await req('GET', '/api/admin/users/pending', { token: a });
  const bobId = pend.data.users.find((u) => u.email === 'b@b.test').id;
  await req('POST', `/api/admin/users/${bobId}/approve`, { token: a });
  const b = (await req('POST', '/api/auth/login', { body: { email: 'b@b.test', password: 'secret123' } })).data.token;

  console.log('HR bridge');
  const cfg = await req('GET', '/api/hr/config', { token: a });
  check('config reports HR enabled when secrets are set', cfg.status === 200 && cfg.data.enabled === true);

  const sso = await req('GET', '/api/hr/sso', { token: a });
  check('admin gets an SSO url', sso.status === 200 && typeof sso.data.url === 'string' && sso.data.url.startsWith('https://hr.example.test/sso?token='));

  const token = new URL(sso.data.url).searchParams.get('token');
  const claims = verify(token, SSO_SECRET);
  check('the token signature verifies with the shared secret', claims !== null);
  check('the token carries the caller’s email + a future expiry', claims && claims.email === 'a@a.test' && claims.exp > Math.floor(Date.now() / 1000));
  check('a wrong secret rejects the token', verify(token, 'not-the-secret') === null);

  const memberSso = await req('GET', '/api/hr/sso', { token: b });
  check('non-admins cannot mint an SSO token (403)', memberSso.status === 403);

  const summary = await req('GET', '/api/hr/summary', { token: a });
  check('summary proxy returns 502 when HR is unreachable', summary.status === 502);

  server.kill();
  if (failures) { console.error(`\n${failures} HR check(s) FAILED`); process.exit(1); }
  console.log('\nAll HR bridge tests passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
