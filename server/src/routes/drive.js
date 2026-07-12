import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { createNotification } from '../notifications.js';

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
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 50 } });

const router = Router();

// People a Drive file is tagged with.
function sharedWith(attId) {
  return db.prepare(`
    SELECT u.id, u.name, u.avatar_color
    FROM drive_file_shares s JOIN users u ON u.id = s.user_id
    WHERE s.attachment_id = ? ORDER BY u.name COLLATE NOCASE
  `).all(attId);
}

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
    shared_with: sharedWith(f.id),
    context: 'Drive',
  };
}

// Parse a "shared_with" input (form field or JSON) into a list of valid,
// distinct user ids.
function parseUserIds(raw, workspaceId) {
  let ids = [];
  if (Array.isArray(raw)) ids = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) ids = j; else ids = raw.split(','); }
    catch { ids = raw.split(','); }
  }
  const seen = new Set();
  const out = [];
  for (const v of ids) {
    const n = Number(v);
    if (Number.isInteger(n) && !seen.has(n) && db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1 AND workspace_id = ?').get(n, workspaceId)) {
      seen.add(n); out.push(n);
    }
  }
  return out;
}

// Tag a set of users on a file and notify the newly-added ones.
function applyShares(io, att, userIds, actor) {
  const existing = new Set(db.prepare('SELECT user_id FROM drive_file_shares WHERE attachment_id = ?').all(att.id).map((r) => r.user_id));
  db.prepare('DELETE FROM drive_file_shares WHERE attachment_id = ?').run(att.id);
  const ins = db.prepare('INSERT OR IGNORE INTO drive_file_shares (attachment_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) {
    ins.run(att.id, uid);
    if (!existing.has(uid)) {
      createNotification(io, {
        user_id: uid, type: 'drive_share', actor_id: actor.id,
        text: `${actor.name} shared a file with you in the Drive: ${att.original_name}`,
      });
    }
  }
}

// Parse a ?folder= param into a folder id (or null for the Drive root).
// Returns { id } on success or { error } if it points nowhere.
function resolveFolder(raw, workspaceId) {
  if (raw == null || raw === '' || raw === 'root') return { id: null };
  const id = Number(raw);
  if (!Number.isInteger(id)) return { error: 'Invalid folder' };
  const folder = db.prepare('SELECT * FROM drive_folders WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
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

// A folder and all of its nested subfolders (ids), so it can be deleted whole.
function folderAndDescendants(id) {
  const ids = [id];
  const childrenOf = db.prepare('SELECT id FROM drive_folders WHERE parent_id = ?');
  for (let i = 0; i < ids.length; i++) {
    for (const c of childrenOf.all(ids[i])) ids.push(c.id);
  }
  return ids;
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
      WHERE a.is_drive = 1 AND a.archived_at IS NULL AND a.workspace_id = ?
      ORDER BY a.created_at DESC
    `).all(req.workspaceId).map(serializeDriveFile)
      .filter((f) => f.original_name.toLowerCase().includes(q) || f.uploader_name.toLowerCase().includes(q));
    return res.json({ folder: null, path: [], folders: [], files, searching: true });
  }

  const r = resolveFolder(req.query.folder, req.workspaceId);
  if (r.error) return res.status(404).json({ error: r.error });

  const folders = db.prepare(`
    SELECT df.id, df.name, df.parent_id, df.created_by, df.created_at, u.name AS created_by_name
    FROM drive_folders df JOIN users u ON u.id = df.created_by
    WHERE df.parent_id IS ? AND df.workspace_id = ?
    ORDER BY df.name COLLATE NOCASE
  `).all(r.id, req.workspaceId).map((f) => ({ ...f, ...folderFileCount(f.id) }));

  const files = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id, a.drive_folder_id,
           u.name AS uploader_name, u.avatar_color AS uploader_color
    FROM attachments a JOIN users u ON u.id = a.uploader_id
    WHERE a.is_drive = 1 AND a.archived_at IS NULL AND a.drive_folder_id IS ? AND a.workspace_id = ?
    ORDER BY a.created_at DESC
  `).all(r.id, req.workspaceId).map(serializeDriveFile);

  res.json({ folder: r.folder || null, path: folderPath(r.id), folders, files, searching: false });
});

// Flat list of every folder (for the "move to folder" picker).
router.get('/folders', (req, res) => {
  const folders = db.prepare('SELECT id, name, parent_id FROM drive_folders WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  res.json({ folders });
});

// Create a folder inside `parent_id` (null = root).
router.post('/folders', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const parentId = req.body?.parent_id != null ? Number(req.body.parent_id) : null;
  if (parentId != null) {
    if (!Number.isInteger(parentId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ? AND workspace_id = ?').get(parentId, req.workspaceId)) {
      return res.status(404).json({ error: 'Parent folder not found' });
    }
  }
  const info = db.prepare('INSERT INTO drive_folders (name, parent_id, created_by, workspace_id) VALUES (?, ?, ?, ?)').run(name, parentId, req.user.id, req.workspaceId);
  const folder = db.prepare('SELECT id, name, parent_id, created_by, created_at FROM drive_folders WHERE id = ?').get(info.lastInsertRowid);
  req.app.get('io')?.emit('drive:changed');
  res.status(201).json({ folder: { ...folder, files: 0, subs: 0 } });
});

// Rename and/or move a folder (creator or admin). Accepts `name` (rename)
// and/or `parent_id` (move — null moves it to the Drive root).
router.patch('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM drive_folders WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the folder’s creator or an admin can change it' });
  }
  if (req.body?.name != null) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    db.prepare('UPDATE drive_folders SET name = ? WHERE id = ?').run(name, folder.id);
  }
  if ('parent_id' in (req.body || {})) {
    let parentId = req.body.parent_id != null && req.body.parent_id !== '' ? Number(req.body.parent_id) : null;
    if (parentId != null) {
      if (!Number.isInteger(parentId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ? AND workspace_id = ?').get(parentId, req.workspaceId)) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      // Can't move a folder into itself or any of its own descendants.
      if (folderAndDescendants(folder.id).includes(parentId)) {
        return res.status(400).json({ error: 'Can’t move a folder into itself' });
      }
    }
    db.prepare('UPDATE drive_folders SET parent_id = ? WHERE id = ?').run(parentId, folder.id);
  }
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
});

// Delete a folder and everything inside it (subfolders + files). Only the
// folder's creator or an admin may do so. Files are archived (recoverable from
// the admin Archive), not destroyed; folder rows are removed.
router.delete('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM drive_folders WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the folder’s creator or an admin can delete it' });
  }
  const ids = folderAndDescendants(folder.id);
  const placeholders = ids.map(() => '?').join(',');
  const purge = db.transaction(() => {
    // Archive still-live files in these folders (kept for the admin Archive)...
    db.prepare(`UPDATE attachments SET archived_at = datetime('now'), archived_by = ?
                WHERE is_drive = 1 AND archived_at IS NULL AND drive_folder_id IN (${placeholders})`)
      .run(req.user.id, ...ids);
    // ...and detach every file (archived or not) so the folder rows can go.
    db.prepare(`UPDATE attachments SET drive_folder_id = NULL WHERE drive_folder_id IN (${placeholders})`).run(...ids);
    // Remove the folder (parent_id ON DELETE CASCADE clears the subfolders).
    db.prepare('DELETE FROM drive_folders WHERE id = ?').run(folder.id);
  });
  purge();
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
});

// Upload one or more files into the shared Drive (into `folder_id`, or root).
router.post('/', upload.array('files', 50), (req, res) => {
  let folderId = req.body?.folder_id != null && req.body.folder_id !== '' ? Number(req.body.folder_id) : null;
  if (folderId != null) {
    if (!Number.isInteger(folderId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ? AND workspace_id = ?').get(folderId, req.workspaceId)) folderId = null;
  }
  const shareIds = parseUserIds(req.body?.shared_with, req.workspaceId);
  const io = req.app.get('io');
  const insert = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size, is_drive, drive_folder_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const created = (req.files || []).map((f) => {
    const info = insert.run(req.user.id, f.filename, f.originalname, f.mimetype, f.size, folderId, req.workspaceId);
    const row = db.prepare(`
      SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id, a.drive_folder_id,
             u.name AS uploader_name, u.avatar_color AS uploader_color
      FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.id = ?
    `).get(info.lastInsertRowid);
    if (shareIds.length) applyShares(io, row, shareIds, req.user);
    return row;
  }).map(serializeDriveFile);

  io?.emit('drive:changed');
  res.status(201).json({ files: created });
});

// Update who a Drive file is tagged / shared with (uploader or admin).
router.patch('/:id/shares', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND is_drive = 1 AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  if (att.uploader_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only tag files you uploaded' });
  }
  applyShares(req.app.get('io'), att, parseUserIds(req.body?.user_ids, req.workspaceId), req.user);
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true, shared_with: sharedWith(att.id) });
});

// Move and/or rename a Drive file (uploader or admin). Accepts `folder_id`
// (move) and/or `name` (rename).
router.patch('/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND is_drive = 1 AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  if (att.uploader_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only change files you uploaded' });
  }
  if ('folder_id' in (req.body || {})) {
    let folderId = req.body.folder_id != null && req.body.folder_id !== '' ? Number(req.body.folder_id) : null;
    if (folderId != null) {
      if (!Number.isInteger(folderId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ? AND workspace_id = ?').get(folderId, req.workspaceId)) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
    }
    db.prepare('UPDATE attachments SET drive_folder_id = ? WHERE id = ?').run(folderId, att.id);
  }
  if (req.body?.name != null) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'File name is required' });
    db.prepare('UPDATE attachments SET original_name = ? WHERE id = ?').run(name, att.id);
  }
  req.app.get('io')?.emit('drive:changed');
  res.json({ ok: true });
});

// Copy a Drive file into a folder (root by default). Duplicates the stored
// file on disk and creates a fresh attachment owned by the current user.
router.post('/:id/copy', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND is_drive = 1 AND archived_at IS NULL AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  let folderId = req.body?.folder_id != null && req.body.folder_id !== '' ? Number(req.body.folder_id) : null;
  if (folderId != null) {
    if (!Number.isInteger(folderId) || !db.prepare('SELECT 1 FROM drive_folders WHERE id = ? AND workspace_id = ?').get(folderId, req.workspaceId)) folderId = null;
  }
  const ext = path.extname(att.stored_name).slice(0, 10);
  const newStored = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  try {
    fs.copyFileSync(path.join(uploadDir, att.stored_name), path.join(uploadDir, newStored));
  } catch {
    return res.status(500).json({ error: 'Could not copy the file' });
  }
  const info = db.prepare(`
    INSERT INTO attachments (uploader_id, stored_name, original_name, mime_type, size, is_drive, drive_folder_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(req.user.id, newStored, att.original_name, att.mime_type, att.size, folderId, req.workspaceId);
  const row = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id, a.drive_folder_id,
           u.name AS uploader_name, u.avatar_color AS uploader_color
    FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.id = ?
  `).get(info.lastInsertRowid);
  req.app.get('io')?.emit('drive:changed');
  res.status(201).json({ file: serializeDriveFile(row) });
});

// Delete a Drive file — you can only remove your own (like WhatsApp). It is
// archived: hidden for everyone but kept in the admin archive for recovery.
router.delete('/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND is_drive = 1 AND workspace_id = ?').get(req.params.id, req.workspaceId);
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
