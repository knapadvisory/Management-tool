import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import db from './db.js';
import { register, login, signToken, requireAuth, publicUser } from './auth.js';
import channelsRouter from './routes/channels.js';
import tasksRouter from './routes/tasks.js';
import workflowsRouter from './routes/workflows.js';
import projectsRouter from './routes/projects.js';
import templatesRouter from './routes/templates.js';
import uploadsRouter from './routes/uploads.js';
import searchRouter from './routes/search.js';
import setupSocket from './socket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.set('io', io);

app.use(cors());
app.use(express.json());

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

// --- Directory ---
app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser) });
});

app.use('/api/channels', requireAuth, channelsRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/workflows', requireAuth, workflowsRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/templates', requireAuth, templatesRouter);
app.use('/api/uploads', uploadsRouter); // POST is guarded inside; GET uses a query-param token
app.use('/api/search', requireAuth, searchRouter);

// Serve the built client in production.
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

setupSocket(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
