import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { verifyToken, requireAuth } from '../auth.js';

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

const router = Router();

// Upload one or more files. They start unattached; a subsequent
// message:send (or task) links them by id.
router.post('/', requireAuth, upload.array('files', 10), (req, res) => {
  const insert = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size)
    VALUES (?, ?, ?, ?, ?)
  `);
  const out = (req.files || []).map((f) => {
    const info = insert.run(req.user.id, f.filename, f.originalname, f.mimetype, f.size);
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

  if (att.message_id) {
    const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(att.message_id);
    const member = msg && db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
      .get(msg.channel_id, userId);
    if (!member) return res.status(403).json({ error: 'Not allowed' });
  } else if (att.task_id) {
    // Tasks are shared across the team, so any authenticated member may view.
  } else if (att.is_drive) {
    // The shared Drive is team-wide; any authenticated member may view.
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
