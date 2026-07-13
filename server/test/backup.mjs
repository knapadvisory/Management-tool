/**
 * Backup test: a platform admin can run a backup that captures a consistent
 * database snapshot + uploaded files, list backups, and download the latest
 * database; non-platform users are refused.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BACKUP_PORT || 3992;
const B = `http://localhost:${PORT}/api`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-backup-'));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'backup-test', WORKSPACE_SIGNUP_CODE: 'boot', BACKUP_DISABLED: '1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function j(m, u, body, token) {
  const o = { method: m, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
  if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(B + u, o);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/config'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('server did not start');
}

async function main() {
  await waitUp();
  const knap = (await j('POST', '/workspaces', { workspace_name: 'KNAP', name: 'N', email: 'n@k.com', password: 'secret123', code: 'boot' })).data;
  const K = knap.token;
  const bob = (await j('POST', '/admin/users', { name: 'Bob', email: 'b@k.com', password: 'secret123' }, K)).data;
  const fd = new FormData(); fd.append('files', new Blob(['backup me'], { type: 'text/plain' }), 'important.txt');
  await fetch(B + '/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + K }, body: fd });

  const member = (await j('POST', '/auth/login', { email: 'b@k.com', password: 'secret123' })).data;
  check('non-platform user is refused', (await j('GET', '/platform/backups', null, member.token)).status === 403);

  const run = await j('POST', '/platform/backups', null, K);
  check('backup runs', run.status === 201 && !!run.data.name);
  const bdir = path.join(dataDir, 'backups', run.data.name);
  check('snapshot db exists', existsSync(path.join(bdir, 'app.db')));
  check('uploads captured', existsSync(path.join(bdir, 'uploads')) && readdirSync(path.join(bdir, 'uploads')).length >= 1);

  const snap = new Database(path.join(bdir, 'app.db'), { readonly: true });
  check('snapshot is a valid db with the data', snap.prepare("SELECT COUNT(*) n FROM workspaces WHERE name='KNAP'").get().n === 1);
  snap.close();

  check('status lists the backup', (await j('GET', '/platform/backups', null, K)).data.count >= 1);

  const dl = await fetch(B + '/platform/backups/latest.db', { headers: { Authorization: 'Bearer ' + K } });
  const head = Buffer.from(await dl.arrayBuffer()).slice(0, 16).toString();
  check('latest-db download is a real SQLite file', dl.status === 200 && head.startsWith('SQLite format 3'));
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} backup check(s) FAILED` : '\nBackup test passed');
    process.exit(failures ? 1 : 0);
  });
