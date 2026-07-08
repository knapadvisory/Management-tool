/**
 * Signup-gate test: boots the server WITH a SIGNUP_CODE and verifies that
 * registration requires the correct code, while /api/config advertises it.
 * Also confirms the default (no code set) leaves registration open.
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
async function register(base, body) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.status;
}

async function main() {
  // --- Gated instance ---
  const gated = boot(4620, { SIGNUP_CODE: 'letmein' });
  const gBase = 'http://localhost:4620';
  check('gated server starts', await waitUp(gBase));
  const cfg = await (await fetch(gBase + '/api/config')).json();
  check('config advertises code required', cfg.signup_code_required === true);
  check('register without code is rejected', await register(gBase, { name: 'A', email: 'a@g.co', password: 'secret123' }) === 403);
  check('register with wrong code is rejected', await register(gBase, { name: 'A', email: 'a@g.co', password: 'secret123', code: 'nope' }) === 403);
  check('register with correct code succeeds', await register(gBase, { name: 'A', email: 'a@g.co', password: 'secret123', code: 'letmein' }) === 201);
  gated.proc.kill();
  rmSync(gated.dir, { recursive: true, force: true });

  // --- Open instance (no code) ---
  const open = boot(4621, {});
  const oBase = 'http://localhost:4621';
  check('open server starts', await waitUp(oBase));
  const cfg2 = await (await fetch(oBase + '/api/config')).json();
  check('config advertises no code required', cfg2.signup_code_required === false);
  check('register works without a code when open', await register(oBase, { name: 'B', email: 'b@o.co', password: 'secret123' }) === 201);
  open.proc.kill();
  rmSync(open.dir, { recursive: true, force: true });
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    console.log(failures ? `\n${failures} gate check(s) FAILED` : '\nSignup-gate test passed');
    process.exit(failures ? 1 : 0);
  });
