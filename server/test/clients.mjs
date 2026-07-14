/**
 * Clients module (light CRM): clients CRUD, contacts, notes, deadlines with
 * recurrence, task linking, and permissions. Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CLIENTS_PORT || 3996;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-clients-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'clients-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
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
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'CRM Co', name: 'Alice', email: 'a@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token; const slug = owner.data.workspace.slug;
  await req('POST', `/api/workspaces/${slug}/register`, { body: { name: 'Bob', email: 'b@b.test', password: 'secret123' } });
  const pend = await req('GET', '/api/admin/users/pending', { token: a });
  const bobId = pend.data.users.find((u) => u.email === 'b@b.test').id;
  await req('POST', `/api/admin/users/${bobId}/approve`, { token: a });
  const b = (await req('POST', '/api/auth/login', { body: { email: 'b@b.test', password: 'secret123' } })).data.token;
  const wf = (await req('GET', '/api/workflows', { token: a })).data.workflows[0];

  console.log('Clients');
  const created = await req('POST', '/api/clients', { token: a, body: { name: 'Acme Pvt Ltd', type: 'company', gstin: '29ABCDE1234F1Z5', email: 'ops@acme.test' } });
  check('a client can be created', created.status === 201 && created.data.name === 'Acme Pvt Ltd');
  const cid = created.data.id;
  const noName = await req('POST', '/api/clients', { token: a, body: { name: '  ' } });
  check('a client needs a name', noName.status === 400);
  const list = await req('GET', '/api/clients', { token: b });
  check('any member can list clients', list.status === 200 && list.data.clients.some((c) => c.id === cid));
  const patched = await req('PATCH', `/api/clients/${cid}`, { token: b, body: { status: 'prospect', phone: '+91 99999 99999' } });
  check('a client can be edited', patched.data.status === 'prospect' && patched.data.phone.includes('99999'));

  console.log('Contacts');
  const contact = await req('POST', `/api/clients/${cid}/contacts`, { token: a, body: { name: 'Neeraj', role: 'CFO', email: 'neeraj@acme.test' } });
  check('a contact can be added', contact.status === 201 && contact.data.some((c) => c.name === 'Neeraj'));
  const contactId = contact.data[0].id;
  const editContact = await req('PATCH', `/api/clients/${cid}/contacts/${contactId}`, { token: a, body: { role: 'Director' } });
  check('a contact can be edited', editContact.data.find((c) => c.id === contactId).role === 'Director');

  console.log('Notes');
  const note = await req('POST', `/api/clients/${cid}/notes`, { token: b, body: { body: 'Kickoff call done; docs pending.' } });
  check('a note can be added', note.status === 201 && note.data[0].body.includes('Kickoff'));
  const noteId = note.data[0].id;
  const aliceDelBobNote = await req('DELETE', `/api/clients/${cid}/notes/${noteId}`, { token: a });
  check('an admin can delete any note', aliceDelBobNote.status === 200);

  console.log('Deadlines + recurrence');
  const dl = await req('POST', `/api/clients/${cid}/deadlines`, { token: a, body: { title: 'GSTR-3B', due_date: '2026-08-20', recurrence: 'monthly' } });
  check('a deadline can be added', dl.status === 201 && dl.data.some((d) => d.title === 'GSTR-3B'));
  const badDl = await req('POST', `/api/clients/${cid}/deadlines`, { token: a, body: { title: 'x', due_date: 'not-a-date' } });
  check('a deadline needs a valid date', badDl.status === 400);
  const dlId = dl.data[0].id;
  const doneDl = await req('PATCH', `/api/clients/${cid}/deadlines/${dlId}`, { token: a, body: { completed: true } });
  check('completing a monthly deadline spawns the next month', doneDl.data.some((d) => d.due_date === '2026-09-20' && d.completed === 0));

  console.log('Task linking');
  const task = await req('POST', '/api/tasks', { token: a, body: { title: 'File Acme GST', workflow_id: wf.id, client_id: cid, assignee_id: bobId } });
  check('a task can be linked to a client', task.status === 201 && task.data.client?.id === cid);
  const badClientTask = await req('POST', '/api/tasks', { token: a, body: { title: 'x', workflow_id: wf.id, client_id: 999999 } });
  check('linking to a missing client is rejected', badClientTask.status === 400);
  const byClient = await req('GET', `/api/tasks?client_id=${cid}`, { token: a });
  check('tasks can be filtered by client', byClient.data.tasks.every((t) => t.client?.id === cid) && byClient.data.tasks.length === 1);
  const clientTasks = await req('GET', `/api/clients/${cid}/tasks`, { token: a });
  check('a client lists its linked tasks', clientTasks.data.tasks.some((t) => t.title === 'File Acme GST'));
  const detail = await req('GET', `/api/clients/${cid}`, { token: a });
  check('client detail bundles contacts + deadlines', detail.data.contacts.length === 1 && detail.data.deadlines.length >= 1);
  check('client meta counts open tasks', detail.data.client.open_task_count === 1);

  console.log('Permissions & cleanup');
  const memberDelete = await req('DELETE', `/api/clients/${cid}`, { token: b });
  check('a member cannot delete a client', memberDelete.status === 403);
  const adminDelete = await req('DELETE', `/api/clients/${cid}`, { token: a });
  check('an admin can delete a client', adminDelete.status === 200);
  const orphan = await req('GET', `/api/tasks/${task.data.id}`, { token: a });
  check('linked tasks survive client deletion (unlinked)', orphan.status === 200 && orphan.data.task.client === null);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll clients tests passed');
    process.exit(failures ? 1 : 0);
  });
