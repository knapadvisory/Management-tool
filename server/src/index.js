import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import db from './db.js';
import { register, login, signToken, requireAuth, requireAdmin, blockGuests, publicUser, workspaceSignupCodeRequired, allowedSignupDomains, createWorkspaceAdmin, updateOwnProfile, changeOwnPassword, createGuest, findReturningGuest, AVATAR_COLORS } from './auth.js';
import { createWorkspace, workspaceBySlug, workspaceById, publicWorkspace } from './workspaces.js';
import channelsRouter from './routes/channels.js';
import collabsRouter, { collabByInviteToken, addGuestToCollab, collabWithMeta } from './routes/collabs.js';
import adminRouter from './routes/admin.js';
import tasksRouter from './routes/tasks.js';
import workflowsRouter from './routes/workflows.js';
import projectsRouter from './routes/projects.js';
import templatesRouter from './routes/templates.js';
import notificationsRouter from './routes/notifications.js';
import uploadsRouter from './routes/uploads.js';
import searchRouter from './routes/search.js';
import filesRouter from './routes/files.js';
import driveRouter from './routes/drive.js';
import dashboardRouter from './routes/dashboard.js';
import setupSocket from './socket.js';
import { startReminderScheduler } from './reminders.js';
import { createNotification } from './notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.set('io', io);

app.use(cors());
app.use(express.json());

// Public config the auth screens read before anyone is authenticated.
app.get('/api/config', (req, res) => {
  res.json({
    workspace_signup_code_required: workspaceSignupCodeRequired(),
    avatar_colors: AVATAR_COLORS,
  });
});

// --- Workspace creation & joining ---
// Create a brand-new workspace and its first admin (the "start a workspace" flow).
app.post('/api/workspaces', (req, res) => {
  try {
    const { workspace_name, name, email, password, code } = req.body || {};
    if (workspaceSignupCodeRequired() && (code || '').trim() !== process.env.WORKSPACE_SIGNUP_CODE.trim()) {
      throw Object.assign(new Error('A valid workspace creation code is required'), { status: 403 });
    }
    const ws = createWorkspace({ name: workspace_name });
    const user = createWorkspaceAdmin(ws, { name, email, password });
    res.status(201).json({ token: signToken(user), user: publicUser(user), workspace: publicWorkspace(ws) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Public: look up a workspace by slug (for the join page header + domain hint).
app.get('/api/workspaces/:slug', (req, res) => {
  const ws = workspaceBySlug(req.params.slug);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.json({ workspace: publicWorkspace(ws), allowed_signup_domains: allowedSignupDomains(ws) });
});

// Join an existing workspace as a member (the "your company invited you" flow).
// The account is created unapproved: an admin must approve it before the
// person can sign in. We tell the workspace's admins there's a request waiting.
app.post('/api/workspaces/:slug/register', (req, res) => {
  try {
    const ws = workspaceBySlug(req.params.slug);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const user = register(ws, req.body);
    const admins = db.prepare(`SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1`).all(ws.id);
    for (const { id } of admins) {
      createNotification(io, { user_id: id, type: 'join_request', actor_id: user.id, text: `${user.name} requested to join ${ws.name}` });
    }
    io.to(`workspace:${ws.id}`).emit('approvals:changed');
    res.status(201).json({ pending: true, workspace: publicWorkspace(ws) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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

// Serve the built client in production.
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

setupSocket(io);
startReminderScheduler(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
