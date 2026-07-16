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

  console.log('Bulk import + bulk deadlines');
  const bulk = await req('POST', '/api/clients/bulk', { token: a, body: { clients: [
    { name: 'Bharat Traders', gstin: '27AAAAA0000A1Z5' },
    { name: 'R Sharma & Co', email: 'ca@sharma.in' },
    { name: 'Acme Pvt Ltd' },   // duplicate of the earlier client -> skipped
    { name: '   ' },            // blank -> skipped
  ] } });
  check('bulk import creates new clients and skips dupes/blanks', bulk.status === 201 && bulk.data.created === 2 && bulk.data.skipped === 2);
  const allClients = (await req('GET', '/api/clients', { token: a })).data.clients;
  check('imported clients appear in the list', allClients.some((c) => c.name === 'Bharat Traders') && allClients.some((c) => c.name === 'R Sharma & Co'));

  // Update-existing import: re-upload updates matched clients (by code/PAN/name).
  await req('POST', '/api/clients', { token: a, body: { name: 'Zeta Corp', client_code: 'KNAP-Z', pan: 'ZZZPZ1234Z' } });
  const upd = await req('POST', '/api/clients/bulk', { token: a, body: { update: true, clients: [
    { name: 'Zeta Renamed', client_code: 'KNAP-Z', risk_rating: 'High' }, // matches by code -> update (incl. rename)
    { name: 'Fresh Co', client_code: 'KNAP-F' },                          // new -> created
  ] } });
  check('update mode updates matched clients and creates new ones', upd.data.updated === 1 && upd.data.created === 1);
  const zeta = (await req('GET', '/api/clients', { token: a })).data.clients.find((c) => c.client_code === 'KNAP-Z');
  check('an updated client keeps its code but gets new field values', zeta && zeta.name === 'Zeta Renamed' && zeta.risk_rating === 'High');
  const noUpd = await req('POST', '/api/clients/bulk', { token: a, body: { clients: [{ name: 'Whatever', client_code: 'KNAP-Z' }] } });
  check('without update mode a matched client is skipped, not changed', noUpd.data.skipped === 1 && noUpd.data.created === 0);

  const targetIds = allClients.map((c) => c.id);
  const bulkDl = await req('POST', '/api/clients/deadlines/bulk', { token: a, body: { title: 'TDS payment', due_date: '2026-08-07', recurrence: 'monthly', client_ids: targetIds } });
  check('bulk deadline set on every selected client', bulkDl.status === 201 && bulkDl.data.created === targetIds.length);
  const rerun = await req('POST', '/api/clients/deadlines/bulk', { token: a, body: { title: 'TDS payment', due_date: '2026-08-07', recurrence: 'monthly', client_ids: targetIds } });
  check('re-running skips clients that already have that open deadline', rerun.data.created === 0 && rerun.data.skipped === targetIds.length);
  const oneClient = await req('GET', `/api/clients/${targetIds[0]}`, { token: a });
  check('the bulk deadline shows on a client', oneClient.data.deadlines.some((d) => d.title === 'TDS payment' && d.recurrence === 'monthly'));
  const badBulkDl = await req('POST', '/api/clients/deadlines/bulk', { token: a, body: { title: 'x', due_date: '2026-08-20', client_ids: [] } });
  check('bulk deadline needs at least one client', badBulkDl.status === 400);

  console.log('Assignees, board & task generation');
  // Assign a deadline to Bob.
  const cid2 = allClients.find((c) => c.name === 'Bharat Traders').id;
  const dlA = await req('POST', `/api/clients/${cid2}/deadlines`, { token: a, body: { title: 'PF payment', due_date: '2026-08-15', recurrence: 'monthly', assignee_id: bobId } });
  check('a deadline can carry an assignee', dlA.data.some((d) => d.title === 'PF payment' && d.assignee_name === 'Bob'));

  // Firm-wide board for the month, with a per-filing summary.
  const board = await req('GET', '/api/clients/deadlines/board?month=2026-08', { token: b });
  check('the compliance board lists deadlines with client + assignee', board.data.deadlines.some((d) => d.client_name === 'Bharat Traders' && d.assignee_name === 'Bob'));
  check('the board summarises per filing', board.data.summary.some((s) => s.title === 'TDS payment' && s.total >= 1));

  // Compliance matrix: clients x filing types for the month.
  const matrix = await req('GET', '/api/clients/matrix?month=2026-08', { token: a });
  check('matrix lists filing types as columns', matrix.data.columns.includes('TDS payment'));
  check('matrix has a row per client with cell statuses', matrix.data.rows.some((r) => r.cells['TDS payment'] && ['due', 'overdue', 'filed'].includes(r.cells['TDS payment'].status)));

  // Generate an assignable task from a deadline; completing it ticks the deadline.
  const pfDeadline = dlA.data.find((d) => d.title === 'PF payment');
  const gen = await req('POST', `/api/clients/${cid2}/deadlines/${pfDeadline.id}/task`, { token: a });
  check('a task can be generated from a deadline', gen.status === 201 && gen.data.task_id > 0);
  const genTask = await req('GET', `/api/tasks/${gen.data.task_id}`, { token: a });
  check('the generated task is linked to the client + assignee', genTask.data.task.client?.id === cid2 && genTask.data.task.assignee?.id === bobId);
  const dupTask = await req('POST', `/api/clients/${cid2}/deadlines/${pfDeadline.id}/task`, { token: a });
  check('a deadline will not spawn a second task', dupTask.status === 400);
  // Complete the task -> deadline is filed and the next month's PF is created.
  const doneStage = (await req('GET', '/api/workflows', { token: a })).data.workflows[0].stages.find((s) => s.is_done);
  await req('PATCH', `/api/tasks/${gen.data.task_id}`, { token: a, body: { stage_id: doneStage.id } });
  const afterDl = await req('GET', `/api/clients/${cid2}`, { token: a });
  check('completing the task filed the deadline', afterDl.data.deadlines.find((d) => d.id === pfDeadline.id).completed === 1);
  check('the next month\'s PF deadline was spawned (keeping the assignee)', afterDl.data.deadlines.some((d) => d.title === 'PF payment' && d.completed === 0 && d.due_date === '2026-09-15' && d.assignee_name === 'Bob'));

  // Bulk set with assignee + task generation.
  const bulkT = await req('POST', '/api/clients/deadlines/bulk', { token: a, body: { title: 'GSTR-1', due_date: '2026-08-11', recurrence: 'monthly', assignee_id: bobId, create_tasks: true, client_ids: [cid2] } });
  check('bulk can also generate tasks', bulkT.data.created === 1 && bulkT.data.tasks === 1);

  console.log('Client tags (compliance segments)');
  const tagged = await req('POST', '/api/clients', { token: a, body: { name: 'Tagged Co', tags: ['GST', 'TDS', 'gst'] } });
  check('a client can be created with tags (deduped)', tagged.data.tags.length === 2 && tagged.data.tags.includes('GST') && tagged.data.tags.includes('TDS'));
  const retag = await req('PATCH', `/api/clients/${tagged.data.id}`, { token: a, body: { tags: ['GST', 'PF'] } });
  check('tags can be replaced on edit', retag.data.tags.includes('PF') && !retag.data.tags.includes('TDS'));
  const bulkTags = await req('POST', '/api/clients/bulk', { token: a, body: { clients: [{ name: 'Seg One', tags: ['GST'] }, { name: 'Seg Two', tags: ['GST', 'PF'] }] } });
  check('bulk import carries tags', bulkTags.data.created === 2);
  const distinct = await req('GET', '/api/clients/tags', { token: b });
  check('distinct tags are listed for the filter', distinct.data.tags.includes('GST') && distinct.data.tags.includes('PF'));
  const listed = (await req('GET', '/api/clients', { token: a })).data.clients;
  const gstClients = listed.filter((c) => (c.tags || []).includes('GST'));
  check('clients can be segmented by tag (>=3 GST clients)', gstClients.length >= 3);

  console.log('Client-master fields (rich import)');
  const rich = await req('POST', '/api/clients', { token: a, body: {
    name: 'Master Co', client_code: 'KNAP-042', constitution: 'LLP', firm: 'KNAP',
    pan: 'AAACS9999F', tan: 'DELS99999E', cin: 'AAB-1234', contact_person: 'R. Rao',
    gst_frequency: 'QRMP', fee_model: 'Per Filing', fee_amount: '5000',
    turnover_band: '1-10 Cr', risk_rating: 'Medium', independence_flag: 'Yes',
    onboarding_date: '01-Apr-2024', tags: ['GST'],
  } });
  check('rich fields are stored on create', rich.data.client_code === 'KNAP-042' && rich.data.constitution === 'LLP' && rich.data.fee_amount === '5000' && rich.data.gst_frequency === 'QRMP');
  const richPatch = await req('PATCH', `/api/clients/${rich.data.id}`, { token: a, body: { risk_rating: 'High', fee_amount: '7500' } });
  check('rich fields can be edited without clearing others', richPatch.data.risk_rating === 'High' && richPatch.data.fee_amount === '7500' && richPatch.data.client_code === 'KNAP-042');
  const richBack = (await req('GET', `/api/clients/${rich.data.id}`, { token: b })).data.client;
  check('rich fields survive a reload', richBack.tan === 'DELS99999E' && richBack.independence_flag === 'Yes');

  console.log('Client documents (360 view)');
  const docCid = rich.data.id;
  const fd = new FormData();
  fd.append('files', new Blob(['engagement letter'], { type: 'text/plain' }), 'engagement.txt');
  const up = await (await fetch(`${BASE}/api/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${a}` }, body: fd })).json();
  const docLink = await req('POST', `/api/clients/${docCid}/documents`, { token: a, body: { attachment_ids: [up.attachments[0].id] } });
  check('a document can be filed against a client', docLink.status === 201 && docLink.data.length === 1 && docLink.data[0].original_name === 'engagement.txt');
  const withDoc = await req('GET', `/api/clients/${docCid}`, { token: b });
  check('the document appears on the client file for teammates', withDoc.data.documents.length === 1);
  check('client document_count reflects the filed document', withDoc.data.client.document_count === 1);
  const docDl = await fetch(`${BASE}/api/uploads/${up.attachments[0].id}?token=${b}`);
  check('a teammate can download the client document', docDl.status === 200);
  const rmDoc = await req('DELETE', `/api/clients/${docCid}/documents/${up.attachments[0].id}`, { token: a });
  check('a document can be removed', rmDoc.data.length === 0);

  console.log('Custom compliance types');
  const t0 = await req('GET', '/api/clients/compliance-types', { token: a });
  check('compliance types start empty', Array.isArray(t0.data.types) && t0.data.types.length === 0);
  const t1 = await req('POST', '/api/clients/compliance-types', { token: a, body: { name: 'ROC filing' } });
  check('a custom compliance type can be added', t1.data.types.includes('ROC filing'));
  const t2 = await req('POST', '/api/clients/compliance-types', { token: a, body: { name: 'roc filing' } });
  check('duplicate types (case-insensitive) are not added twice', t2.data.types.filter((x) => x.toLowerCase() === 'roc filing').length === 1);
  const t3 = await req('POST', '/api/clients/compliance-types', { token: b, body: { name: '' } });
  check('a blank type is rejected', t3.status === 400);
  const t4 = await req('DELETE', `/api/clients/compliance-types/${encodeURIComponent('ROC filing')}`, { token: a });
  check('a custom type can be removed', !t4.data.types.includes('ROC filing'));

  console.log('Permissions & cleanup');
  const memberDelete = await req('DELETE', `/api/clients/${docCid}`, { token: b });
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
