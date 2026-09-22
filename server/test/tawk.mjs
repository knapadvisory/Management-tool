/**
 * Tawk.to live-chat webhook → Leads: contact extraction, phone-from-transcript,
 * anonymous skip, dedupe, and HMAC-SHA1 signature verification.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TAWK_PORT || 3991;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-tawk-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'tawk-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
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
async function tawk(key, payload, secret) {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Tawk-Signature'] = crypto.createHmac('sha1', secret).update(raw).digest('hex');
  const res = await fetch(`${BASE}/api/leads/tawk?key=${encodeURIComponent(key)}`, { method: 'POST', headers, body: raw });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await waitForServer();
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Advisory Co', name: 'Ann', email: 'ann@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token;
  const settings = await req('GET', '/api/leads/settings', { token: a });
  const key = settings.data.key;
  check('the settings expose a Tawk webhook path', settings.data.tawk_path === '/api/leads/tawk');

  // A chat that ended with the visitor's name; phone typed in the transcript.
  const chat = {
    event: 'chat:end', chatId: 'chat-1', property: { url: 'https://knapadvisory.com/services' },
    visitor: { name: 'Priya Sharma', email: 'priya@x.test', city: 'Delhi', country: 'IN' },
    messages: [{ sender: { t: 'v' }, msg: 'Hi, need help with GST. Call me on 98765 43210' }],
  };
  const r1 = await tawk(key, chat);
  check('a Tawk chat becomes a lead', r1.status === 200 && r1.data.ok === true && !!r1.data.lead_id);
  const list = await req('GET', '/api/leads', { token: a });
  const lead = list.data.leads.find((l) => l.name === 'Priya Sharma');
  check('the lead has source "tawk"', lead && lead.source === 'tawk');
  check('the phone is pulled from the chat transcript', lead && lead.phone.replace(/\s/g, '') === '9876543210');
  check('the chat page URL is captured', lead && lead.page_url === 'https://knapadvisory.com/services');

  // The same chat id again is ignored (Tawk retries).
  const dup = await tawk(key, chat);
  check('a repeated chat id is de-duplicated', dup.data.duplicate === true);
  check('no duplicate lead is created', (await req('GET', '/api/leads', { token: a })).data.leads.filter((l) => l.name === 'Priya Sharma').length === 1);

  // An anonymous chat with no contact details is skipped.
  const anon = await tawk(key, { event: 'chat:end', chatId: 'chat-2', visitor: { name: 'V1561719148780935' }, messages: [{ sender: { t: 'v' }, msg: 'just browsing' }] });
  check('an anonymous chat with no contact is skipped', anon.data.skipped === 'no contact info');

  // A ticket carries name + phone in the visitor object.
  const tk = await tawk(key, { event: 'ticket:create', ticketId: 'tk-1', requester: { name: 'Rahul', phone: '9811122233' }, ticket: { subject: 'Company registration', message: 'Please call me' } });
  check('a Tawk ticket becomes a lead', tk.status === 200 && !!tk.data.lead_id);

  // A trickier real-world shape: message is an object, phone under a pre-chat field.
  const tricky = await tawk(key, {
    event: 'chat:end', chatId: 'chat-tricky',
    visitor: { name: 'Meena', email: 'meena@x.test' },
    message: { text: 'Interested in a demo visit' },
    prechat: [{ label: 'Phone', answer: '+91 90000 11111' }],
  });
  check('a tricky payload still becomes a lead', tricky.status === 200 && !!tricky.data.lead_id);
  const meena = (await req('GET', '/api/leads', { token: a })).data.leads.find((l) => l.name === 'Meena');
  check('the enquiry text is read from a message object (not [object Object])', meena && meena.message === 'Interested in a demo visit');
  check('the phone is found under a pre-chat field', meena && meena.phone.replace(/\s/g, '') === '+919000011111');

  // The last raw payload is captured for diagnostics.
  const dbg = await req('GET', '/api/leads/settings/tawk-debug', { token: a });
  check('the last Tawk payload is stored for diagnostics', dbg.data.payload && dbg.data.payload.chatId === 'chat-tricky');

  // Signature enforcement once a secret is set.
  await req('PUT', '/api/leads/settings/tawk-secret', { token: a, body: { secret: 's3cr3t' } });
  const bad = await tawk(key, { event: 'chat:end', chatId: 'chat-9', visitor: { name: 'Nope', email: 'n@x.test' } }); // no signature
  check('an unsigned webhook is rejected once a secret is set', bad.status === 401);
  const good = await tawk(key, { event: 'chat:end', chatId: 'chat-10', visitor: { name: 'Signed', email: 's@x.test' } }, 's3cr3t');
  check('a correctly signed webhook is accepted', good.status === 200 && !!good.data.lead_id);
  const wrong = await tawk(key, { event: 'chat:end', chatId: 'chat-11', visitor: { name: 'X', email: 'x@x.test' } }, 'wrong-secret');
  check('a wrongly signed webhook is rejected', wrong.status === 401);
}

main()
  .catch((e) => { failures++; console.error('FATAL:', e.message); })
  .finally(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll Tawk tests passed');
    process.exit(failures ? 1 : 0);
  });
