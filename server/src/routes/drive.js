import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db.js';

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
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const router = Router();

function serializeDriveFile(f) {
  return {
    id: f.id,
    original_name: f.original_name,
    mime_type: f.mime_type,
    size: f.size,
    created_at: f.created_at,
    uploader_id: f.uploader_id,
    uploader_name: f.uploader_name,
    uploader_color: f.uploader_color,
    context: 'Drive',
  };
}

// Everything in the shared team Drive — visible to every member. Optional ?q=
// filters by file name or who uploaded it.
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let files = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id,
           u.name AS uploader_name, u.avatar_color AS uploader_color
    FROM attachments a
    JOIN users u ON u.id = a.uploader_id
    WHERE a.is_drive = 1 AND a.archived_at IS NULL
    ORDER BY a.created_at DESC
  `).all().map(serializeDriveFile);
  if (q) {
    files = files.filter((f) =>
      f.original_name.toLowerCase().includes(q) ||
      f.uploader_name.toLowerCase().includes(q));
  }
  res.json({ files });
});

// Upload one or more files straight into the shared Drive.
router.post('/', upload.array('files', 10), (req, res) => {
  const insert = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size, is_drive)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const created = (req.files || []).map((f) => {
    const info = insert.run(req.user.id, f.filename, f.originalname, f.mimetype, f.size);
    return db.prepare(`
      SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id,
             u.name AS uploader_name, u.avatar_color AS uploader_color
      FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.id = ?
    `).get(info.lastInsertRowid);
  }).map(serializeDriveFile);

  // Let every connected member refresh their Drive.
  req.app.get('io')?.emit('drive:changed');
  res.status(201).json({ files: created });
});

// Delete a Drive file — you can only remove your own (like WhatsApp). It is
// archived: hidden for everyone but kept in the admin archive for recovery.
router.delete('/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND is_drive = 1').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'File not found' });
  if (att.uploader_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete files you uploaded' });
  }
  if (!att.archived_at) {
    db.prepare(`UPDATE attachments SET archived_at = datetime('now'), archived_by = ? WHERE id = ?`).run(req.user.id, att.id);
    req.app.get('io')?.emit('drive:changed');
  }
  res.json({ ok: true });
});

export default router;
