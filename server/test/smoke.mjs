/**
 * End-to-end smoke test: boots the real server against a throwaway
 * database, then exercises the REST API (auth, channels, DMs, tasks,
 * workflows) and the socket layer (messaging, presence, call signaling).
 * Exits 0 on success, 1 on any failure.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.SMOKE_PORT || 3999;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-smoke-'));

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'smoke-test-secret' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/api/auth/me');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('Server did not start within 10s');
}

async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();

  console.log('Auth');
  const alice = await req('POST', '/api/auth/register', {
    body: { name: 'Alice', email: 'alice@smoke.test', password: 'secret123' },
  });
  const bob = await req('POST', '/api/auth/register', {
    body: { name: 'Bob', email: 'bob@smoke.test', password: 'secret123' },
  });
  check('register returns token', alice.status === 201 && !!alice.data.token);
  check('first registrant is super admin', alice.data.user.role === 'admin');
  check('later registrant is a member', bob.data.user.role === 'member');
  const dupe = await req('POST', '/api/auth/register', {
    body: { name: 'Alice2', email: 'alice@smoke.test', password: 'secret123' },
  });
  check('duplicate email rejected', dupe.status === 409);
  const badLogin = await req('POST', '/api/auth/login', {
    body: { email: 'alice@smoke.test', password: 'wrong' },
  });
  check('wrong password rejected', badLogin.status === 401);
  const a = alice.data.token;
  const b = bob.data.token;
  const bobId = bob.data.user.id;

  console.log('Channels & DMs');
  const chans = await req('GET', '/api/channels', { token: a });
  check('auto-joined #general', chans.data.channels.some((c) => c.name === 'general'));
  const eng = await req('POST', '/api/channels', { token: a, body: { name: 'Eng Team' } });
  check('channel name slugified', eng.data.name === 'eng-team');
  const joined = await req('POST', `/api/channels/${eng.data.id}/join`, { token: b });
  check('another user can join public channel', joined.status === 200);
  const dm = await req('POST', `/api/channels/dm/${bobId}`, { token: a });
  check('DM channel created', dm.status === 201 && dm.data.is_dm === 1);
  const dmAgain = await req('POST', `/api/channels/dm/${bobId}`, { token: a });
  check('DM is reused, not duplicated', dmAgain.status === 200 && dmAgain.data.id === dm.data.id);
  const noAuth = await req('GET', '/api/channels');
  check('unauthenticated request rejected', noAuth.status === 401);

  console.log('Workflows');
  const wfs = await req('GET', '/api/workflows', { token: a });
  check('default workflow seeded', wfs.data.workflows.length === 1 && wfs.data.workflows[0].stages.length === 4);
  const wf = await req('POST', '/api/workflows', {
    token: a,
    body: { name: 'Onboarding', stages: ['Intake', 'KYC', 'Signed'] },
  });
  check('custom workflow created', wf.status === 201 && wf.data.stages.length === 3);
  check('last stage marked done', wf.data.stages[2].is_done === 1);
  const badWf = await req('POST', '/api/workflows', { token: a, body: { name: 'X', stages: ['Only'] } });
  check('workflow needs 2+ stages', badWf.status === 400);

  console.log('Tasks');
  const task = await req('POST', '/api/tasks', {
    token: a,
    body: { title: 'Ship it', workflow_id: wf.data.id, assignee_id: bobId, priority: 'high' },
  });
  check('task created in first stage', task.status === 201 && task.data.stage.name === 'Intake');
  check('task assigned', task.data.assignee?.id === bobId);
  const moved = await req('PATCH', `/api/tasks/${task.data.id}`, {
    token: b,
    body: { stage_id: wf.data.stages[1].id },
  });
  check('task moved to next stage', moved.data.stage?.name === 'KYC');
  const badMove = await req('PATCH', `/api/tasks/${task.data.id}`, { token: b, body: { stage_id: 1 } });
  check('cross-workflow stage move rejected', badMove.status === 400);
  const comment = await req('POST', `/api/tasks/${task.data.id}/comments`, {
    token: b,
    body: { content: 'On it' },
  });
  check('comment added', comment.status === 201);
  const detail = await req('GET', `/api/tasks/${task.data.id}`, { token: a });
  check(
    'activity log recorded create/assign/move',
    detail.data.activity.length >= 3 && detail.data.activity.some((x) => x.action.includes('KYC'))
  );
  const delStage = await req('DELETE', `/api/workflows/${wf.data.id}/stages/${wf.data.stages[1].id}`, { token: a });
  check('stage with tasks cannot be deleted', delStage.status === 400);

  console.log('Task depth');
  const project = await req('POST', '/api/projects', { token: a, body: { name: 'Acme', color: '#2eb67d' } });
  check('project created', project.status === 201);
  const projId = project.data.id;
  const deepTask = await req('POST', '/api/tasks', {
    token: a,
    body: { title: 'Deep task', workflow_id: wf.data.id, project_id: projId, assignee_id: bobId, priority: 'high', due_date: '2020-01-01', tags: ['urgent', 'client'] },
  });
  check('task created with project + tags', deepTask.data.project?.id === projId && deepTask.data.tags.includes('urgent'));
  check('creator and assignee auto-watch', deepTask.data.watcher_ids.includes(1) && deepTask.data.watcher_ids.includes(bobId));
  const dtId = deepTask.data.id;

  await req('POST', `/api/tasks/${dtId}/checklist`, { token: a, body: { text: 'Step one' } });
  const cl = await req('POST', `/api/tasks/${dtId}/checklist`, { token: a, body: { text: 'Step two' } });
  check('checklist items added', cl.data.length === 2);
  const toggled = await req('PATCH', `/api/tasks/${dtId}/checklist/${cl.data[0].id}`, { token: a, body: { is_done: true } });
  check('checklist item toggled', toggled.data.find((i) => i.id === cl.data[0].id).is_done === 1);
  const dtDetail = await req('GET', `/api/tasks/${dtId}`, { token: a });
  check('task reports checklist progress 1/2', dtDetail.data.task.checklist_done === 1 && dtDetail.data.task.checklist_total === 2);

  const addTag = await req('POST', `/api/tasks/${dtId}/tags`, { token: a, body: { tag: 'Q3' } });
  check('tag added (lowercased)', addTag.data.tags.includes('q3'));
  const rmTag = await req('DELETE', `/api/tasks/${dtId}/tags/urgent`, { token: a });
  check('tag removed', !rmTag.data.tags.includes('urgent'));
  const tagsMeta = await req('GET', '/api/tasks/meta/tags', { token: a });
  check('distinct tags listed', tagsMeta.data.tags.includes('client'));

  const unwatch = await req('DELETE', `/api/tasks/${dtId}/watch`, { token: b });
  check('watcher removed', !unwatch.data.watcher_ids.includes(bobId));
  const rewatch = await req('POST', `/api/tasks/${dtId}/watch`, { token: b });
  check('watcher re-added', rewatch.data.watcher_ids.includes(bobId));

  const tfd = new FormData();
  tfd.append('files', new Blob(['spec doc'], { type: 'text/plain' }), 'spec.txt');
  const tup = await (await fetch(BASE + '/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${a}` }, body: tfd })).json();
  const linked = await req('POST', `/api/tasks/${dtId}/attachments`, { token: a, body: { attachment_ids: [tup.attachments[0].id] } });
  check('attachment linked to task', linked.data.length === 1);
  const taskFileDl = await fetch(`${BASE}/api/uploads/${tup.attachments[0].id}?token=${b}`);
  check('teammate can download task attachment', taskFileDl.status === 200);

  const byProj = await req('GET', `/api/tasks?project_id=${projId}`, { token: a });
  check('filter by project', byProj.data.tasks.every((t) => t.project?.id === projId) && byProj.data.tasks.length === 1);
  const byTag = await req('GET', '/api/tasks?tag=client', { token: a });
  check('filter by tag', byTag.data.tasks.some((t) => t.id === dtId));
  const overdueList = await req('GET', '/api/tasks?overdue=1', { token: a });
  check('filter overdue', overdueList.data.tasks.some((t) => t.id === dtId));
  const watchingList = await req('GET', '/api/tasks?watching=1', { token: b });
  check('filter watching', watchingList.data.tasks.some((t) => t.id === dtId));

  await req('DELETE', `/api/projects/${projId}`, { token: a });
  const afterProjDel = await req('GET', `/api/tasks/${dtId}`, { token: a });
  check('task detaches when project deleted', afterProjDel.data.task.project === null);

  console.log('Task templates');
  const tmpl = await req('POST', '/api/templates', {
    token: a,
    body: {
      name: 'Company Registration', default_priority: 'high', default_workflow_id: wf.data.id,
      tags: ['registration', 'client'], steps: ['Collect KYC', 'Name reservation', 'File incorporation', 'PAN & TAN'],
    },
  });
  check('template created with steps + tags', tmpl.status === 201 && tmpl.data.steps.length === 4 && tmpl.data.tags.includes('registration'));
  check('template records default board', tmpl.data.default_workflow?.id === wf.data.id);
  const tmplId = tmpl.data.id;

  const tmplUpdate = await req('PATCH', `/api/templates/${tmplId}`, { token: a, body: { steps: ['Collect KYC', 'Name reservation', 'File incorporation', 'PAN & TAN', 'GST registration'] } });
  check('template steps replaced on update', tmplUpdate.data.steps.length === 5 && tmplUpdate.data.steps[4].text === 'GST registration');

  const fromTmpl = await req('POST', '/api/tasks', {
    token: a,
    body: {
      title: 'Company Registration – Acme', workflow_id: wf.data.id, priority: 'high',
      tags: tmplUpdate.data.tags, checklist: tmplUpdate.data.steps.map((s) => s.text),
    },
  });
  check('task created from template has tags', fromTmpl.data.tags.includes('client'));
  check('task created from template has checklist', fromTmpl.data.checklist_total === 5);
  const fromDetail = await req('GET', `/api/tasks/${fromTmpl.data.id}`, { token: a });
  check('template steps copied into task checklist', fromDetail.data.checklist.map((s) => s.text).includes('GST registration'));

  const tmplDel = await req('DELETE', `/api/templates/${tmplId}`, { token: a });
  check('template deleted', tmplDel.status === 200);
  const afterTmplDel = await req('GET', `/api/tasks/${fromTmpl.data.id}`, { token: a });
  check('task survives template deletion', afterTmplDel.status === 200 && afterTmplDel.data.task.checklist_total === 5);

  console.log('Recurrence & reminders');
  const recTask = await req('POST', '/api/tasks', {
    token: a,
    body: { title: 'Weekly compliance', workflow_id: wf.data.id, priority: 'medium', due_date: '2026-07-10', recurrence: 'weekly', tags: ['compliance'], checklist: ['Gather docs'], reminders: ['2026-07-09T09:00:00.000Z'] },
  });
  check('task created with recurrence', recTask.status === 201 && recTask.data.recurrence === 'weekly');
  const recId = recTask.data.id;
  const badRec = await req('POST', '/api/tasks', { token: a, body: { title: 'x', workflow_id: wf.data.id, recurrence: 'hourly' } });
  check('invalid recurrence rejected', badRec.status === 400);

  const recDetail = await req('GET', `/api/tasks/${recId}`, { token: a });
  check('reminder created with the task', recDetail.data.reminders.length === 1);
  check('unsent reminder count surfaced on task', recDetail.data.task.reminder_count === 1);

  const remAdd = await req('POST', `/api/tasks/${recId}/reminders`, { token: a, body: { remind_at: '2026-07-08T09:00:00.000Z' } });
  check('reminder added via endpoint', Array.isArray(remAdd.data) && remAdd.data.length === 2);
  const badRem = await req('POST', `/api/tasks/${recId}/reminders`, { token: a, body: { remind_at: 'not-a-date' } });
  check('invalid reminder time rejected', badRem.status === 400);
  const remDel = await req('DELETE', `/api/tasks/${recId}/reminders/${remAdd.data[0].id}`, { token: a });
  check('reminder removed', remDel.data.length === 1);

  const beforeList = await req('GET', `/api/tasks?workflow_id=${wf.data.id}`, { token: a });
  const countBefore = beforeList.data.tasks.length;
  const doneStageId = wf.data.stages[2].id; // 'Signed' is a done stage
  await req('PATCH', `/api/tasks/${recId}`, { token: a, body: { stage_id: doneStageId } });
  const afterList = await req('GET', `/api/tasks?workflow_id=${wf.data.id}`, { token: a });
  check('completing a recurring task spawns the next occurrence', afterList.data.tasks.length === countBefore + 1);
  const nextOcc = afterList.data.tasks.find((t) => t.title === 'Weekly compliance' && t.id !== recId);
  check('next occurrence due one week later', !!nextOcc && nextOcc.due_date === '2026-07-17');
  check('next occurrence keeps recurrence + tags', !!nextOcc && nextOcc.recurrence === 'weekly' && nextOcc.tags.includes('compliance'));
  const nextDetail = nextOcc ? await req('GET', `/api/tasks/${nextOcc.id}`, { token: a }) : { data: {} };
  check('next occurrence copies checklist (reset)', nextDetail.data.checklist?.length === 1 && nextDetail.data.checklist[0].is_done === 0);
  check('next occurrence shifts the reminder forward a week', nextDetail.data.reminders?.some((r) => r.remind_at.startsWith('2026-07-16')));

  // A one-off task moved to done must NOT spawn anything.
  const oneOff = await req('POST', '/api/tasks', { token: a, body: { title: 'One-off', workflow_id: wf.data.id, due_date: '2026-07-10' } });
  const beforeOne = (await req('GET', `/api/tasks?workflow_id=${wf.data.id}`, { token: a })).data.tasks.length;
  await req('PATCH', `/api/tasks/${oneOff.data.id}`, { token: a, body: { stage_id: doneStageId } });
  const afterOne = (await req('GET', `/api/tasks?workflow_id=${wf.data.id}`, { token: a })).data.tasks.length;
  check('non-recurring task does not spawn a copy', afterOne === beforeOne);

  console.log('Admin & roles');
  const memberBlocked = await req('GET', '/api/admin/users', { token: b });
  check('member cannot reach admin routes', memberBlocked.status === 403);
  const roster = await req('GET', '/api/admin/users', { token: a });
  check('admin lists full roster', roster.status === 200 && roster.data.users.length >= 2);

  const created = await req('POST', '/api/admin/users', {
    token: a,
    body: { name: 'Carol', email: 'carol@smoke.test', password: 'secret123', title: 'Analyst' },
  });
  check('admin creates a user directly', created.status === 201 && created.data.role === 'member');
  const carolLogin = await req('POST', '/api/auth/login', { body: { email: 'carol@smoke.test', password: 'secret123' } });
  check('admin-created user can log in', carolLogin.status === 200);
  const carolId = created.data.id;

  const promoted = await req('PATCH', `/api/admin/users/${carolId}`, { token: a, body: { role: 'admin' } });
  check('admin promotes a member', promoted.data.role === 'admin');
  const demoted = await req('PATCH', `/api/admin/users/${carolId}`, { token: a, body: { role: 'member' } });
  check('admin demotes back to member', demoted.data.role === 'member');

  const deactivated = await req('POST', `/api/admin/users/${carolId}/deactivate`, { token: a });
  check('admin deactivates a user', deactivated.data.active === 0);
  const deactivatedLogin = await req('POST', '/api/auth/login', { body: { email: 'carol@smoke.test', password: 'secret123' } });
  check('deactivated user cannot log in', deactivatedLogin.status === 403);
  const directory = await req('GET', '/api/users', { token: a });
  check('deactivated user hidden from directory', !directory.data.users.some((u) => u.id === carolId));
  const reactivated = await req('POST', `/api/admin/users/${carolId}/reactivate`, { token: a });
  check('admin reactivates a user', reactivated.data.active === 1);

  const selfDeactivate = await req('POST', `/api/admin/users/${alice.data.user.id}/deactivate`, { token: a });
  check('admin cannot deactivate themselves', selfDeactivate.status === 400);
  const demoteLastAdmin = await req('PATCH', `/api/admin/users/${alice.data.user.id}`, { token: a, body: { role: 'member' } });
  check('cannot demote the only admin', demoteLastAdmin.status === 400);

  const reset = await req('POST', `/api/admin/users/${carolId}/reset-password`, { token: a, body: { password: 'newpass123' } });
  check('admin resets a password', reset.status === 200);
  const carolReloggedIn = await req('POST', '/api/auth/login', { body: { email: 'carol@smoke.test', password: 'newpass123' } });
  check('user logs in with reset password', carolReloggedIn.status === 200);

  console.log('Task visibility');
  const carolTok = carolReloggedIn.data.token;
  // Admin creates a task for Carol; Bob (an uninvolved member) must not see it.
  const secret = await req('POST', '/api/tasks', { token: a, body: { title: 'Alice private task', workflow_id: wf.data.id, assignee_id: carolId } });
  check('admin creates a task assigned to a member', secret.status === 201);
  const bobList = await req('GET', '/api/tasks', { token: b });
  check('member does not see tasks they are not involved in', !bobList.data.tasks.some((t) => t.id === secret.data.id));
  const bobOpen = await req('GET', `/api/tasks/${secret.data.id}`, { token: b });
  check('member is blocked from opening an unrelated task', bobOpen.status === 403);
  const carolList = await req('GET', '/api/tasks', { token: carolTok });
  check('assignee sees their own task', carolList.data.tasks.some((t) => t.id === secret.data.id));
  const adminList = await req('GET', '/api/tasks', { token: a });
  check('admin supervises every task', adminList.data.tasks.some((t) => t.id === secret.data.id));
  const adminOpen = await req('GET', `/api/tasks/${secret.data.id}`, { token: a });
  check('admin can open any task', adminOpen.status === 200);
  const forBob = await req('POST', '/api/tasks', { token: a, body: { title: 'For Bob', workflow_id: wf.data.id, assignee_id: bobId } });
  const bobList2 = await req('GET', '/api/tasks', { token: b });
  check('member sees tasks assigned to them', bobList2.data.tasks.some((t) => t.id === forBob.data.id));
  check('member list is scoped to involvement only', bobList2.data.tasks.every((t) => t.creator?.id === bobId || t.assignee?.id === bobId || t.watcher_ids.includes(bobId)));

  console.log('Task status & deletion');
  const st = await req('POST', '/api/tasks', { token: a, body: { title: 'Status task', workflow_id: wf.data.id, assignee_id: bobId } });
  check('new task defaults to In Progress', st.data.status === 'in_progress');
  const stId = st.data.id;
  const toCompleted = await req('PATCH', `/api/tasks/${stId}`, { token: b, body: { status: 'completed' } });
  check('member can change status to Completed', toCompleted.status === 200 && toCompleted.data.status === 'completed');
  const holdNoReason = await req('PATCH', `/api/tasks/${stId}`, { token: b, body: { status: 'hold' } });
  check('Hold without a reason is rejected', holdNoReason.status === 400);
  const holdReason = await req('PATCH', `/api/tasks/${stId}`, { token: b, body: { status: 'hold', status_reason: 'Waiting on client documents' } });
  check('Hold with a reason is accepted', holdReason.status === 200 && holdReason.data.status === 'hold' && holdReason.data.status_reason.includes('client documents'));
  const cancelNoReason = await req('PATCH', `/api/tasks/${stId}`, { token: b, body: { status: 'cancelled' } });
  check('Cancel without a reason is rejected', cancelNoReason.status === 400);
  const badStatus = await req('PATCH', `/api/tasks/${stId}`, { token: b, body: { status: 'archived' } });
  check('invalid status rejected', badStatus.status === 400);
  const backToProgress = await req('PATCH', `/api/tasks/${stId}`, { token: b, body: { status: 'in_progress' } });
  check('reason cleared when leaving Hold/Cancelled', backToProgress.data.status === 'in_progress' && backToProgress.data.status_reason === '');

  const memberDelete = await req('DELETE', `/api/tasks/${stId}`, { token: b });
  check('member cannot delete a task', memberDelete.status === 403);
  const stStill = await req('GET', `/api/tasks/${stId}`, { token: a });
  check('task survives a member delete attempt', stStill.status === 200);
  const adminDelete = await req('DELETE', `/api/tasks/${stId}`, { token: a });
  check('admin can delete a task', adminDelete.status === 200);

  const recS = await req('POST', '/api/tasks', { token: a, body: { title: 'Recurring via status', workflow_id: wf.data.id, due_date: '2026-07-10', recurrence: 'daily' } });
  const beforeS = (await req('GET', `/api/tasks?workflow_id=${wf.data.id}`, { token: a })).data.tasks.length;
  await req('PATCH', `/api/tasks/${recS.data.id}`, { token: a, body: { status: 'completed' } });
  const afterS = (await req('GET', `/api/tasks?workflow_id=${wf.data.id}`, { token: a })).data.tasks.length;
  check('completing via status spawns the next occurrence', afterS === beforeS + 1);

  console.log('Collabs');
  const collab = await req('POST', '/api/collabs', {
    token: a,
    body: { name: 'Client X War Room', description: 'External project space', member_ids: [bobId], who_can_invite: 'mods', history_visible: false },
  });
  check('collab created as a private group space', collab.status === 201 && collab.data.is_collab === 1 && collab.data.is_dm === 0);
  check('creator is the owner', collab.data.owner_id === alice.data.user.id && collab.data.my_role === 'owner');
  const collabId = collab.data.id;
  check('members added to the collab', collab.data.members.length === 2 && collab.data.members.find((m) => m.id === bobId)?.channel_role === 'member');

  const aChans = await req('GET', '/api/channels', { token: a });
  check('collab excluded from the regular channels list', !aChans.data.channels.some((c) => c.id === collabId));
  const bCollabs = await req('GET', '/api/collabs', { token: b });
  check('member sees the collab in their list', bCollabs.data.collabs.some((c) => c.id === collabId));

  const bInvite = await req('POST', `/api/collabs/${collabId}/members`, { token: b, body: { user_ids: [carolId] } });
  check('plain member cannot invite when invites are mods-only', bInvite.status === 403);
  const aInvite = await req('POST', `/api/collabs/${collabId}/members`, { token: a, body: { user_ids: [carolId] } });
  check('owner can invite members', aInvite.status === 201 && aInvite.data.members.some((m) => m.id === carolId));

  const modPatch = await req('PATCH', `/api/collabs/${collabId}`, { token: a, body: { moderator_ids: [bobId] } });
  check('owner promotes a moderator', modPatch.data.members.find((m) => m.id === bobId)?.channel_role === 'moderator');
  const bInvite2 = await req('POST', `/api/collabs/${collabId}/members`, { token: b, body: { user_ids: [] } });
  check('a moderator may invite', bInvite2.status === 201);

  const dave = await req('POST', '/api/admin/users', { token: a, body: { name: 'Dave', email: 'dave@smoke.test', password: 'secret123' } });
  const daveTok = (await req('POST', '/api/auth/login', { body: { email: 'dave@smoke.test', password: 'secret123' } })).data.token;
  const daveGet = await req('GET', `/api/collabs/${collabId}`, { token: daveTok });
  check('non-member is blocked from a collab', daveGet.status === 403);
  check('non-member does not list the collab', !(await req('GET', '/api/collabs', { token: daveTok })).data.collabs.some((c) => c.id === collabId));

  const carolPatch = await req('PATCH', `/api/collabs/${collabId}`, { token: carolTok, body: { who_can_post: 'mods' } });
  check('non-manager cannot change collab settings', carolPatch.status === 403);
  const permPatch = await req('PATCH', `/api/collabs/${collabId}`, { token: a, body: { who_can_post: 'all', history_visible: true } });
  check('owner updates permissions', permPatch.data.who_can_post === 'all' && permPatch.data.history_visible === 1);

  const carolLeave = await req('DELETE', `/api/collabs/${collabId}/members/${carolId}`, { token: carolTok });
  check('a member can leave a collab', carolLeave.status === 200 && !carolLeave.data.members.some((m) => m.id === carolId));
  const removeOwner = await req('DELETE', `/api/collabs/${collabId}/members/${alice.data.user.id}`, { token: a });
  check('the owner cannot be removed', removeOwner.status === 400);

  // A separate mods-only collab for the socket posting checks below.
  const collab2 = await req('POST', '/api/collabs', { token: a, body: { name: 'Announcements', member_ids: [bobId], who_can_post: 'mods' } });
  const collab2Id = collab2.data.id;

  console.log('Sockets');
  const generalId = chans.data.channels.find((c) => c.name === 'general').id;
  const sockA = io(BASE, { auth: { token: a } });
  const sockB = io(BASE, { auth: { token: b } });
  const events = { message: false, presence: false, call: false, taskAssigned: false };

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    const maybeDone = () => {
      if (Object.values(events).every(Boolean)) {
        clearTimeout(timer);
        resolve();
      }
    };
    sockB.on('message:new', ({ message }) => {
      if (message.content === 'hello bob') { events.message = true; maybeDone(); }
    });
    sockB.on('presence', ({ online_user_ids }) => {
      if (online_user_ids.length >= 2) { events.presence = true; maybeDone(); }
    });
    sockB.on('call:incoming', ({ call_type }) => {
      if (call_type === 'video') { events.call = true; maybeDone(); }
    });
    sockB.on('task:assigned', () => { events.taskAssigned = true; maybeDone(); });
    setTimeout(() => {
      sockA.emit('message:send', { channel_id: generalId, content: 'hello bob' });
      sockA.emit('call:invite', { to_user_id: bobId, call_type: 'video' });
      req('POST', '/api/tasks', {
        token: a,
        body: { title: 'Realtime check', workflow_id: wf.data.id, assignee_id: bobId },
      });
    }, 500);
  });

  check('channel message delivered in real time', events.message);
  check('presence broadcast', events.presence);
  check('call invite signaled', events.call);
  check('assignee notified of new task', events.taskAssigned);

  // Collab posting permissions (who_can_post = 'mods'): bob is a plain member, alice is owner.
  const bobCollabPost = await new Promise((resolve) => sockB.emit('message:send', { channel_id: collab2Id, content: 'may I post?' }, resolve));
  check('plain member blocked from posting in a mods-only collab', !!bobCollabPost.error);
  const ownerCollabPost = await new Promise((resolve) => sockA.emit('message:send', { channel_id: collab2Id, content: 'owner announcement' }, resolve));
  check('owner can post in a mods-only collab', !!ownerCollabPost.message);

  console.log('Notifications & task chat');
  // The earlier task assignment (to bob) should have created a notification.
  const bobNotifs = await req('GET', '/api/notifications', { token: b });
  check('assignment produced a notification', bobNotifs.data.notifications.some((n) => n.type === 'task_assigned'));
  check('unread count reflects notifications', bobNotifs.data.unread_count >= 1);

  // A direct message should surface in the recipient's activity feed.
  await new Promise((resolve) => sockA.emit('message:send', { channel_id: dm.data.id, content: 'hey bob, dm here' }, resolve));
  await new Promise((r) => setTimeout(r, 200));
  const bobDmNotifs = await req('GET', '/api/notifications', { token: b });
  check('direct message surfaces in the activity feed', bobDmNotifs.data.notifications.some((n) => n.type === 'dm'));

  // Task chat: alice and bob join task 1, alice sends -> bob receives + gets a notification.
  let bobGotChat = false;
  let bobChatNotif = false;
  sockB.on('task:chat:new', ({ message }) => { if (message.content === 'chat ping') bobGotChat = true; });
  sockB.on('notification:new', ({ notification }) => { if (notification.type === 'task_chat') bobChatNotif = true; });
  sockA.emit('task:chat:join', task.data.id);
  sockB.emit('task:chat:join', task.data.id);
  await new Promise((r) => setTimeout(r, 200));
  const chatSent = await new Promise((resolve) => sockA.emit('task:chat:send', { task_id: task.data.id, content: 'chat ping' }, resolve));
  check('task chat message accepted', !!chatSent.message);
  await new Promise((r) => setTimeout(r, 300));
  check('task chat delivered to the other participant', bobGotChat);
  check('task chat notified the watcher', bobChatNotif);
  const chatHistory = await req('GET', `/api/tasks/${task.data.id}/chat`, { token: b });
  check('task chat history persisted', chatHistory.data.messages.some((m) => m.content === 'chat ping'));

  const markRead = await req('POST', '/api/notifications/read-all', { token: b });
  check('mark-all-read clears unread count', markRead.data.unread_count === 0);

  console.log('Chat features');
  // Upload a file (REST multipart), then post a message that carries the
  // attachment and an @mention, capturing the new message id from the ack.
  const fd = new FormData();
  fd.append('files', new Blob(['hello attachment'], { type: 'text/plain' }), 'note.txt');
  const upRes = await fetch(BASE + '/api/uploads', {
    method: 'POST', headers: { Authorization: `Bearer ${a}` }, body: fd,
  });
  const upData = await upRes.json();
  check('file upload returns attachment id', upRes.status === 201 && upData.attachments[0]?.id > 0);
  const attId = upData.attachments[0]?.id;

  let bobMentioned = false;
  sockB.on('mention', () => { bobMentioned = true; });
  const sent = await new Promise((resolve) =>
    sockA.emit('message:send', {
      channel_id: generalId, content: 'files for @Bob review', attachment_ids: [attId], mention_user_ids: [bobId],
    }, resolve));
  const msgId = sent.message?.id;
  check('message carries attachment', sent.message?.attachments?.length === 1);
  check('message records mention', sent.message?.mentions?.some((m) => m.id === bobId));
  await new Promise((r) => setTimeout(r, 300));
  check('mentioned user notified over socket', bobMentioned);

  const fileDl = await fetch(`${BASE}/api/uploads/${attId}?token=${a}`);
  check('attachment downloadable with token', fileDl.status === 200);
  const fileNoAuth = await fetch(`${BASE}/api/uploads/${attId}`);
  check('attachment blocked without token', fileNoAuth.status === 401);

  const react = await req('POST', `/api/channels/${generalId}/messages/${msgId}/reactions`, { token: b, body: { emoji: '👍' } });
  check('reaction added', react.data.reactions?.[0]?.count === 1 && react.data.reactions[0].user_ids.includes(bobId));
  const unreact = await req('DELETE', `/api/channels/${generalId}/messages/${msgId}/reactions/${encodeURIComponent('👍')}`, { token: b });
  check('reaction removed', (unreact.data.reactions?.length || 0) === 0);

  const edit = await req('PATCH', `/api/channels/${generalId}/messages/${msgId}`, { token: a, body: { content: 'files for @Bob review (edited)' } });
  check('message edited', !!edit.data.edited_at);
  const badEdit = await req('PATCH', `/api/channels/${generalId}/messages/${msgId}`, { token: b, body: { content: 'nope' } });
  check('cannot edit others message', badEdit.status === 403);

  await new Promise((resolve) => sockA.emit('message:send', { channel_id: generalId, content: 'a threaded reply', parent_id: msgId }, resolve));
  const thread = await req('GET', `/api/channels/${generalId}/messages/${msgId}/thread`, { token: b });
  check('thread returns root + reply', thread.data.root?.id === msgId && thread.data.replies.length === 1);
  check('root reply_count reflects reply', thread.data.root?.reply_count === 1);

  const search = await req('GET', `/api/search?q=${encodeURIComponent('review')}`, { token: b });
  check('search finds the message', search.data.results.some((r) => r.id === msgId));

  const del = await req('DELETE', `/api/channels/${generalId}/messages/${msgId}`, { token: a });
  check('message soft-deleted, content cleared', del.data.is_deleted && del.data.content === '');

  // Conversation-list metadata for the Messenger view.
  const chans2 = await req('GET', '/api/channels', { token: a });
  const generalCh = chans2.data.channels.find((c) => c.name === 'general');
  check('channel carries a last-message preview', !!generalCh?.last_message && typeof generalCh.last_message.content === 'string' && !!generalCh.last_activity);

  console.log('Files');
  const filesRes = await req('GET', '/api/files', { token: a });
  check('files endpoint lists shared files', filesRes.data.files.length >= 1 && filesRes.data.files.every((f) => f.uploader_name && f.context));
  const fileSearch = await req('GET', '/api/files?q=spec', { token: a });
  check('files search filters by name', fileSearch.data.files.every((f) => /spec/i.test(f.original_name)) && fileSearch.data.files.length >= 1);
  check('files carry the owner (uploader)', filesRes.data.files.every((f) => f.uploader_id && f.uploader_name));
  // Bob can't delete Alice's file; Alice (owner) can.
  const specFile = fileSearch.data.files[0];
  const bobDelFile = await req('DELETE', `/api/files/${specFile.id}`, { token: b });
  check('non-owner cannot delete a file', bobDelFile.status === 403);
  const aliceDelFile = await req('DELETE', `/api/files/${specFile.id}`, { token: a });
  check('owner can delete their file', aliceDelFile.status === 200);
  const afterDel = await req('GET', '/api/files?q=spec', { token: a });
  check('deleted file no longer listed', !afterDel.data.files.some((f) => f.id === specFile.id));

  // The deleted file is archived: hidden from everyone, kept for the admin.
  const arch = await req('GET', '/api/admin/files/archived', { token: a });
  check('deleted file appears in the admin archive', arch.data.files.some((f) => f.id === specFile.id && f.deleted_by_name));
  const bobArch = await req('GET', '/api/admin/files/archived', { token: b });
  check('non-admin cannot open the archive', bobArch.status === 403);
  await req('POST', `/api/admin/files/${specFile.id}/restore`, { token: a });
  const afterRestore = await req('GET', '/api/files?q=spec', { token: a });
  check('admin can restore an archived file', afterRestore.data.files.some((f) => f.id === specFile.id));
  const purge = await req('DELETE', `/api/admin/files/${specFile.id}`, { token: a });
  check('admin can permanently delete a file', purge.status === 200);
  const afterPurge = await req('GET', '/api/files?q=spec', { token: a });
  check('permanently deleted file is gone', !afterPurge.data.files.some((f) => f.id === specFile.id));

  sockA.disconnect();
  sockB.disconnect();

  const badSock = io(BASE, { auth: { token: 'garbage' } });
  const authRejected = await new Promise((resolve) => {
    badSock.on('connect_error', () => resolve(true));
    badSock.on('connect', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  badSock.disconnect();
  check('socket rejects bad token', authRejected);
}

main()
  .catch((e) => {
    failures++;
    console.error('FATAL:', e.message);
  })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke tests passed');
    process.exit(failures ? 1 : 0);
  });
