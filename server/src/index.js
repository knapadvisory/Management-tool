import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import db from './db.js';
import { register, login, signToken, requireAuth, requireAdmin, blockGuests, publicUser, workspaceSignupCodeRequired, allowedSignupDomains, createWorkspaceAdmin, updateOwnProfile, changeOwnPassword, createGuest, findReturningGuest, createPasswordReset, findPasswordReset, applyPasswordReset, userByEmail, AVATAR_COLORS } from './auth.js';
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
import setupSocket from './socket.js';
import { startReminderScheduler, startAutoArchiveScheduler } from './reminders.js';
import { createNotification } from './notifications.js';
import { startBackupScheduler, runBackup, backupStatus, latestDbPath } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.set('io', io);

app.use(cors());
app.use(express.json());

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
  });
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
// Download the latest database snapshot for safe off-site keeping.
app.get('/api/platform/backups/latest.db', requireAuth, requirePlatformAdmin, (req, res) => {
  const p = latestDbPath();
  if (!p) return res.status(404).json({ error: 'No backup available yet' });
  res.download(p, `teamhub-${new Date().toISOString().slice(0, 10)}.db`);
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
app.use('/api/files', requireAuth, blockGuests, filesRouter);
app.use('/api/drive', requireAuth, blockGuests, driveRouter);
app.use('/api/dashboard', requireAuth, blockGuests, dashboardRouter);
app.use('/api/time', requireAuth, blockGuests, timeRouter);
app.use('/api/tools/fee-parser', requireAuth, blockGuests, feeParserRouter); // staff-only marketplace fee parser
app.use('/api/push', requireAuth, pushRouter);
app.use('/api/clients', requireAuth, blockGuests, clientsRouter);

// Serve the built client in production.
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

setupSocket(io);
startReminderScheduler(io);
startAutoArchiveScheduler();
startBackupScheduler();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
