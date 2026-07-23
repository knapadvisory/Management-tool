import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Full-text-ish search over messages in channels the user belongs to.
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.channel_id,
           u.name AS user_name, u.avatar_color,
           c.name AS channel_name, c.is_dm
    FROM messages m
    JOIN users u ON u.id = m.user_id
    JOIN channels c ON c.id = m.channel_id
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
    WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\' AND c.workspace_id = ?
    ORDER BY m.id DESC LIMIT 50
  `).all(req.user.id, like, req.workspaceId);

  const results = rows.map((r) => {
    let label = `#${r.channel_name}`;
    if (r.is_dm) {
      const other = db.prepare(`
        SELECT u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = ? AND cm.user_id != ? LIMIT 1
      `).get(r.channel_id, req.user.id);
      label = other ? `DM · ${other.name}` : 'Direct message';
    }
    return { ...r, channel_label: label };
  });

  // Clients matching name / GSTIN / PAN / code.
  const clients = db.prepare(`
    SELECT id, name, status, type, gstin, pan, client_code FROM clients
    WHERE workspace_id = ?
      AND (name LIKE ? ESCAPE '\\' OR gstin LIKE ? ESCAPE '\\' OR pan LIKE ? ESCAPE '\\' OR client_code LIKE ? ESCAPE '\\')
    ORDER BY name LIMIT 20
  `).all(req.workspaceId, like, like, like, like);

  // Tasks matching the title OR their linked client's name — respecting each
  // member's visibility (admins see all). This also surfaces "tasks of a client".
  const taskParams = [req.workspaceId, like, like];
  let visClause = '';
  if (req.user.role !== 'admin') {
    visClause = ` AND (t.creator_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?) OR EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = ?))`;
    taskParams.push(req.user.id, req.user.id, req.user.id);
  }
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.due_date, t.priority, t.client_id, t.archived_at,
           cl.name AS client_name, s.name AS stage, s.is_done
    FROM tasks t
    JOIN workflow_stages s ON s.id = t.stage_id
    LEFT JOIN clients cl ON cl.id = t.client_id
    WHERE t.workspace_id = ? AND (t.title LIKE ? ESCAPE '\\' OR cl.name LIKE ? ESCAPE '\\')${visClause}
    ORDER BY (t.archived_at IS NOT NULL), (s.is_done), t.updated_at DESC LIMIT 30
  `).all(...taskParams);

  res.json({ results, clients, tasks });
});

export default router;
