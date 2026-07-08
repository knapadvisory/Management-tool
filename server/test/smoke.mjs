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
