import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import db from './db.js';
import { register, login, ssoLogin, signToken, requireAuth, requireAdmin, blockGuests, publicUser, workspaceSignupCodeRequired, allowedSignupDomains, createWorkspaceAdmin, updateOwnProfile, changeOwnPassword, createGuest, findReturningGuest, createPasswordReset, findPasswordReset, applyPasswordReset, userByEmail, AVATAR_COLORS } from './auth.js';
import { enabledProviders, providerConfigured, authUrl as oauthAuthUrl, signState, verifyState, exchangeCodeForIdentity } from './oauth.js';
import crypto from 'crypto';
import { buildUserCalendar } from './ical.js';
import { emailEnabled, sendMail, layout, button } from './email.js';
import { pushEnabled, getVapidPublicKey } from './push.js';
import { createWorkspace, workspaceBySlug, workspaceById, publicWorkspace, deleteWorkspace } from './workspaces.js';
import { isPlatformAdmin, PLATFORM_WORKSPACE_ID, findUsableCompanyCode, consumeCompanyCode, createCompanyCode, listCompanyCodes, revokeCompanyCode, findUsableInvite, consumeInvite } from './codes.js';
import channelsRouter from './routes/channels.js';
import collabsRouter, { collabByInviteToken, addGuestToCollab, collabWithMeta } from './routes/collabs.js';
import adminRouter from './routes/admin.js';
import tasksRouter from './routes/tasks.js';
import workflowsRouter from './routes/workflows.js';
import projectsRouter from './routes/projects.js';
import clientsRouter from './routes/clients.js';
import portalRouter from './routes/portal.js';
import analyticsRouter from './routes/analytics.js';
import hrRouter, { receiveClock } from './routes/hr.js';
import templatesRouter from './routes/templates.js';
import notificationsRouter from './routes/notifications.js';
import uploadsRouter from './routes/uploads.js';
import searchRouter from './routes/search.js';
import filesRouter from './routes/files.js';
import driveRouter from './routes/drive.js';
import dashboardRouter from './routes/dashboard.js';
import timeRouter from './routes/time.js';
import pushRouter from './routes/push.js';
import feeParserRouter from './routes/feeParser.js';
import locationRouter from './routes/location.js';
import leadsRouter from './routes/leads.js';
import whatsappRouter from './routes/whatsapp.js';
import { processInbound, OUTBOX } from './whatsapp.js';
import meetingsRouter from './routes/meetings.js';
import calendarEventsRouter from './routes/calendar.js';
import { intakeLead } from './leads.js';
import setupSocket from './socket.js';
import { startReminderScheduler, startAutoArchiveScheduler, startDeadlineReminderScheduler, startWeeklyDigestScheduler, startDocumentRequestChaseScheduler } from './reminders.js';
import { createNotification } from './notifications.js';
import { startBackupScheduler, runBackup, backupStatus, latestDbPath, verifyBackup } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.set('io', io);

app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })); // keep raw body for webhook signatures
app.use(express.urlencoded({ extended: true })); // accept form-encoded posts (e.g. the website lead form)

// The app's public base URL, for links inside emails. Honours a configured
// APP_URL, otherwise derives it from the incoming request.
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}

// ICE servers for WebRTC calls: always a public STUN server, plus a TURN
// relay if one is configured (TURN_URL[/TURN_USERNAME/TURN_CREDENTIAL]). TURN
// is what lets calls connect across strict NATs / firewalls / mobile networks.
function iceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrl = (process.env.TURN_URL || '').trim();
  if (turnUrl) {
    const turn = { urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean) };
    if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turn.credential = process.env.TURN_CREDENTIAL;
    servers.push(turn);
  }
  return servers;
}

// Public config the auth screens read before anyone is authenticated.
app.get('/api/config', (req, res) => {
  res.json({
    // Registering a new company always needs a code from the platform owner
    // (a DB company-registration code, or the env bootstrap code).
    company_code_required: true,
    email_enabled: emailEnabled(),
    push_enabled: pushEnabled(),
    vapid_public_key: getVapidPublicKey(),
    avatar_colors: AVATAR_COLORS,
    ice_servers: iceServers(),
    android_app_available: androidApkAvailable(),
  });
});

// --- WhatsApp Business Cloud API webhook (public, no login) ---
// Meta's verification handshake: echo the challenge when the verify token matches.
app.get('/api/whatsapp/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  if (req.query['hub.mode'] === 'subscribe' && token &&
      db.prepare('SELECT 1 FROM workspaces WHERE wa_verify_token = ?').get(String(token))) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});
// Inbound messages. Ack immediately (Meta retries on non-200), then process.
app.post('/api/whatsapp/webhook', (req, res) => {
  res.sendStatus(200);
  Promise.resolve(processInbound(app.get('io'), req.body)).catch(() => {});
});
// Test-only: read what the bot would have sent (WA_DRY_RUN).
if (process.env.WA_DRY_RUN) {
  app.get('/api/whatsapp/_outbox', (req, res) => res.json({ outbox: OUTBOX }));
}

// --- Tawk payload extraction (tolerant of Tawk's varying webhook shapes) ---
// Walk every string in a nested object, calling cb(key, value).
function walkStrings(obj, cb, depth = 0) {
  if (!obj || depth > 6) return;
  if (Array.isArray(obj)) { for (const x of obj) walkStrings(x, cb, depth + 1); return; }
  if (typeof obj === 'object') for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (typeof val === 'string') cb(k, val);
    else if (val && typeof val === 'object') walkStrings(val, cb, depth + 1);
  }
}
// First string whose KEY matches keyRe (e.g. an email/name field anywhere).
function walkFind(obj, keyRe) {
  let out = '';
  walkStrings(obj, (k, val) => { if (!out && keyRe.test(k) && val.trim()) out = val.trim(); });
  return out;
}
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;
// Best phone: prefer a field whose key mentions phone; else a phone-shaped run of digits.
function extractPhone(payload, email) {
  let best = ''; let bestScore = -1;
  walkStrings(payload, (k, val) => {
    if (val === email) return;
    const keyHit = /phone|mobile|contact|whats?app|tel|number|cell/i.test(k);
    const cands = [];
    if (keyHit) { const d = (val.match(/\d/g) || []).length; if (d >= 7 && d <= 15) cands.push(val.trim()); }
    for (const m of val.match(PHONE_RE) || []) { const d = (m.match(/\d/g) || []).length; if (d >= 7 && d <= 15) cands.push(m.trim()); }
    for (const c of cands) { const d = (c.match(/\d/g) || []).length; const score = (keyHit ? 100 : 0) + d; if (score > bestScore) { bestScore = score; best = c; } }
  });
  return best;
}
// Human-readable enquiry text, never "[object Object]".
function extractMessage(payload) {
  const msgs = payload.messages || payload.transcript?.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const lines = msgs.map((m) => {
      if (typeof m === 'string') return m;
      const who = (m.sender && (m.sender.t || m.sender.n || m.sender.name)) || m.name || m.from || '';
      const txt = m.msg || m.message || m.text || (typeof m.body === 'string' ? m.body : '');
      return txt ? `${who ? who + ': ' : ''}${txt}` : '';
    }).filter(Boolean);
    if (lines.length) return lines.join('\n');
  }
  const pick = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.text || v.msg || v.message || v.value || '') : ''));
  for (const src of [payload, payload.ticket, payload.visitor, payload.requester]) {
    if (!src) continue;
    for (const k of ['message', 'question', 'enquiry', 'subject', 'body', 'comment', 'note', 'text']) {
      const t = pick(src[k]); if (typeof t === 'string' && t.trim()) return t.trim();
    }
  }
  // Pre-chat "questions" arrays: [{ question, answer }] or { label, value }.
  let out = '';
  walkStrings(payload, (k, val) => { if (!out && /answer|value|response/i.test(k) && val.trim() && !/^https?:/i.test(val)) out = val.trim(); });
  return out;
}

// Tawk.to live-chat webhook — chat:end / ticket:create events drop the visitor's
// name/phone onto the Leads board. Mapped to a workspace by the intake key, and
// (if a secret is set) verified against the X-Tawk-Signature HMAC-SHA1.
app.post('/api/leads/tawk', (req, res) => {
  const key = String(req.query.key || req.get('x-lead-key') || '').trim();
  const ws = key && db.prepare('SELECT * FROM workspaces WHERE leads_intake_key = ?').get(key);
  if (!ws) return res.status(403).json({ error: 'Invalid key' });
  if (ws.tawk_secret) {
    const expected = crypto.createHmac('sha1', ws.tawk_secret).update(req.rawBody || Buffer.from('')).digest('hex');
    const got = String(req.get('x-tawk-signature') || '');
    if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Bad signature' });
    }
  }
  const b = req.body || {};
  // Keep the raw body so an admin can inspect the exact shape Tawk sends.
  try { db.prepare('UPDATE workspaces SET tawk_last_payload = ? WHERE id = ?').run(JSON.stringify(b).slice(0, 20000), ws.id); } catch { /* ignore */ }

  const v = b.visitor || b.requester || {};
  const email = String(v.email || walkFind(b, /^e-?mail$/i) || '').slice(0, 200);
  // Name: the visitor object, or any "name" field; ignore Tawk's generated V… handle.
  let name = String(v.name || walkFind(b, /^(name|full[_ ]?name|visitor[_ ]?name)$/i) || '').slice(0, 200);
  if (/^v\d{6,}$/i.test(name.replace(/\s/g, ''))) name = '';
  const phone = String(extractPhone(b, email) || '').slice(0, 60);
  const message = extractMessage(b).slice(0, 4000);
  if (!name && !email && !phone) return res.json({ ok: true, skipped: 'no contact info' });

  const ref = String(b.chatId || b.ticketId || b.chat?.id || b.time || '').slice(0, 120);
  if (ref) {
    const existing = db.prepare('SELECT * FROM leads WHERE workspace_id = ? AND source_ref = ?').get(ws.id, ref);
    if (existing) {
      // A later event for the same chat (Tawk fires chat:start first, then chat:end)
      // may finally carry the phone/email/real name — enrich rather than drop it.
      const anon = (s) => /^v\d{6,}$/i.test(String(s || '').replace(/\s/g, ''));
      const sets = []; const vals = [];
      if (phone && !existing.phone) { sets.push('phone = ?'); vals.push(phone); }
      if (email && !existing.email) { sets.push('email = ?'); vals.push(email); }
      if (name && (!existing.name || anon(existing.name))) { sets.push('name = ?'); vals.push(name); }
      if (message && message.length > String(existing.message || '').length) { sets.push('message = ?'); vals.push(message); }
      if (sets.length) {
        db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, existing.id);
        return res.json({ ok: true, enriched: existing.id });
      }
      return res.json({ ok: true, duplicate: true });
    }
  }
  const { lead } = intakeLead(app.get('io'), ws, {
    name, email, phone, message, source: 'tawk',
    page_url: b.property?.url || b.pageUrl || v.url || '',
    ip: String(v.ip || '').slice(0, 60),
  });
  if (ref) db.prepare('UPDATE leads SET source_ref = ? WHERE id = ?').run(ref, lead.id);
  res.json({ ok: true, lead_id: lead.id });
});

// Public lead intake — the website enquiry form POSTs here with the workspace's
// secret key (query ?key=, x-lead-key header, or a `key` field). No login.
app.post('/api/leads/intake', (req, res) => {
  const key = String(req.query.key || req.get('x-lead-key') || req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing key' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE leads_intake_key = ?').get(key);
  if (!ws) return res.status(403).json({ error: 'Invalid key' });

  const name = String(req.body?.name || '').slice(0, 200);
  const email = String(req.body?.email || '').slice(0, 200);
  const phone = String(req.body?.phone || '').slice(0, 60);
  const message = String(req.body?.message || '').slice(0, 4000);
  if (!name.trim() && !email.trim() && !phone.trim()) return res.status(400).json({ error: 'Empty enquiry' });

  // Optional source lets several sites share one key yet stay distinguishable
  // in the board and insights (e.g. source=knapadvisory.com). Defaults to website.
  const source = String(req.query.source || req.body?.source || 'website').trim().toLowerCase().slice(0, 40) || 'website';

  // Visitor IP: prefer the one the site forwards (its PHP sees the real visitor);
  // otherwise fall back to the request's IP (first X-Forwarded-For hop, or socket).
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = String(req.body?.ip || fwd || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 60);

  // Where the enquiry came from (forwarded by the site; page_url falls back to the referer header).
  const b = req.body || {};
  const page_url = String(b.page_url || req.get('referer') || '');
  intakeLead(app.get('io'), ws, {
    name, email, phone, message, source, ip, page_url,
    referrer: String(b.referrer || ''),
    utm_source: String(b.utm_source || ''), utm_medium: String(b.utm_medium || ''), utm_campaign: String(b.utm_campaign || ''),
  });
  res.json({ ok: true });
});

// Public account/data-deletion request (Google Play data-deletion requirement).
// No auth — a person requesting deletion may not be able to sign in. Lightly
// validated and stored; workspace admins see and action it in Team admin.
app.post('/api/account-deletion-request', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const name = String(req.body?.name || '').trim().slice(0, 200) || null;
  const message = String(req.body?.message || '').trim().slice(0, 2000) || null;
  db.prepare('INSERT INTO account_deletion_requests (email, name, message) VALUES (?, ?, ?)').run(email, name, message);
  res.json({ ok: true });
});

// --- Self-service password reset (email) ---
// Request a reset link. Always responds 200 (never reveals whether the email
// exists). Only actually sends when email is configured and the user exists.
app.post('/api/auth/forgot', async (req, res) => {
  const user = userByEmail(req.body?.email);
  if (user && user.active && !user.deleted && emailEnabled()) {
    const token = createPasswordReset(user.id);
    const link = `${baseUrl(req)}/reset/${token}`;
    await sendMail({
      to: user.email,
      subject: 'Reset your TeamHub password',
      html: layout('Reset your password',
        `<p>Hi ${user.name}, we got a request to reset your TeamHub password. This link is valid for 1 hour.</p>${button(link, 'Reset password')}<p style="color:#8a8f98;font-size:12px">If you didn't request this, you can safely ignore this email.</p>`),
    });
  }
  res.json({ ok: true });
});

// Validate a reset token (for the reset page).
app.get('/api/auth/reset/:token', (req, res) => {
  const reset = findPasswordReset(req.params.token);
  if (!reset) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(reset.user_id);
  res.json({ ok: true, email: u?.email || null });
});

// Set a new password using a valid token.
app.post('/api/auth/reset/:token', (req, res) => {
  try {
    const reset = findPasswordReset(req.params.token);
    if (!reset) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    applyPasswordReset(reset, req.body?.password);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// --- Workspace creation & joining ---
// Register a new COMPANY: create its workspace + first admin. Requires a
// single-use company-registration code that only the platform owner hands out
// (or the WORKSPACE_SIGNUP_CODE env bootstrap for initial setup).
app.post('/api/workspaces', (req, res) => {
  try {
    const { workspace_name, name, email, password, code } = req.body || {};
    const companyCode = findUsableCompanyCode(code);
    const envOk = workspaceSignupCodeRequired() && (code || '').trim() === process.env.WORKSPACE_SIGNUP_CODE.trim();
    if (!companyCode && !envOk) {
      throw Object.assign(new Error('A valid company registration code is required. Ask KNAP for one.'), { status: 403 });
    }
    const ws = createWorkspace({ name: workspace_name });
    const user = createWorkspaceAdmin(ws, { name, email, password });
    if (companyCode) consumeCompanyCode(companyCode.id, ws.id);
    res.status(201).json({ token: signToken(user), user: publicUser(user), workspace: publicWorkspace(ws) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Public: look up a workspace by slug (for the join page header + hints).
app.get('/api/workspaces/:slug', (req, res) => {
  const ws = workspaceBySlug(req.params.slug);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.json({ workspace: publicWorkspace(ws), allowed_signup_domains: allowedSignupDomains(ws), require_invite_code: !!ws.require_invite_code });
});

// Join an existing workspace as a member (the "your company invited you" flow).
// The account is created unapproved: an admin must approve it before the
// person can sign in. We tell the workspace's admins there's a request waiting.
app.post('/api/workspaces/:slug/register', (req, res) => {
  try {
    const ws = workspaceBySlug(req.params.slug);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    // If this workspace requires an invite code, it must be valid and unused.
    let invite = null;
    if (ws.require_invite_code) {
      invite = findUsableInvite(ws.id, req.body?.code);
      if (!invite) throw Object.assign(new Error('A valid invite code is required to join. Ask your admin for one.'), { status: 403 });
    }
    const user = register(ws, req.body);
    if (invite) consumeInvite(invite.id, user.id);
    const admins = db.prepare(`SELECT id, name, email FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1`).all(ws.id);
    const adminLink = `${baseUrl(req)}/`;
    for (const a of admins) {
      createNotification(io, { user_id: a.id, type: 'join_request', actor_id: user.id, text: `${user.name} requested to join ${ws.name}` });
      if (emailEnabled()) sendMail({
        to: a.email,
        subject: `${user.name} wants to join ${ws.name}`,
        html: layout('New join request',
          `<p><strong>${user.name}</strong> (${user.email}) requested to join <strong>${ws.name}</strong> on TeamHub.</p><p>Approve or decline them in Admin → Pending approvals.</p>${button(adminLink, 'Open TeamHub')}`),
      });
    }
    io.to(`workspace:${ws.id}`).emit('approvals:changed');
    res.status(201).json({ pending: true, workspace: publicWorkspace(ws) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// --- Platform admin: manage company-registration codes (KNAP only) ---
function requirePlatformAdmin(req, res, next) {
  if (!isPlatformAdmin(req.user)) return res.status(403).json({ error: 'Platform admin access required' });
  next();
}
app.get('/api/platform/company-codes', requireAuth, requirePlatformAdmin, (req, res) => {
  res.json({ codes: listCompanyCodes() });
});
app.post('/api/platform/company-codes', requireAuth, requirePlatformAdmin, (req, res) => {
  res.status(201).json(createCompanyCode(req.user.id, req.body?.label || ''));
});
app.delete('/api/platform/company-codes/:id', requireAuth, requirePlatformAdmin, (req, res) => {
  if (!revokeCompanyCode(req.params.id)) return res.status(404).json({ error: 'Code not found or already used' });
  res.json({ ok: true });
});
// Tell the client whether the signed-in user is the platform owner.
app.get('/api/platform/me', requireAuth, (req, res) => {
  res.json({ platform_admin: isPlatformAdmin(req.user) });
});

// --- Companies (workspaces) — platform admin only ---
app.get('/api/platform/workspaces', requireAuth, requirePlatformAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, slug, created_at FROM workspaces ORDER BY id').all().map((w) => ({
    ...w,
    is_platform: w.id === PLATFORM_WORKSPACE_ID,
    members: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role != 'guest'`).get(w.id).n,
  }));
  res.json({ workspaces: rows });
});

// Permanently remove a company/workspace. Guarded: not the platform workspace,
// name must be typed to confirm, and a fresh backup is taken first.
app.delete('/api/platform/workspaces/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const ws = workspaceById(id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (id === PLATFORM_WORKSPACE_ID) return res.status(400).json({ error: 'The platform workspace cannot be deleted here.' });
  if ((req.body?.confirm_name || '').trim() !== ws.name) {
    return res.status(400).json({ error: `To confirm, type the company name exactly: ${ws.name}` });
  }
  try {
    await runBackup(); // always leave a recovery point before an irreversible delete
  } catch (e) {
    return res.status(500).json({ error: `Backup before deletion failed — aborted for safety (${e.message}).` });
  }
  io.to(`workspace:${id}`).emit('account:deactivated'); // sign out any live sessions
  const filesRemoved = deleteWorkspace(id);
  res.json({ ok: true, files_removed: filesRemoved });
});

// --- Backups (platform admin only) ---
app.get('/api/platform/backups', requireAuth, requirePlatformAdmin, (req, res) => {
  res.json(backupStatus());
});
app.post('/api/platform/backups', requireAuth, requirePlatformAdmin, async (req, res) => {
  try { res.status(201).json(await runBackup()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Restore drill: confirm a stored backup would actually come back (integrity +
// real row counts), without touching live data. Defaults to the newest.
app.post('/api/platform/backups/verify', requireAuth, requirePlatformAdmin, (req, res) => {
  res.json(verifyBackup(req.body?.name));
});
// Download the latest database snapshot for safe off-site keeping.
app.get('/api/platform/backups/latest.db', requireAuth, requirePlatformAdmin, (req, res) => {
  const p = latestDbPath();
  if (!p) return res.status(404).json({ error: 'No backup available yet' });
  res.download(p, `teamhub-${new Date().toISOString().slice(0, 10)}.db`);
});

// --- Android app (APK) ---
// The web portal offers a "Download the Android app" button that points here.
// The current APK comes from a hosted URL (ANDROID_APK_URL) if set, otherwise
// the file a platform admin uploaded through the portal.
const ANDROID_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ANDROID_APK_PATH = process.env.ANDROID_APK_PATH || path.join(ANDROID_DATA_DIR, 'teamhub.apk');
const ANDROID_APK_URL = (process.env.ANDROID_APK_URL || '').trim();
const androidApkAvailable = () => !!ANDROID_APK_URL || fs.existsSync(ANDROID_APK_PATH);
const apkTmpDir = path.join(ANDROID_DATA_DIR, 'tmp');
fs.mkdirSync(apkTmpDir, { recursive: true });
const apkUpload = multer({ dest: apkTmpDir, limits: { fileSize: 250 * 1024 * 1024 } });

// Public: always resolves to the latest APK (redirect to the host, or stream it).
app.get('/download/android', (req, res) => {
  if (ANDROID_APK_URL) return res.redirect(302, ANDROID_APK_URL);
  if (fs.existsSync(ANDROID_APK_PATH)) {
    res.type('application/vnd.android.package-archive');
    return res.download(ANDROID_APK_PATH, 'TeamHub.apk');
  }
  res.status(404).send('The TeamHub Android app is not available yet.');
});

// Platform admin publishes the latest APK from the portal.
app.get('/api/platform/android-apk', requireAuth, requirePlatformAdmin, (req, res) => {
  res.json({ available: androidApkAvailable(), hosted: !!ANDROID_APK_URL });
});
app.post('/api/platform/android-apk', requireAuth, requirePlatformAdmin, apkUpload.single('apk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No APK uploaded' });
  if (!(req.file.originalname || '').toLowerCase().endsWith('.apk')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'The file must be an .apk' });
  }
  fs.mkdirSync(path.dirname(ANDROID_APK_PATH), { recursive: true });
  fs.renameSync(req.file.path, ANDROID_APK_PATH);
  res.json({ ok: true, available: true });
});

// --- Auth ---
app.post('/api/auth/login', (req, res) => {
  try {
    const user = login(req.body);
    res.json({ token: signToken(user), user: publicUser(user), workspace: publicWorkspace(workspaceById(user.workspace_id)) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), workspace: publicWorkspace(workspaceById(req.user.workspace_id)) });
});

// --- Google / Microsoft single sign-on (OpenID Connect) ---
// Which SSO buttons the login page should show (only configured providers).
app.get('/api/auth/oauth/providers', (req, res) => res.json(enabledProviders()));

// Kick off sign-in: redirect the browser to the provider's consent screen.
app.get('/api/auth/oauth/:provider/start', (req, res) => {
  const { provider } = req.params;
  if (!providerConfigured(provider)) return res.status(404).json({ error: 'That sign-in method is not configured.' });
  const redirectUri = `${baseUrl(req)}/api/auth/oauth/${provider}/callback`;
  res.redirect(oauthAuthUrl(provider, redirectUri, signState(provider)));
});

// Provider redirects back here with a code; we verify it, match the email to an
// existing user, and bounce back to the app with a one-time token in the URL.
app.get('/api/auth/oauth/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  const returnTo = (params) => res.redirect(`${baseUrl(req)}/?${new URLSearchParams(params).toString()}`);
  try {
    if (!providerConfigured(provider)) throw new Error('That sign-in method is not configured.');
    if (!req.query.code || !verifyState(req.query.state, provider)) {
      throw new Error('Sign-in was cancelled or the link expired. Please try again.');
    }
    const redirectUri = `${baseUrl(req)}/api/auth/oauth/${provider}/callback`;
    const identity = await exchangeCodeForIdentity(provider, String(req.query.code), redirectUri);
    if (!identity.email || !identity.emailVerified) {
      throw new Error('Your email address could not be verified with the provider.');
    }
    const user = ssoLogin(identity.email);
    return returnTo({ oauth_token: signToken(user) });
  } catch (e) {
    return returnTo({ oauth_error: e.message || 'Single sign-on failed. Please try again.' });
  }
});

// --- Subscribable calendar feed (iCal) ---
// Public feed: anyone with the unguessable token URL gets the user's dated work
// as a calendar their app can subscribe to. No auth header (calendar apps can't
// send one) — the token IS the credential, and it can be rotated to revoke it.
app.get('/api/calendar/:token/feed.ics', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE calendar_token = ?').get(req.params.token);
  if (!user || user.deleted || !user.active) return res.status(404).send('Calendar not found');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="teamhub.ics"');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buildUserCalendar(user));
});

const calendarFeedUrl = (req, token) => `${baseUrl(req)}/api/calendar/${token}/feed.ics`;

// The signed-in user's own feed URL (minted on first request).
app.get('/api/calendar/url', requireAuth, blockGuests, (req, res) => {
  let token = req.user.calendar_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, req.user.id);
  }
  res.json({ url: calendarFeedUrl(req, token) });
});

// Rotate the token — the old feed URL stops working immediately.
app.post('/api/calendar/rotate', requireAuth, blockGuests, (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, req.user.id);
  res.json({ url: calendarFeedUrl(req, token) });
});

// --- Public guest invites (no auth: anyone with the link) ---
// Preview: does this invite link point at a real collab?
app.get('/api/invite/:token', (req, res) => {
  const collab = collabByInviteToken(req.params.token);
  if (!collab) return res.status(404).json({ error: 'This invite link is invalid or has been revoked.' });
  res.json({ collab_name: collab.name, description: collab.description || '' });
});

// Join: create a guest account and add it to the invited collab.
app.post('/api/invite/:token/join', (req, res) => {
  try {
    const collab = collabByInviteToken(req.params.token);
    if (!collab) return res.status(404).json({ error: 'This invite link is invalid or has been revoked.' });
    // A returning guest (same name + password) signs back into the same account.
    const returning = findReturningGuest({ channelId: collab.id, name: req.body?.name, password: req.body?.password });
    const guest = returning || createGuest({ name: req.body?.name, password: req.body?.password, workspaceId: collab.workspace_id });
    addGuestToCollab(io, collab, guest.id);
    res.status(201).json({ token: signToken(guest), user: publicUser(guest) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Self-service profile: update your own name / title / avatar colour.
app.patch('/api/auth/me', requireAuth, (req, res) => {
  try {
    const updated = updateOwnProfile(req.user.id, req.body || {});
    io.to(`workspace:${req.workspaceId}`).emit('directory:changed'); // teammates see the new name/colour
    res.json({ user: publicUser(updated) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Self-service password change (verifies the current password).
app.post('/api/auth/password', requireAuth, (req, res) => {
  try {
    changeOwnPassword(req.user.id, req.body?.current_password, req.body?.new_password);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// --- Directory (active, non-guest teammates in this workspace only) ---
app.get('/api/users', requireAuth, blockGuests, (req, res) => {
  res.json({ users: db.prepare(`SELECT * FROM users WHERE active = 1 AND role != 'guest' AND workspace_id = ? ORDER BY name`).all(req.workspaceId).map(publicUser) });
});

app.use('/api/admin', requireAuth, requireAdmin, adminRouter);
app.use('/api/collabs', requireAuth, collabsRouter);
app.use('/api/channels', requireAuth, channelsRouter);
app.use('/api/tasks', requireAuth, blockGuests, tasksRouter);
app.use('/api/workflows', requireAuth, blockGuests, workflowsRouter);
app.use('/api/projects', requireAuth, blockGuests, projectsRouter);
app.use('/api/templates', requireAuth, blockGuests, templatesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/uploads', uploadsRouter); // POST is guarded inside; GET uses a query-param token
app.use('/api/search', requireAuth, blockGuests, searchRouter);
app.use('/api/location', requireAuth, blockGuests, locationRouter);
app.use('/api/leads', requireAuth, blockGuests, leadsRouter);
app.use('/api/whatsapp', requireAuth, blockGuests, whatsappRouter);
app.use('/api/meetings', requireAuth, blockGuests, meetingsRouter);
app.use('/api/calendar-events', requireAuth, blockGuests, calendarEventsRouter);
app.use('/api/files', requireAuth, blockGuests, filesRouter);
app.use('/api/drive', requireAuth, blockGuests, driveRouter);
app.use('/api/dashboard', requireAuth, blockGuests, dashboardRouter);
app.use('/api/time', requireAuth, blockGuests, timeRouter);
app.use('/api/tools/fee-parser', requireAuth, blockGuests, feeParserRouter); // staff-only marketplace fee parser
app.use('/api/push', requireAuth, pushRouter);
app.use('/api/clients', requireAuth, blockGuests, clientsRouter);
app.use('/api/portal', portalRouter); // client portal — its own auth inside
app.use('/api/analytics', requireAuth, blockGuests, analyticsRouter); // staff-only practice analytics
// Bridge to KNAP-HRMS. Any member can open HR (they land in their own
// self-service portal); /summary is gated to admins inside the router.
// Server-to-server clock mirror from HRMS (shared-token auth inside the handler;
// no user session). Registered BEFORE the user-facing HR router so its requireAuth
// prefix match doesn't intercept this token-guarded webhook.
app.post('/api/hr/clock', receiveClock);
app.use('/api/hr', requireAuth, blockGuests, hrRouter);

// Serve the built client in production.
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Clean public URL for the privacy policy (also served at /privacy.html).
  app.get('/privacy', (req, res) => res.sendFile(path.join(clientDist, 'privacy.html')));
  app.get('/delete-account', (req, res) => res.sendFile(path.join(clientDist, 'delete-account.html')));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

setupSocket(io);
startReminderScheduler(io);
startDeadlineReminderScheduler(io);
startWeeklyDigestScheduler(io);
startDocumentRequestChaseScheduler(io);
startAutoArchiveScheduler();
startBackupScheduler();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
