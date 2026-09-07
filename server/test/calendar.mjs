/**
 * Personal calendar events: create, list-by-range, edit, all-day, reminders,
 * per-user isolation, and the ICS feed carrying meetings + events.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CAL_PORT || 3993;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-cal-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'cal-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
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

  // Create a timed event with a reminder.
  const ev = await req('POST', '/api/calendar-events', { token: a, body: { title: 'Call the bank', starts_at: '2026-12-10T09:00:00Z', ends_at: '2026-12-10T09:30:00Z', remind_min: 10, notes: 'ask about OD limit' } });
  check('an event can be created', ev.status === 201 && ev.data.event.title === 'Call the bank');
  check('the reminder offset is stored', ev.data.event.remind_min === 10);
  const badEv = await req('POST', '/api/calendar-events', { token: a, body: { title: 'x', starts_at: 'nope' } });
  check('an invalid start is rejected', badEv.status === 400);

  // List within the month range.
  const inRange = await req('GET', '/api/calendar-events?from=2026-12-01&to=2026-12-31', { token: a });
  check('the event shows within its range', inRange.data.events.some((e) => e.id === ev.data.event.id));
  const outRange = await req('GET', '/api/calendar-events?from=2026-11-01&to=2026-11-30', { token: a });
  check('the event is absent from another month', !outRange.data.events.some((e) => e.id === ev.data.event.id));

  // An all-day event.
  const allDay = await req('POST', '/api/calendar-events', { token: a, body: { title: 'Holiday', all_day: true, starts_at: '2026-12-25' } });
  check('an all-day event is created', allDay.status === 201 && allDay.data.event.all_day === 1 && allDay.data.event.starts_at.startsWith('2026-12-25'));

  // Edit it.
  const edit = await req('PATCH', `/api/calendar-events/${ev.data.event.id}`, { token: a, body: { title: 'Call the bank (OD)' } });
  check('an event can be edited', edit.data.event.title === 'Call the bank (OD)');

  // Events are private to their owner.
  const miaList = await req('GET', '/api/calendar-events?from=2026-12-01&to=2026-12-31', { token: mia.token });
  check("a teammate does not see another user's events", !miaList.data.events.some((e) => e.id === ev.data.event.id));
  const miaEdit = await req('PATCH', `/api/calendar-events/${ev.data.event.id}`, { token: mia.token, body: { title: 'hacked' } });
  check("a teammate cannot edit another user's event", miaEdit.status === 404);

  // The ICS feed includes meetings and personal events.
  await req('POST', '/api/meetings', { token: a, body: { title: 'Board call', scheduled_at: '2026-12-15T10:00:00Z', duration_min: 60 } });
  const urlRes = await req('GET', '/api/calendar/url', { token: a });
  const ics = await (await fetch(urlRes.data.url)).text();
  check('the ICS feed carries the personal event', ics.includes('Call the bank (OD)'));
  check('the ICS feed carries the meeting', ics.includes('Board call'));
  check('the ICS feed is a valid calendar', ics.startsWith('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'));

  // Delete.
  const del = await req('DELETE', `/api/calendar-events/${ev.data.event.id}`, { token: a });
  check('an event can be deleted', del.status === 200);
  const after = await req('GET', '/api/calendar-events?from=2026-12-01&to=2026-12-31', { token: a });
  check('a deleted event is gone', !after.data.events.some((e) => e.id === ev.data.event.id));
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll calendar tests passed');
    process.exit(failures ? 1 : 0);
  });
