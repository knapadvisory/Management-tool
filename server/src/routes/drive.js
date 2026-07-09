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
    drive_folder_id: f.drive_folder_id,
    context: 'Drive',
  };
}

// Parse a ?folder= param into a folder id (or null for the Drive root).
// Returns { id } on success or { error } if it points nowhere.
function resolveFolder(raw) {
  if (raw == null || raw === '' || raw === 'root') return { id: null };
  const id = Number(raw);
  if (!Number.isInteger(id)) return { error: 'Invalid folder' };
  const folder = db.prepare('SELECT * FROM drive_folders WHERE id = ?').get(id);
  if (!folder) return { error: 'Folder not found' };
  return { id, folder };
}

// Build the ancestor trail (root → … → folder) for breadcrumbs.
function folderPath(id) {
  const trail = [];
  let cur = id;
  const get = db.prepare('SELECT id, name, parent_id FROM drive_folders WHERE id = ?');
  while (cur != null) {
    const f = get.get(cur);
    if (!f) break;
    trail.unshift({ id: f.id, name: f.name });
    cur = f.parent_id;
  }
  return trail;
}

function folderFileCount(id) {
  const files = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE is_drive = 1 AND archived_at IS NULL AND drive_folder_id IS ?').get(id).n;
  const subs = db.prepare('SELECT COUNT(*) AS n FROM drive_folders WHERE parent_id IS ?').get(id).n;
  return { files, subs };
}

// List a folder's contents (subfolders + files). With ?q= set, search files
// across the whole Drive instead (folders are omitted from a search result).
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();

  if (q) {
    let files = db.prepare(`
      SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id, a.drive_folder_id,
             u.name AS uploader_name, u.avatar_color AS uploader_color
      FROM attachments a JOIN users u ON u.id = a.uploader_id
      WHERE a.is_drive = 1 AND a.archived_at IS NULL
      ORDER BY a.created_at DESC
    `).all().map(serializeDriveFile)
      .filter((f) => f.original_name.toLowerCase().includes(q) || f.uploader_name.toLowerCase().includes(q));
    return res.json({ folder: null, path: [], folders: [], files, searching: true });
  }

  const r = resolveFolder(req.query.folder);
  if (r.error) return res.status(404).json({ error: r.error });

  const folders = db.prepare(`
    SELECT df.id, df.name, df.parent_id, df.created_by, df.created_at, u.name AS created_by_name
    FROM drive_folders df JOIN users u ON u.id = df.created_by
    WHERE df.parent_id IS ?
    ORDER BY df.name COLLATE NOCASE
  `).all(r.id).map((f) => ({ ...f, ...folderFileCount(f.id) }));

  const files = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id, a.drive_folder_id,
           u.name AS uploader_name, u.avatar_color AS uploader_color
    FROM attachments a JOIN users u ON u.id = a.uploader_id
    WHERE a.is_drive = 1 AND a.archived_at IS NULL AND a.drive_folder_id IS ?
    ORDER BY a.created_at DESC
  `).all(r.id).map(serializeDriveFile);

  res.json({ folder: r.folder || null, path: folderPath(r.id), folders, files, searching: false });
});

// Flat list of every folder (for the "move to folder" picker).
router.get('/folders', (req, res) => {
  const folders = db.prepare('SELECT id, name, parent_id FROM drive_folders ORDER BY name COLLATE NOCASE').all();
  res.json({ folders });
});

// Create a folder inside `parent_id` (null = root).
router.post('/folders', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const parentId = req.body?.parent_id != null ? Number(req.body.parent_id) : null;
  if (parentId != null) {
    if (!Number.isInteger(parentId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ?').get(parentId)) {
      return res.status(404).json({ error: 'Parent folder not found' });
    }
  }
  const info = db.prepare('INSERT INTO drive_folders (name, parent_id, created_by) VALUES (?, ?, ?)').run(name, parentId, req.user.id);
  const folder = db.prepare('SELECT id, name, parent_id, created_by, created_at FROM drive_folders WHERE id = ?').get(info.lastInsertRowid);
  req.app.get('io')?.emit('drive:changed');
  res.status(201).json({ folder: { ...folder, files: 0, subs: 0 } });
});

// Rename a folder (creator or admin).
router.patch('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM drive_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the folder’s creator or an admin can rename it' });
  }
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  db.prepare('UPDATE drive_folders SET name = ? WHERE id = ?').run(name, folder.id);
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
});

// Delete a folder — only when it is empty, and only its creator or an admin.
router.delete('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM drive_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the folder’s creator or an admin can delete it' });
  }
  const { files, subs } = folderFileCount(folder.id);
  if (files > 0 || subs > 0) return res.status(409).json({ error: 'Folder isn’t empty — remove its contents first' });
  db.prepare('DELETE FROM drive_folders WHERE id = ?').run(folder.id);
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
});

// Upload one or more files into the shared Drive (into `folder_id`, or root).
router.post('/', upload.array('files', 10), (req, res) => {
  let folderId = req.body?.folder_id != null && req.body.folder_id !== '' ? Number(req.body.folder_id) : null;
  if (folderId != null) {
    if (!Number.isInteger(folderId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ?').get(folderId)) folderId = null;
  }
  const insert = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size, is_drive, drive_folder_id)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  const created = (req.files || []).map((f) => {
    const info = insert.run(req.user.id, f.filename, f.originalname, f.mimetype, f.size, folderId);
    return db.prepare(`
      SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id, a.drive_folder_id,
             u.name AS uploader_name, u.avatar_color AS uploader_color
      FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.id = ?
    `).get(info.lastInsertRowid);
  }).map(serializeDriveFile);

  req.app.get('io')?.emit('drive:changed');
  res.status(201).json({ files: created });
});

// Move a Drive file into another folder (uploader or admin).
router.patch('/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND is_drive = 1').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'File not found' });
  if (att.uploader_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only move files you uploaded' });
  }
  let folderId = req.body?.folder_id != null && req.body.folder_id !== '' ? Number(req.body.folder_id) : null;
  if (folderId != null) {
    if (!Number.isInteger(folderId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ?').get(folderId)) {
      return res.status(404).json({ error: 'Target folder not found' });
    }
  }
  db.prepare('UPDATE attachments SET drive_folder_id = ? WHERE id = ?').run(folderId, att.id);
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
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
