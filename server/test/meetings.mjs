/**
 * Scheduled meetings: create + invite + notify, list, collaborative notes,
 * host-only reschedule/cancel, and access control. Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MEETINGS_PORT || 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-meet-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'meet-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Advisory Co', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;
  await req('POST', '/api/admin/users', { token: a, body: { name: 'Mia', email: 'mia@a.test', password: 'secret123', role: 'member' } });
  const mia = (await req('POST', '/api/auth/login', { body: { email: 'mia@a.test', password: 'secret123' } })).data;

  // Host schedules a meeting and invites Mia.
  const create = await req('POST', '/api/meetings', { token: a, body: {
    title: 'Quarterly review', scheduled_at: '2026-12-01T10:00:00Z', duration_min: 45, call_type: 'video', invitee_ids: [mia.user.id],
  } });
  check('a meeting can be scheduled', create.status === 201 && create.data.meeting.title === 'Quarterly review');
  check('the host is recorded', create.data.meeting.is_host === true && create.data.meeting.host.id === owner.data.user.id);
  check('the invitee is attached', create.data.meeting.invitees.some((u) => u.id === mia.user.id));
  const mId = create.data.meeting.id;
  const badTime = await req('POST', '/api/meetings', { token: a, body: { title: 'x', scheduled_at: 'not-a-date' } });
  check('an invalid time is rejected', badTime.status === 400);

  // The invitee was notified and sees it in their list.
  const notifs = await req('GET', '/api/notifications', { token: mia.token });
  check('the invitee got a meeting invite', (notifs.data.notifications || notifs.data || []).some((n) => n.type === 'meeting_invite'));
  const miaList = await req('GET', '/api/meetings', { token: mia.token });
  check('the invitee sees the meeting', miaList.data.meetings.some((m) => m.id === mId) && miaList.data.meetings.find((m) => m.id === mId).is_host === false);

  // Notes are collaborative: an invitee can write them.
  const note = await req('PATCH', `/api/meetings/${mId}`, { token: mia.token, body: { notes: 'Agenda: pipeline, hiring' } });
  check('an invitee can edit the notes', note.data.meeting.notes.includes('Agenda'));

  // But only the host can reschedule.
  const miaResched = await req('PATCH', `/api/meetings/${mId}`, { token: mia.token, body: { scheduled_at: '2026-12-02T10:00:00Z' } });
  check('an invitee cannot reschedule', miaResched.status === 403);
  const resched = await req('PATCH', `/api/meetings/${mId}`, { token: a, body: { scheduled_at: '2026-12-02T09:30:00Z' } });
  check('the host can reschedule', resched.status === 200 && resched.data.meeting.scheduled_at.startsWith('2026-12-02'));
  const reNotif = await req('GET', '/api/notifications', { token: mia.token });
  check('a reschedule notifies invitees', (reNotif.data.notifications || reNotif.data || []).some((n) => n.type === 'meeting_update'));

  // An outsider can't see or delete the meeting.
  await req('POST', '/api/admin/users', { token: a, body: { name: 'Sam', email: 'sam@a.test', password: 'secret123', role: 'member' } });
  const sam = (await req('POST', '/api/auth/login', { body: { email: 'sam@a.test', password: 'secret123' } })).data;
  const samGet = await req('GET', `/api/meetings/${mId}`, { token: sam.token });
  check('a non-participant cannot open the meeting', samGet.status === 403);
  const samList = await req('GET', '/api/meetings', { token: sam.token });
  check('a non-participant does not see it in their list', !samList.data.meetings.some((m) => m.id === mId));
  const miaDel = await req('DELETE', `/api/meetings/${mId}`, { token: mia.token });
  check('an invitee cannot delete the meeting', miaDel.status === 403);

  // Host cancels.
  const del = await req('DELETE', `/api/meetings/${mId}`, { token: a });
  check('the host can cancel the meeting', del.status === 200);
  const gone = await req('GET', `/api/meetings/${mId}`, { token: a });
  check('a cancelled meeting is gone', gone.status === 404);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll meetings tests passed');
    process.exit(failures ? 1 : 0);
  });
