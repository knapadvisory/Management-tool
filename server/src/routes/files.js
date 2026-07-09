import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Every file the user can see — attachments from channels/DMs/collabs they
// belong to, plus attachments on tasks they're involved in (admins: all
// tasks). Includes who shared it and where. Optional ?q= filters by file
// name, uploader or location.
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();

  const msgFiles = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at,
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
    uploader_name: f.uploader_name, uploader_color: f.uploader_color,
    context: f.is_dm ? 'Direct message' : f.is_collab ? `Collab: ${f.channel_name}` : `#${f.channel_name}`,
  }));

  const isAdmin = req.user.role === 'admin';
  const canSeeTask = db.prepare('SELECT 1 FROM task_watchers WHERE task_id = ? AND user_id = ?');
  const taskFiles = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at,
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
      uploader_name: f.uploader_name, uploader_color: f.uploader_color, context: `Task: ${f.task_title}`,
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

export default router;
