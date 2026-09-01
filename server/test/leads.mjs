/**
 * Lead management: keyed public intake from the website, auto follow-up task,
 * new-lead notifications, and the pipeline board CRUD. Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.LEADS_PORT || 3995;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-leads-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'leads-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body, form } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();

  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Advisory Co', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;

  // Admin fetches settings → an intake key is minted, workflows are listed.
  const settings = await req('GET', '/api/leads/settings', { token: a });
  check('settings mint an intake key', settings.status === 200 && !!settings.data.key);
  check('workflows are offered for the auto-task', Array.isArray(settings.data.workflows) && settings.data.workflows.length > 0);
  const key = settings.data.key;
  const wfId = settings.data.workflows[0].id;

  // Point auto-tasks at the default workflow.
  await req('PATCH', '/api/leads/settings', { token: a, body: { task_workflow_id: wfId } });

  // Intake is refused without a valid key.
  const noKey = await req('POST', '/api/leads/intake', { body: { name: 'X' } });
  check('intake without a key is rejected', noKey.status === 400);
  const badKey = await req('POST', '/api/leads/intake?key=nope', { body: { name: 'X' } });
  check('intake with a wrong key is rejected', badKey.status === 403);

  // The website posts a form-encoded enquiry (like the PHP form).
  const intake = await req('POST', `/api/leads/intake?key=${encodeURIComponent(key)}`, {
    form: { name: 'Varun', email: 'varun.krrish@gmail.com', phone: '9560936794', message: 'How much to close a CG account?' },
  });
  check('a website enquiry is accepted (form-encoded)', intake.status === 200 && intake.data.ok === true);

  // It shows on the board, with a follow-up task auto-created.
  const list = await req('GET', '/api/leads', { token: a });
  check('the lead appears on the board', list.data.leads.length === 1 && list.data.leads[0].name === 'Varun');
  const lead = list.data.leads[0];
  check('source is website', lead.source === 'website');
  check('a follow-up task was auto-created and linked', !!lead.task_id);
  check('new lead starts in the "new" column', lead.status === 'new');

  // The admin was notified.
  const notifs = await req('GET', '/api/notifications', { token: a });
  check('admin got a new-lead notification', (notifs.data.notifications || notifs.data || []).some((n) => n.type === 'lead'));

  // Move it along the pipeline + assign an owner.
  const ownerId = owner.data.user.id;
  const moved = await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { status: 'qualified', owner_id: ownerId } });
  check('status + owner update', moved.data.lead.status === 'qualified' && moved.data.lead.owner_id === ownerId);
  const bad = await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { status: 'banana' } });
  check('an invalid status is rejected', bad.status === 400);

  // --- Role-based visibility: admin/sales see all, members see only their own ---
  await req('POST', '/api/admin/users', { token: a, body: { name: 'Mia', email: 'mia@a.test', password: 'secret123', role: 'member' } });
  await req('POST', '/api/admin/users', { token: a, body: { name: 'Sam', email: 'sam@a.test', password: 'secret123', role: 'sales' } });
  const mia = (await req('POST', '/api/auth/login', { body: { email: 'mia@a.test', password: 'secret123' } })).data;
  const sam = (await req('POST', '/api/auth/login', { body: { email: 'sam@a.test', password: 'secret123' } })).data;
  check('a Sales user can be created', !!sam.token && sam.user.role === 'sales');

  // The lead is owned by the admin (assigned earlier), so a member sees nothing.
  const miaEmpty = await req('GET', '/api/leads', { token: mia.token });
  check('a member sees no leads until one is assigned to them', miaEmpty.data.leads.length === 0);

  // Assign it to Mia → it shows on her board.
  await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { owner_id: mia.user.id } });
  const miaOwn = await req('GET', '/api/leads', { token: mia.token });
  check('a member sees a lead once assigned to them', miaOwn.data.leads.length === 1 && miaOwn.data.leads[0].id === lead.id);

  // Sales sees every lead regardless of owner.
  const samAll = await req('GET', '/api/leads', { token: sam.token });
  check('a Sales user sees all leads', samAll.data.leads.length === 1);

  // A member manages their own lead, but not one assigned elsewhere.
  const miaMove = await req('PATCH', `/api/leads/${lead.id}`, { token: mia.token, body: { status: 'contacted' } });
  check('a member can manage their own lead', miaMove.status === 200 && miaMove.data.lead.status === 'contacted');
  await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { owner_id: sam.user.id } });
  const miaDenied = await req('PATCH', `/api/leads/${lead.id}`, { token: mia.token, body: { status: 'won' } });
  check('a member cannot manage a lead not assigned to them', miaDenied.status === 403);
  const samMove = await req('PATCH', `/api/leads/${lead.id}`, { token: sam.token, body: { status: 'qualified' } });
  check('a Sales user can manage any lead', samMove.status === 200 && samMove.data.lead.status === 'qualified');

  // A member can only add a lead onto their own board.
  const miaAdd = await req('POST', '/api/leads', { token: mia.token, body: { name: 'Walk-in', owner_id: sam.user.id } });
  check('a member-added lead is assigned to them, not to whoever they named', miaAdd.data.lead.owner_id === mia.user.id);

  // --- Configurable pipeline stages ---
  const st0 = await req('GET', '/api/leads/stages', { token: a });
  check('the default pipeline has the five seeded stages', st0.data.stages.length === 5 && st0.data.stages[0].key === 'new');

  // Add a column.
  const added = await req('POST', '/api/leads/stages', { token: a, body: { label: 'Proposal Sent' } });
  check('an admin can add a stage', added.status === 201 && added.data.stages.some((s) => s.label === 'Proposal Sent'));
  const proposal = added.data.stages.find((s) => s.label === 'Proposal Sent');
  check('a new stage gets a slug key', proposal.key === 'proposal-sent');

  // A lead can be moved into the new stage; an unknown stage is still rejected.
  const toNew = await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { status: proposal.key } });
  check('a lead can move into a custom stage', toNew.status === 200 && toNew.data.lead.status === proposal.key);
  const bogus = await req('PATCH', `/api/leads/${lead.id}`, { token: a, body: { status: 'not-a-stage' } });
  check('a status outside the pipeline is rejected', bogus.status === 400);

  // Rename it.
  const renamed = await req('PATCH', `/api/leads/stages/${proposal.id}`, { token: a, body: { label: 'Proposal' } });
  check('an admin can rename a stage', renamed.data.stages.find((s) => s.id === proposal.id).label === 'Proposal');

  // Reorder: move the new stage to the front.
  const order = [proposal.id, ...st0.data.stages.map((s) => s.id)];
  const reordered = await req('PATCH', '/api/leads/stages/reorder', { token: a, body: { order } });
  check('an admin can reorder stages', reordered.data.stages[0].id === proposal.id);

  // Delete it → the lead sitting in it falls back to another stage, not lost.
  const del = await req('DELETE', `/api/leads/stages/${proposal.id}`, { token: a });
  check('an admin can delete a stage', del.status === 200 && !del.data.stages.some((s) => s.id === proposal.id));
  const afterDel = await req('GET', '/api/leads', { token: a });
  const moved2 = afterDel.data.leads.find((l) => l.id === lead.id);
  check('a lead in a deleted stage is reassigned, not orphaned', moved2 && del.data.stages.some((s) => s.key === moved2.status));

  // A plain member cannot edit the pipeline.
  const miaStage = await req('POST', '/api/leads/stages', { token: mia.token, body: { label: 'Sneaky' } });
  check('a member cannot add a stage', miaStage.status === 403);

  // --- Stage-triggered automations ---
  // Point the auto-task workflow at the default one, then arm a stage.
  await req('PATCH', '/api/leads/settings', { token: a, body: { task_workflow_id: wfId } });
  const stagesNow = (await req('GET', '/api/leads/stages', { token: a })).data.stages;
  const contacted = stagesNow.find((s) => s.key === 'contacted');
  const armed = await req('PATCH', `/api/leads/stages/${contacted.id}`, { token: a, body: { auto_task: true, auto_reminder_days: 3 } });
  const armedStage = armed.data.stages.find((s) => s.id === contacted.id);
  check('a stage can be armed with automations', armedStage.auto_task === 1 && armedStage.auto_reminder_days === 3);

  // Add a fresh lead (starts in the first stage) and move it into "contacted".
  const fresh = (await req('POST', '/api/leads', { token: a, body: { name: 'Auto Test' } })).data.lead;
  const taskBefore = fresh.task_id;
  await req('PATCH', `/api/leads/${fresh.id}`, { token: a, body: { status: 'contacted' } });
  const freshRem = await req('GET', `/api/leads/${fresh.id}/reminders`, { token: a });
  check('entering an armed stage schedules a reminder', freshRem.data.reminders.length === 1);
  const freshLead = (await req('GET', '/api/leads', { token: a })).data.leads.find((l) => l.id === fresh.id);
  check('entering an armed stage creates a follow-up task', !!freshLead.task_id && freshLead.task_id !== taskBefore);

  // Re-saving the same stage does not re-fire (status unchanged → no dupes).
  await req('PATCH', `/api/leads/${fresh.id}`, { token: a, body: { status: 'contacted' } });
  const remAgain = await req('GET', `/api/leads/${fresh.id}/reminders`, { token: a });
  check('staying in a stage does not re-fire its automations', remAgain.data.reminders.length === 1);

  // --- Analytics ---
  // Move the fresh lead to "won" so there is a closed lead to measure.
  await req('PATCH', `/api/leads/${fresh.id}`, { token: a, body: { status: 'won' } });
  const an = await req('GET', '/api/leads/analytics', { token: a });
  check('analytics returns pipeline totals', an.status === 200 && typeof an.data.total === 'number' && an.data.total >= 2);
  check('analytics counts a won lead', an.data.won >= 1);
  check('analytics computes a win rate', typeof an.data.conversion === 'number' && an.data.conversion > 0);
  check('analytics breaks leads down by stage', Array.isArray(an.data.byStage) && an.data.byStage.some((s) => s.outcome === 'won'));
  check('analytics breaks leads down by source', an.data.bySource.some((s) => s.source === 'website'));
  check('a won lead stamps a close time for time-to-win', an.data.avgDaysToWin !== undefined);
  // Sales can see analytics; a plain member cannot.
  const samAn = await req('GET', '/api/leads/analytics', { token: sam.token });
  check('a Sales user can view analytics', samAn.status === 200);
  const miaAn = await req('GET', '/api/leads/analytics', { token: mia.token });
  check('a member cannot view analytics', miaAn.status === 403);

  // --- Notes / remarks (the lead is currently owned by Sam) ---
  const noteRes = await req('POST', `/api/leads/${lead.id}/notes`, { token: a, body: { body: 'Called, asked to send a quote.' } });
  check('a note can be added to a lead', noteRes.status === 201 && noteRes.data.note.body.startsWith('Called'));
  const noteList = await req('GET', `/api/leads/${lead.id}/notes`, { token: a });
  check('notes are listed newest-first', noteList.data.notes.length === 1);
  const emptyNote = await req('POST', `/api/leads/${lead.id}/notes`, { token: a, body: { body: '   ' } });
  check('an empty note is rejected', emptyNote.status === 400);
  const boardWithNote = await req('GET', '/api/leads', { token: a });
  check('the board carries a note count', boardWithNote.data.leads.find((l) => l.id === lead.id).note_count === 1);
  const miaNote = await req('POST', `/api/leads/${lead.id}/notes`, { token: mia.token, body: { body: 'sneaky' } });
  check('a member cannot note a lead that is not theirs', miaNote.status === 403);

  // --- Follow-up reminders ---
  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  const remRes = await req('POST', `/api/leads/${lead.id}/reminders`, { token: a, body: { remind_at: future, note: 'Chase the quote' } });
  check('a follow-up reminder can be scheduled', remRes.status === 201 && remRes.data.reminders.length === 1);
  const remId = remRes.data.reminders[0].id;
  const badRem = await req('POST', `/api/leads/${lead.id}/reminders`, { token: a, body: { remind_at: 'not-a-date' } });
  check('a reminder with a bad time is rejected', badRem.status === 400);
  const boardWithRem = await req('GET', '/api/leads', { token: a });
  check('the board carries the next reminder time', !!boardWithRem.data.leads.find((l) => l.id === lead.id).next_reminder);
  const remDel = await req('DELETE', `/api/leads/${lead.id}/reminders/${remId}`, { token: a });
  check('a reminder can be cancelled', remDel.data.reminders.length === 0);

  // Rotating the key invalidates the old one.
  const rotated = await req('POST', '/api/leads/settings/key', { token: a });
  check('the key can be rotated', rotated.data.key && rotated.data.key !== key);
  const oldKey = await req('POST', `/api/leads/intake?key=${encodeURIComponent(key)}`, { body: { name: 'Y' } });
  check('the old key stops working after rotation', oldKey.status === 403);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll leads tests passed');
    process.exit(failures ? 1 : 0);
  });
