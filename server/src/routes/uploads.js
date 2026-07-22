import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import db from '../db.js';
import { verifyToken, requireAuth, publicUser } from '../auth.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver'); // CJS module loaded into this ESM file

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
// Zip-download a selection of Drive files and/or whole folders (with their
// nested structure). Auth via query token so a plain <a download> works in the
// browser and the native WebView. Defined BEFORE /:id so "zip" isn't an id.
router.get('/zip', (req, res) => {
  let userId;
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    userId = verifyToken(token).id;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const me = db.prepare('SELECT workspace_id FROM users WHERE id = ?').get(userId);
  const wsId = me?.workspace_id;
  if (!wsId) return res.status(403).json({ error: 'Not allowed' });

  const parseIds = (s) => String(s || '').split(',').map((n) => parseInt(n, 10)).filter(Boolean);
  const fileIds = parseIds(req.query.files);
  const folderIds = parseIds(req.query.folders);
  if (!fileIds.length && !folderIds.length) return res.status(400).json({ error: 'Nothing selected' });

  // Folder map (workspace-scoped) for building paths + expanding descendants.
  const allFolders = db.prepare('SELECT id, name, parent_id FROM drive_folders WHERE workspace_id = ?').all(wsId);
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  const relPath = (fid) => {
    const parts = []; let cur = byId.get(fid); let guard = 0;
    while (cur && guard++ < 50) { parts.unshift(cur.name); cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
    return parts.join('/');
  };
  const wantFolders = new Set();
  const queue = [...folderIds];
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const id = queue[i];
    if (wantFolders.has(id)) continue;
    wantFolders.add(id);
    for (const f of allFolders) if (f.parent_id === id) queue.push(f.id);
  }

  const entries = []; const seen = new Set();
  const addFile = (a, zipName) => {
    if (!a || seen.has(a.id)) return;
    seen.add(a.id);
    const disk = path.join(uploadDir, a.stored_name);
    if (fs.existsSync(disk)) entries.push({ disk, zipName });
  };
  if (fileIds.length) {
    const ph = fileIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, stored_name, original_name FROM attachments WHERE is_drive = 1 AND archived_at IS NULL AND workspace_id = ? AND id IN (${ph})`).all(wsId, ...fileIds);
    for (const a of rows) addFile(a, a.original_name);
  }
  for (const fid of wantFolders) {
    const base = relPath(fid);
    const rows = db.prepare('SELECT id, stored_name, original_name FROM attachments WHERE is_drive = 1 AND archived_at IS NULL AND workspace_id = ? AND drive_folder_id = ?').all(wsId, fid);
    for (const a of rows) addFile(a, base ? `${base}/${a.original_name}` : a.original_name);
  }
  if (!entries.length) return res.status(404).json({ error: 'No files to download' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="TeamHub_files.zip"');
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => { try { res.status(500).end(); } catch { /* already streaming */ } });
  archive.pipe(res);
  const used = new Set();
  for (const e of entries) {
    let name = e.zipName;
    if (used.has(name)) { // avoid overwriting same-named files in the zip
      const ext = path.extname(name); const stem = name.slice(0, name.length - ext.length);
      let i = 2; while (used.has(`${stem} (${i})${ext}`)) i++;
      name = `${stem} (${i})${ext}`;
    }
    used.add(name);
    archive.file(e.disk, { name });
  }
  archive.finalize();
});

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
  // ?download=1 forces a download (Content-Disposition: attachment). The native
  // Android WebView needs this to hand the file to the system DownloadManager;
  // browsers respect it too. Without it we serve inline so previews render.
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(att.original_name)}"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
