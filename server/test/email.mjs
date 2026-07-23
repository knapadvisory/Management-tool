/**
 * Email + password-reset test. Runs with EMAIL_TEST_MODE (nodemailer captures
 * messages instead of sending), so no real SMTP is needed. Verifies the reset
 * flow end-to-end (token → new password → login) and graceful degradation when
 * email is off.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

function boot(port, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'teamhub-email-'));
  const proc = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, JWT_SECRET: 'email-test', WORKSPACE_SIGNUP_CODE: 'boot', BACKUP_DISABLED: '1', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { proc, dir, base: `http://localhost:${port}/api` };
}
async function up(base) { for (let i = 0; i < 50; i++) { try { await fetch(base + '/config'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } } throw new Error('no start'); }
async function j(base, m, u, body, token) {
  const o = { method: m, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
  if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(base + u, o);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function main() {
  // --- Email ON (capture mode) ---
  const on = boot(4630, { EMAIL_TEST_MODE: '1' });
  await up(on.base);
  check('config reports email enabled', (await (await fetch(on.base + '/config')).json()).email_enabled === true);
  const ws = (await j(on.base, 'POST', '/workspaces', { workspace_name: 'KNAP', name: 'Neeraj', email: 'neeraj@knap.com', password: 'secret123', code: 'boot' })).data;

  // Forgot → a reset token is created (read it straight from the DB) → reset → login with the new password.
  check('forgot responds 200 generically', (await j(on.base, 'POST', '/auth/forgot', { email: 'neeraj@knap.com' })).status === 200);
  const db = new Database(path.join(on.dir, 'app.db'), { readonly: true });
  const row = db.prepare('SELECT token FROM password_resets WHERE used = 0 ORDER BY id DESC LIMIT 1').get();
  db.close();
  check('a reset token was created', !!row?.token);
  check('reset token validates', (await j(on.base, 'GET', `/auth/reset/${row.token}`)).status === 200);
  check('reset rejects a short password', (await j(on.base, 'POST', `/auth/reset/${row.token}`, { password: '123' })).status === 400);
  check('reset sets a new password', (await j(on.base, 'POST', `/auth/reset/${row.token}`, { password: 'newpass1' })).status === 200);
  check('old password no longer works', (await j(on.base, 'POST', '/auth/login', { email: 'neeraj@knap.com', password: 'secret123' })).status === 401);
  check('new password works', (await j(on.base, 'POST', '/auth/login', { email: 'neeraj@knap.com', password: 'newpass1' })).status === 200);
  check('used token cannot be reused', (await j(on.base, 'POST', `/auth/reset/${row.token}`, { password: 'another1' })).status === 400);
  check('forgot for an unknown email still 200 (no leak)', (await j(on.base, 'POST', '/auth/forgot', { email: 'nobody@nowhere.com' })).status === 200);
  on.proc.kill(); rmSync(on.dir, { recursive: true, force: true });

  // --- Email OFF ---
  const off = boot(4631, {});
  await up(off.base);
  check('config reports email disabled', (await (await fetch(off.base + '/config')).json()).email_enabled === false);
  await j(off.base, 'POST', '/workspaces', { workspace_name: 'X', name: 'A', email: 'a@x.com', password: 'secret123', code: 'boot' });
  check('forgot still responds 200 when email is off', (await j(off.base, 'POST', '/auth/forgot', { email: 'a@x.com' })).status === 200);
  const db2 = new Database(path.join(off.dir, 'app.db'), { readonly: true });
  const n = db2.prepare('SELECT COUNT(*) n FROM password_resets').get().n;
  db2.close();
  check('no reset token created when email is off', n === 0);
  off.proc.kill(); rmSync(off.dir, { recursive: true, force: true });
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    console.log(failures ? `\n${failures} email check(s) FAILED` : '\nEmail test passed');
    process.exit(failures ? 1 : 0);
  });
