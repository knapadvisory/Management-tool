import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { verifyToken, requireAuth, publicUser } from '../auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }, // 25 MB per file
});
// Avatars: images only, 5 MB cap.
const avatarUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const router = Router();

// Upload a profile photo and set it as the current user's avatar in one step.
// Marked is_avatar so every workspace member can load it via <img>.
router.post('/avatar', requireAuth, avatarUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image (max 5 MB).' });
  const info = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size, workspace_id, is_avatar)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.workspaceId);
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(String(info.lastInsertRowid), req.user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('directory:changed');
  res.status(201).json({ user: publicUser(updated) });
});

// Upload one or more files. They start unattached; a subsequent
// message:send (or task) links them by id.
router.post('/', requireAuth, upload.array('files', 10), (req, res) => {
  const insert = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const out = (req.files || []).map((f) => {
    const info = insert.run(req.user.id, f.filename, f.originalname, f.mimetype, f.size, req.workspaceId);
    return {
      id: info.lastInsertRowid,
      original_name: f.originalname,
      mime_type: f.mimetype,
      size: f.size,
    };
  });
  res.status(201).json({ attachments: out });
});

// Stream a file. Images are loaded via <img src>, which can't send an
// Authorization header, so accept the JWT as a query param too. Access
// is limited to members of the channel the file was posted in (files
// not yet linked to a message are only visible to their uploader).
router.get('/:id', (req, res) => {
  let userId;
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    userId = verifyToken(token).id;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'File not found' });

  // The requester must belong to the same workspace the file lives in.
  const me = db.prepare('SELECT workspace_id, role FROM users WHERE id = ?').get(userId);
  if (att.workspace_id && att.workspace_id !== me?.workspace_id) return res.status(403).json({ error: 'Not allowed' });

  // A file lives inside a task only if the requester can see that task
  // (creator, assignee, watcher, or admin) — task visibility is NOT workspace-wide.
  const canSeeTask = (task) => {
    if (!task) return false;
    if (me?.role === 'admin') return true;
    if (task.creator_id === userId || task.assignee_id === userId) return true;
    return !!db.prepare('SELECT 1 FROM task_watchers WHERE task_id = ? AND user_id = ?').get(task.id, userId);
  };

  if (att.message_id) {
    const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(att.message_id);
    const member = msg && db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
      .get(msg.channel_id, userId);
    if (!member) return res.status(403).json({ error: 'Not allowed' });
  } else if (att.task_id) {
    if (!canSeeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(att.task_id))) {
      return res.status(403).json({ error: 'Not allowed' });
    }
  } else if (att.task_message_id) {
    const task = db.prepare('SELECT t.* FROM tasks t JOIN task_messages tm ON tm.task_id = t.id WHERE tm.id = ?').get(att.task_message_id);
    if (!canSeeTask(task)) return res.status(403).json({ error: 'Not allowed' });
  } else if (att.is_drive) {
    // The shared Drive is workspace-wide (already scoped above).
  } else if (att.is_avatar) {
    // Profile photos are visible to the whole workspace (already scoped above).
  } else if (att.client_id) {
    // Client documents are visible to the workspace's staff (scoped above).
  } else if (att.uploader_id !== userId) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const filePath = path.join(uploadDir, att.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
