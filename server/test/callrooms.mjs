/**
 * Multi-party call rooms (huddles + ad-hoc conferences): boots the real server
 * and drives the socket signaling — join/roster, peer-joined/left, relay,
 * live-status, room teardown, and conference ring. Exits 1 on any failure.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CALLROOMS_PORT || 3997;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-callrooms-'));

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
};

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'callrooms-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('Server did not start');
}

async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const connect = (token) => new Promise((resolve, reject) => {
  const s = io(BASE, { auth: { token } });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const emit = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const once = (s, ev, timeout = 2000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), timeout);
  s.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

async function main() {
  await waitForServer();

  // Workspace + three approved members.
  const owner = await req('POST', '/api/workspaces', {
    body: { workspace_name: 'Call Co', name: 'Alice', email: 'alice@call.test', password: 'secret123', code: 'boot' },
  });
  const a = owner.data.token;
  const slug = owner.data.workspace.slug;
  const mk = async (name, email) => {
    await req('POST', `/api/workspaces/${slug}/register`, { body: { name, email, password: 'secret123' } });
    const pend = await req('GET', '/api/admin/users/pending', { token: a });
    const id = pend.data.users.find((u) => u.email === email).id;
    await req('POST', `/api/admin/users/${id}/approve`, { token: a });
    const login = await req('POST', '/api/auth/login', { body: { email, password: 'secret123' } });
    return { id, token: login.data.token };
  };
  const bob = await mk('Bob', 'bob@call.test');
  const carol = await mk('Carol', 'carol@call.test');

  // A collab all three share.
  const collab = await req('POST', '/api/collabs', {
    token: a, body: { name: 'War Room', member_ids: [bob.id, carol.id] },
  });
  const collabId = collab.data.id;
  check('collab created for the call tests', collab.status === 201 && !!collabId);

  const sockA = await connect(a);
  const sockB = await connect(bob.token);
  const sockC = await connect(carol.token);
  // Everyone subscribes to the collab channel (for active/ended banners).
  sockB.emit('channel:subscribe', collabId);
  sockC.emit('channel:subscribe', collabId);
  await new Promise((r) => setTimeout(r, 150));

  console.log('Collab huddle');
  // Alice starts the huddle; Bob should see the collab-wide "active" banner.
  const activeBanner = once(sockB, 'call:room:active');
  const aJoin = await emit(sockA, 'call:room:join', { kind: 'collab', target_id: collabId, call_type: 'audio' });
  check('starting a huddle returns the collab room id', aJoin.room_id === `collab:${collabId}`);
  check('the room starts with no other peers', Array.isArray(aJoin.peers) && aJoin.peers.length === 0);
  const banner = await activeBanner;
  check('collab members are told a huddle is live', banner && banner.collab_id === collabId && banner.call_type === 'audio');

  // Bob joins; he sees Alice in the roster and Alice gets a peer-joined event.
  const aPeerJoined = once(sockA, 'call:room:peer-joined');
  const bJoin = await emit(sockB, 'call:room:join', { kind: 'collab', target_id: collabId });
  check('a joiner receives the existing roster', bJoin.peers.length === 1 && bJoin.peers[0].id === owner.data.user.id);
  const pj = await aPeerJoined;
  check('existing peers are notified of the joiner', pj && pj.user.id === bob.id);

  // Live status: a third member querying sees the huddle with 2 people.
  const status = await emit(sockC, 'call:room:status', { collab_id: collabId });
  check('status reports the huddle is active', status.active === true && status.room_id === `collab:${collabId}`);
  check('status lists the current participants', status.peers.length === 2);

  console.log('Signaling relay');
  const relayed = once(sockB, 'call:room:signal');
  sockA.emit('call:room:signal', { room_id: aJoin.room_id, to_user_id: bob.id, data: { sdp: { type: 'offer', sdp: 'x' } } });
  const sig = await relayed;
  check('signaling is relayed to the target peer', sig && sig.from_user_id === owner.data.user.id && sig.data.sdp.type === 'offer');
  // A non-participant cannot be signaled through the room.
  const leaked = once(sockC, 'call:room:signal', 600);
  sockA.emit('call:room:signal', { room_id: aJoin.room_id, to_user_id: carol.id, data: { sdp: {} } });
  check('signaling to a non-participant is dropped', (await leaked) === null);

  console.log('In-call chat');
  const chatMsg = once(sockB, 'call:room:chat');
  sockA.emit('call:room:chat', { room_id: aJoin.room_id, text: 'hi team' });
  const cm = await chatMsg;
  check('in-call chat is relayed to the room', cm && cm.text === 'hi team' && cm.from.id === owner.data.user.id);
  const outsiderChat = once(sockC, 'call:room:chat', 600);
  sockC.emit('call:room:chat', { room_id: aJoin.room_id, text: 'i am not in' });
  check('a non-participant cannot post in-call chat', (await outsiderChat) === null);

  console.log('Leaving & teardown');
  const bLeft = once(sockA, 'call:room:peer-left');
  sockB.emit('call:room:leave', { room_id: aJoin.room_id });
  const left = await bLeft;
  check('remaining peers are told when someone leaves', left && left.user_id === bob.id);

  // Alice leaves too -> room empty -> collab hears it ended.
  const endedBanner = once(sockC, 'call:room:ended');
  sockA.emit('call:room:leave', { room_id: aJoin.room_id });
  const ended = await endedBanner;
  check('an empty huddle ends and the collab is told', ended && ended.collab_id === collabId);
  const afterStatus = await emit(sockC, 'call:room:status', { collab_id: collabId });
  check('status shows no active huddle after teardown', afterStatus.active === false);

  console.log('Access control');
  const dave = await mk('Dave', 'dave@call.test'); // not a collab member
  const sockD = await connect(dave.token);
  const daveJoin = await emit(sockD, 'call:room:join', { kind: 'collab', target_id: collabId });
  check('a non-member cannot join the collab huddle', !!daveJoin.error);

  console.log('Ad-hoc conference');
  // Alice starts a conference (no room id) and rings Carol in.
  const confJoin = await emit(sockA, 'call:room:join', { kind: 'conference', call_type: 'video' });
  check('a conference gets a fresh room id', typeof confJoin.room_id === 'string' && confJoin.room_id.startsWith('conf:'));
  const ring = once(sockC, 'call:room:incoming');
  const inv = await emit(sockA, 'call:room:invite', { room_id: confJoin.room_id, user_ids: [carol.id] });
  check('inviting from a room you are in succeeds', inv.ok === true);
  const incoming = await ring;
  check('the invited teammate is rung', incoming && incoming.room_id === confJoin.room_id && incoming.from.id === owner.data.user.id);
  check('the ring carries the call type', incoming && incoming.call_type === 'video');
  // Someone not in the room cannot invite through it.
  const badInvite = await emit(sockD, 'call:room:invite', { room_id: confJoin.room_id, user_ids: [bob.id] });
  check('a non-participant cannot invite into a room', !!badInvite.error);
  // Joining a conference id that has ended is rejected.
  sockA.emit('call:room:leave', { room_id: confJoin.room_id });
  await new Promise((r) => setTimeout(r, 100));
  const stale = await emit(sockB, 'call:room:join', { kind: 'conference', room_id: confJoin.room_id });
  check('joining an ended conference is rejected', !!stale.error);

  console.log('1:1 call across devices');
  const aliceId = owner.data.user.id;
  // Bob is signed in on a second device.
  const sockB2 = await connect(bob.token);
  const ring1 = once(sockB, 'call:incoming');
  const ring2 = once(sockB2, 'call:incoming');
  sockA.emit('call:invite', { to_user_id: bob.id, call_type: 'audio' });
  check('both of the callee devices ring', !!(await ring1) && !!(await ring2));
  // Bob declines on device 1 -> caller is told, device 2's ring is dismissed.
  const aliceRejected = once(sockA, 'call:rejected');
  const dev2Handled = once(sockB2, 'call:handled');
  sockB.emit('call:reject', { to_user_id: aliceId });
  check('the caller is told the call was declined', !!(await aliceRejected));
  check('the callee other device is dismissed on decline', !!(await dev2Handled));

  // A device that connects while a call is ringing sees it (missed-ring replay).
  sockA.emit('call:invite', { to_user_id: bob.id, call_type: 'video' });
  await new Promise((r) => setTimeout(r, 120));
  const replayed = await new Promise((resolve) => {
    const s = io(BASE, { auth: { token: bob.token } });
    s.on('call:incoming', (d) => resolve({ d, s }));
    setTimeout(() => resolve(null), 3000);
  });
  check('a device connecting mid-ring replays the incoming call', !!replayed && replayed.d.call_type === 'video');
  replayed?.s?.disconnect();
  // Once the call ends, a fresh device no longer sees a stale ring.
  sockA.emit('call:end', { to_user_id: bob.id });
  await new Promise((r) => setTimeout(r, 120));
  const noStale = await new Promise((resolve) => {
    const s = io(BASE, { auth: { token: bob.token } });
    s.on('call:incoming', () => resolve({ stale: true, s }));
    setTimeout(() => resolve({ stale: false, s }), 1500);
  });
  check('no stale ring after the call ends', noStale.stale === false);
  noStale.s.disconnect();
  sockB2.disconnect();

  [sockA, sockB, sockC, sockD].forEach((s) => s.disconnect());
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll call-room tests passed');
    process.exit(failures ? 1 : 0);
  });
