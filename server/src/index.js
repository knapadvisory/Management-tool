import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import db from './db.js';
import { register, login, signToken, requireAuth, requireAdmin, publicUser, signupCodeRequired, updateOwnProfile, changeOwnPassword, AVATAR_COLORS } from './auth.js';
import channelsRouter from './routes/channels.js';
import collabsRouter from './routes/collabs.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.set('io', io);

app.use(cors());
app.use(express.json());

// Public config the login screen reads before anyone is authenticated.
app.get('/api/config', (req, res) => {
  res.json({ signup_code_required: signupCodeRequired(), avatar_colors: AVATAR_COLORS });
});

// --- Auth ---
app.post('/api/auth/register', (req, res) => {
  try {
    const user = register(req.body);
    io.emit('directory:changed'); // let connected clients pick up the new teammate
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const user = login(req.body);
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Self-service profile: update your own name / title / avatar colour.
app.patch('/api/auth/me', requireAuth, (req, res) => {
  try {
    const updated = updateOwnProfile(req.user.id, req.body || {});
    io.emit('directory:changed'); // let teammates see the new name/colour
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

// --- Directory (active teammates only) ---
app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name').all().map(publicUser) });
});

app.use('/api/admin', requireAuth, requireAdmin, adminRouter);
app.use('/api/collabs', requireAuth, collabsRouter);
app.use('/api/channels', requireAuth, channelsRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/workflows', requireAuth, workflowsRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/templates', requireAuth, templatesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/uploads', uploadsRouter); // POST is guarded inside; GET uses a query-param token
app.use('/api/search', requireAuth, searchRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api/drive', requireAuth, driveRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);

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
