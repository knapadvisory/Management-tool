/**
 * Consent-based location sharing: nothing is accepted or stored until the user
 * opts in; admins only see teammates who opted in; opting out erases the stored
 * position. Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.LOCATION_PORT || 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-location-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'location-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
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

  // Admin owner + one approved member (Bob).
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Field Co', name: 'Ann', email: 'ann@f.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token; const slug = owner.data.workspace.slug;
  await req('POST', `/api/workspaces/${slug}/register`, { body: { name: 'Bob', email: 'bob@f.test', password: 'secret123' } });
  const bobId = (await req('GET', '/api/admin/users/pending', { token: a })).data.users[0].id;
  await req('POST', `/api/admin/users/${bobId}/approve`, { token: a });
  const b = (await req('POST', '/api/auth/login', { body: { email: 'bob@f.test', password: 'secret123' } })).data.token;

  // Nothing is accepted before consent.
  const before = await req('POST', '/api/location', { token: b, body: { lat: 19.07, lng: 72.87 } });
  check('posting a location before consent is refused', before.status === 403);
  const adminEmpty0 = await req('GET', '/api/admin/locations', { token: a });
  check('admin sees no one before anyone opts in', adminEmpty0.status === 200 && adminEmpty0.data.locations.length === 0);

  // Bob opts in and shares a position.
  const consent = await req('POST', '/api/location/consent', { token: b, body: { enabled: true } });
  check('member can opt in', consent.status === 200 && consent.data.location_sharing === true);
  const post = await req('POST', '/api/location', { token: b, body: { lat: 19.076, lng: 72.8777, accuracy: 12 } });
  check('a location is accepted once sharing is on', post.status === 200 && post.data.ok === true);
  const bad = await req('POST', '/api/location', { token: b, body: { lat: 999, lng: 0 } });
  check('invalid coordinates are rejected', bad.status === 400);

  const mine = await req('GET', '/api/location/me', { token: b });
  check('member sees their own sharing status + last position', mine.data.location_sharing === true && Math.abs(mine.data.last.lat - 19.076) < 1e-6);

  // Admin now sees Bob (and only opted-in members).
  const adminList = await req('GET', '/api/admin/locations', { token: a });
  check('admin sees the opted-in member', adminList.data.locations.length === 1 && adminList.data.locations[0].id === bobId);
  check('admin gets the coordinates', Math.abs(adminList.data.locations[0].lng - 72.8777) < 1e-6);

  // Opting out forgets the stored position and stops acceptance.
  await req('POST', '/api/location/consent', { token: b, body: { enabled: false } });
  const afterOff = await req('POST', '/api/location', { token: b, body: { lat: 19.07, lng: 72.87 } });
  check('posting after opting out is refused again', afterOff.status === 403);
  const adminEmpty1 = await req('GET', '/api/admin/locations', { token: a });
  check('opting out removes the member from the admin view', adminEmpty1.data.locations.length === 0);
  const mineOff = await req('GET', '/api/location/me', { token: b });
  check('the stored position is erased on opt-out', mineOff.data.location_sharing === false && mineOff.data.last === null);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll location tests passed');
    process.exit(failures ? 1 : 0);
  });
