/**
 * Remove-company test: a platform admin can permanently delete a workspace and
 * all its data (rows + on-disk files) without touching other companies, with
 * the right guards, and leaving the database referentially intact.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DELWS_PORT || 3991;
const B = `http://localhost:${PORT}/api`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-delws-'));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'delws-test', WORKSPACE_SIGNUP_CODE: 'boot', BACKUP_DISABLED: '1' },
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
const openDb = () => new Database(path.join(dataDir, 'app.db'), { readonly: true });

async function main() {
  await waitUp();
  const knap = (await j('POST', '/workspaces', { workspace_name: 'KNAP', name: 'N', email: 'n@k.com', password: 'secret123', code: 'boot' })).data;
  const K = knap.token;
  const c1 = (await j('POST', '/platform/company-codes', {}, K)).data.code;
  const acme = (await j('POST', '/workspaces', { workspace_name: 'Acme', name: 'Ann', email: 'ann@a.com', password: 'secret123', code: c1 })).data;
  const A = acme.token;
  const c2 = (await j('POST', '/platform/company-codes', {}, K)).data.code;
  const glob = (await j('POST', '/workspaces', { workspace_name: 'Globex', name: 'Gwen', email: 'gwen@g.com', password: 'secret123', code: c2 })).data;

  // Acme content: a task + an uploaded file.
  const wf = (await j('GET', '/workflows', null, A)).data.workflows[0];
  await j('POST', '/tasks', { title: 'Acme task', workflow_id: wf.id }, A);
  const fd = new FormData(); fd.append('files', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
  const up = await (await fetch(B + '/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + A }, body: fd })).json();
  const db0 = openDb();
  const stored = db0.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(up.attachments[0].id).stored_name;
  db0.close();
  check('acme upload exists on disk', existsSync(path.join(dataDir, 'uploads', stored)));

  const acmeId = acme.user.workspace_id;
  check('non-platform user cannot delete', (await j('DELETE', `/platform/workspaces/${acmeId}`, { confirm_name: 'Acme' }, A)).status === 403);
  check('platform workspace is protected', (await j('DELETE', `/platform/workspaces/${knap.user.workspace_id}`, { confirm_name: 'KNAP' }, K)).status === 400);
  check('wrong confirm name is rejected', (await j('DELETE', `/platform/workspaces/${acmeId}`, { confirm_name: 'acme' }, K)).status === 400);
  check('remove company succeeds with the right name', (await j('DELETE', `/platform/workspaces/${acmeId}`, { confirm_name: 'Acme' }, K)).status === 200);

  const db = openDb();
  check('acme workspace gone', !db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(acmeId));
  check('acme users/tasks/files gone',
    db.prepare('SELECT COUNT(*) n FROM users WHERE workspace_id = ?').get(acmeId).n === 0 &&
    db.prepare('SELECT COUNT(*) n FROM tasks WHERE workspace_id = ?').get(acmeId).n === 0 &&
    db.prepare('SELECT COUNT(*) n FROM attachments WHERE workspace_id = ?').get(acmeId).n === 0);
  check('globex + knap still present', !!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(glob.user.workspace_id) && !!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(knap.user.workspace_id));
  check('globex admin still present', !!db.prepare('SELECT 1 FROM users WHERE email = ?').get('gwen@g.com'));
  const fk = db.pragma('foreign_key_check');
  check('no foreign-key violations remain', Array.isArray(fk) && fk.length === 0);
  db.close();
  check('acme upload removed from disk', !existsSync(path.join(dataDir, 'uploads', stored)));
  check('globex still functional', (await j('GET', '/workflows', null, glob.token)).status === 200);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} remove-company check(s) FAILED` : '\nRemove-company test passed');
    process.exit(failures ? 1 : 0);
  });
