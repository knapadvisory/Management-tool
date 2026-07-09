import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { serializeMessage } from '../messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'uploads');

const router = Router();

// Every file the user can see — attachments from channels/DMs/collabs they
// belong to, plus attachments on tasks they're involved in (admins: all
// tasks). Includes who shared it and where. Optional ?q= filters by file
// name, uploader or location.
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();

  const msgFiles = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id,
           u.name AS uploader_name, u.avatar_color AS uploader_color,
           c.name AS channel_name, c.is_dm, c.is_collab
    FROM attachments a
    JOIN users u ON u.id = a.uploader_id
    JOIN messages m ON m.id = a.message_id
    JOIN channels c ON c.id = m.channel_id
    WHERE a.message_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
  `).all(req.user.id).map((f) => ({
    id: f.id, original_name: f.original_name, mime_type: f.mime_type, size: f.size, created_at: f.created_at,
    uploader_id: f.uploader_id, uploader_name: f.uploader_name, uploader_color: f.uploader_color,
    context: f.is_dm ? 'Direct message' : f.is_collab ? `Collab: ${f.channel_name}` : `#${f.channel_name}`,
  }));

  const isAdmin = req.user.role === 'admin';
  const canSeeTask = db.prepare('SELECT 1 FROM task_watchers WHERE task_id = ? AND user_id = ?');
  const taskFiles = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, a.uploader_id,
           u.name AS uploader_name, u.avatar_color AS uploader_color,
           t.id AS task_id, t.title AS task_title, t.creator_id, t.assignee_id
    FROM attachments a
    JOIN users u ON u.id = a.uploader_id
    JOIN tasks t ON t.id = a.task_id
    WHERE a.task_id IS NOT NULL
  `).all()
    .filter((f) => isAdmin || f.creator_id === req.user.id || f.assignee_id === req.user.id || canSeeTask.get(f.task_id, req.user.id))
    .map((f) => ({
      id: f.id, original_name: f.original_name, mime_type: f.mime_type, size: f.size, created_at: f.created_at,
      uploader_id: f.uploader_id, uploader_name: f.uploader_name, uploader_color: f.uploader_color, context: `Task: ${f.task_title}`,
    }));

  let files = [...msgFiles, ...taskFiles].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (q) {
    files = files.filter((f) =>
      f.original_name.toLowerCase().includes(q) ||
      f.uploader_name.toLowerCase().includes(q) ||
      f.context.toLowerCase().includes(q));
  }
  res.json({ files });
});

// Delete a shared file. Only the person who uploaded it, or an admin, may.
router.delete('/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'File not found' });
  if (att.uploader_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the person who shared a file (or an admin) can delete it' });
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  try { fs.unlinkSync(path.join(uploadDir, att.stored_name)); } catch { /* already gone */ }
  // Let chat views drop the attachment if it belonged to a message.
  if (att.message_id) {
    const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(att.message_id);
    if (msg) req.app.get('io')?.to(`channel:${msg.channel_id}`).emit('message:updated', {
      message: serializeMessage(att.message_id, null),
    });
  }
  res.json({ ok: true });
});

export default router;
