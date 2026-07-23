/**
 * KNAP-HRMS bridge: /api/hr config, SSO token minting (format must match the
 * HRMS SsoController), roster push, and admin-only gating. Boots the real
 * server pointed at a tiny mock HR receiver.
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.HR_PORT || 3991;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-hr-'));
const SSO_SECRET = 'hr-sso-secret';
const API_TOKEN = 'hr-api-token';

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

// Mock HR: records roster POSTs (auth-checked), 404s everything else so the
// summary proxy still exercises its unreachable/error path.
let lastRoster = null;
const mockHr = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/roster') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastRoster = { auth: req.headers.authorization, body: JSON.parse(body || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: (JSON.parse(body || '{}').employees || []).length }));
    });
    return;
  }
  res.writeHead(404).end();
});
const mockPort = 3992;

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'hr-secret', WORKSPACE_SIGNUP_CODE: 'boot',
    TEAMHUB_SSO_SECRET: SSO_SECRET, TEAMHUB_API_TOKEN: API_TOKEN,
    HR_URL: 'https://hr.example.test', HR_INTERNAL_URL: `http://127.0.0.1:${mockPort}`,
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
  await new Promise((r) => mockHr.listen(mockPort, r));
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

  lastRoster = null;
  const sso = await req('GET', '/api/hr/sso', { token: a });
  check('admin gets an SSO url', sso.status === 200 && typeof sso.data.url === 'string' && sso.data.url.startsWith('https://hr.example.test/sso?token='));

  const token = new URL(sso.data.url).searchParams.get('token');
  const claims = verify(token, SSO_SECRET);
  check('the token signature verifies with the shared secret', claims !== null);
  check('the token carries the caller’s email + a future expiry', claims && claims.email === 'a@a.test' && claims.exp > Math.floor(Date.now() / 1000));
  check('the token carries the workspace + role for HR tenant isolation', claims && claims.ws === slug && claims.wsname === 'HR Co' && claims.role === 'admin');
  check('the token carries the TeamHub user id so HR links the employee', claims && Number.isInteger(claims.uid) && claims.uid > 0);
  check('a wrong secret rejects the token', verify(token, 'not-the-secret') === null);

  // Opening HR fires a fire-and-forget roster push; wait briefly for it.
  for (let i = 0; i < 25 && !lastRoster; i++) await new Promise((r) => setTimeout(r, 40));
  check('opening HR pushes the workspace roster', lastRoster !== null);
  check('the roster push authenticates with the shared API token', lastRoster && lastRoster.auth === `Bearer ${API_TOKEN}`);
  check('the roster carries the workspace slug + name', lastRoster && lastRoster.body.ws === slug && lastRoster.body.wsname === 'HR Co');
  // Alice (approved owner) + Bob (approved) are active members; both pushed.
  const emails = lastRoster ? (lastRoster.body.employees || []).map((e) => e.email).sort() : [];
  check('the roster lists every active member with id + name', lastRoster
    && lastRoster.body.employees.length === 2
    && emails.join(',') === 'a@a.test,b@b.test'
    && lastRoster.body.employees.every((e) => e.teamhub_user_id && e.name && e.active === true));

  // Members CAN open HR now — they land in their own self-service portal.
  const memberSso = await req('GET', '/api/hr/sso', { token: b });
  const memberToken = memberSso.status === 200 ? new URL(memberSso.data.url).searchParams.get('token') : null;
  const memberClaims = memberToken ? verify(memberToken, SSO_SECRET) : null;
  check('a member can mint an SSO token', memberSso.status === 200 && memberClaims !== null);
  check('the member token carries role=member + their own uid', memberClaims && memberClaims.role === 'member' && Number.isInteger(memberClaims.uid) && memberClaims.uid > 0);

  // …but the firm-wide summary widget stays admin-only.
  const memberSummary = await req('GET', '/api/hr/summary', { token: b });
  check('members cannot read the firm-wide HR summary (403)', memberSummary.status === 403);

  const summary = await req('GET', '/api/hr/summary', { token: a });
  check('summary proxy returns 502 when HR has no summary endpoint', summary.status === 502);

  // Deactivating a member re-pushes a roster without them.
  lastRoster = null;
  await req('POST', `/api/admin/users/${bobId}/deactivate`, { token: a });
  for (let i = 0; i < 25 && !lastRoster; i++) await new Promise((r) => setTimeout(r, 40));
  check('deactivating a member re-pushes the roster', lastRoster !== null);
  check('the deactivated member drops off the active roster', lastRoster
    && lastRoster.body.employees.length === 1
    && lastRoster.body.employees[0].email === 'a@a.test');

  server.kill();
  mockHr.close();
  if (failures) { console.error(`\n${failures} HR check(s) FAILED`); process.exit(1); }
  console.log('\nAll HR bridge tests passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); server.kill(); mockHr.close(); process.exit(1); });
