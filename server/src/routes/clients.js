import { Router } from 'express';
import db from '../db.js';
import { publicUser } from '../auth.js';

const router = Router();
const TYPES = ['company', 'individual'];
const STATUSES = ['active', 'prospect', 'inactive'];
const RECURRENCES = ['none', 'monthly', 'quarterly', 'yearly'];

// Advance a YYYY-MM-DD date by one recurrence step.
function advanceDate(dateStr, recurrence) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (recurrence === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (recurrence === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

function clientWithMeta(c) {
  const openTasks = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks t JOIN workflow_stages s ON s.id = t.stage_id
    WHERE t.client_id = ? AND s.is_done = 0 AND t.archived_at IS NULL
  `).get(c.id).n;
  const nextDeadline = db.prepare(`
    SELECT title, due_date FROM client_deadlines
    WHERE client_id = ? AND completed = 0 ORDER BY due_date LIMIT 1
  `).get(c.id) || null;
  const contactCount = db.prepare('SELECT COUNT(*) AS n FROM client_contacts WHERE client_id = ?').get(c.id).n;
  return { ...c, open_task_count: openTasks, next_deadline: nextDeadline, contact_count: contactCount };
}

const load = (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return null; }
  return client;
};

// Sanitize the writable client fields from a request body.
function clientFields(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.type !== undefined) out.type = TYPES.includes(body.type) ? body.type : 'company';
  if (body.status !== undefined) out.status = STATUSES.includes(body.status) ? body.status : 'active';
  for (const f of ['email', 'phone', 'gstin', 'pan', 'address', 'notes']) {
    if (body[f] !== undefined) out[f] = String(body[f] || '').trim();
  }
  return out;
}

// --- Clients ---

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM clients WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ clients: rows.map(clientWithMeta) });
});

router.post('/', (req, res) => {
  const f = clientFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Client name is required' });
  const info = db.prepare(`
    INSERT INTO clients (name, type, status, email, phone, gstin, pan, address, notes, created_by, workspace_id)
    VALUES (@name, @type, @status, @email, @phone, @gstin, @pan, @address, @notes, @created_by, @workspace_id)
  `).run({
    name: f.name, type: f.type || 'company', status: f.status || 'active',
    email: f.email || '', phone: f.phone || '', gstin: f.gstin || '', pan: f.pan || '',
    address: f.address || '', notes: f.notes || '', created_by: req.user.id, workspace_id: req.workspaceId,
  });
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json(clientWithMeta(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid)));
});

// Bulk-create clients from a pasted list. Skips blanks and case-insensitive
// duplicate names (so re-importing is safe).
router.post('/bulk', (req, res) => {
  const rows = Array.isArray(req.body.clients) ? req.body.clients : [];
  if (!rows.length) return res.status(400).json({ error: 'Provide at least one client' });
  const existing = new Set(db.prepare('SELECT LOWER(name) AS n FROM clients WHERE workspace_id = ?').all(req.workspaceId).map((r) => r.n));
  const ins = db.prepare(`
    INSERT INTO clients (name, type, status, email, phone, gstin, pan, address, notes, created_by, workspace_id)
    VALUES (@name, @type, @status, @email, @phone, @gstin, @pan, @address, @notes, @created_by, @workspace_id)
  `);
  let created = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      const f = clientFields(r);
      if (!f.name || existing.has(f.name.toLowerCase())) { skipped++; continue; }
      existing.add(f.name.toLowerCase());
      ins.run({
        name: f.name, type: f.type || 'company', status: f.status || 'active',
        email: f.email || '', phone: f.phone || '', gstin: f.gstin || '', pan: f.pan || '',
        address: f.address || '', notes: f.notes || '', created_by: req.user.id, workspace_id: req.workspaceId,
      });
      created++;
    }
  })();
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json({ created, skipped });
});

// Assign one recurring deadline (e.g. GSTR-3B, monthly) to many clients at once.
// Skips clients that already have an open deadline with the same title.
router.post('/deadlines/bulk', (req, res) => {
  const title = String(req.body.title || '').trim();
  const due_date = String(req.body.due_date || '').trim();
  const recurrence = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : 'monthly';
  const ids = Array.isArray(req.body.client_ids) ? [...new Set(req.body.client_ids.map(Number).filter(Boolean))] : [];
  if (!title) return res.status(400).json({ error: 'A deadline title is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return res.status(400).json({ error: 'A valid due date (YYYY-MM-DD) is required' });
  if (!ids.length) return res.status(400).json({ error: 'Select at least one client' });
  const valid = new Set(db.prepare('SELECT id FROM clients WHERE workspace_id = ?').all(req.workspaceId).map((r) => r.id));
  const hasOpen = db.prepare('SELECT 1 FROM client_deadlines WHERE client_id = ? AND title = ? AND completed = 0');
  const ins = db.prepare('INSERT INTO client_deadlines (client_id, title, due_date, recurrence, created_by) VALUES (?, ?, ?, ?, ?)');
  let created = 0, skipped = 0;
  db.transaction(() => {
    for (const cid of ids) {
      if (!valid.has(cid) || hasOpen.get(cid, title)) { skipped++; continue; }
      ins.run(cid, title, due_date, recurrence, req.user.id);
      created++;
    }
  })();
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json({ created, skipped });
});

router.get('/:id', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const contacts = db.prepare('SELECT * FROM client_contacts WHERE client_id = ? ORDER BY id').all(client.id);
  const notes = db.prepare(`
    SELECT n.*, u.name AS user_name, u.avatar_color FROM client_notes n
    JOIN users u ON u.id = n.user_id WHERE n.client_id = ? ORDER BY n.id DESC
  `).all(client.id);
  const deadlines = db.prepare('SELECT * FROM client_deadlines WHERE client_id = ? ORDER BY completed, due_date').all(client.id);
  res.json({ client: clientWithMeta(client), contacts, notes, deadlines });
});

router.patch('/:id', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const f = clientFields(req.body);
  if (f.name === '') return res.status(400).json({ error: 'Client name cannot be empty' });
  const merged = { ...client, ...f };
  db.prepare(`
    UPDATE clients SET name=@name, type=@type, status=@status, email=@email, phone=@phone,
      gstin=@gstin, pan=@pan, address=@address, notes=@notes WHERE id=@id
  `).run({ ...merged });
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.json(clientWithMeta(db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id)));
});

router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can delete a client' });
  const client = load(req, res);
  if (!client) return;
  db.prepare('UPDATE tasks SET client_id = NULL WHERE client_id = ?').run(client.id); // tasks survive
  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id); // contacts/notes/deadlines cascade
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.json({ ok: true });
});

// Tasks linked to a client (respecting each member's task visibility).
router.get('/:id/tasks', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  let sql = `SELECT t.* FROM tasks t WHERE t.client_id = ? AND t.workspace_id = ?`;
  const params = [client.id, req.workspaceId];
  if (req.user.role !== 'admin') {
    sql += ` AND (t.creator_id = ? OR t.assignee_id = ? OR EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = ?))`;
    params.push(req.user.id, req.user.id, req.user.id);
  }
  sql += ' ORDER BY t.archived_at IS NOT NULL, t.updated_at DESC';
  const tasks = db.prepare(sql).all(...params).map((t) => {
    const stage = db.prepare('SELECT name, is_done FROM workflow_stages WHERE id = ?').get(t.stage_id);
    return {
      id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date,
      stage: stage?.name || null, is_done: !!stage?.is_done, archived: !!t.archived_at,
      assignee: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(t.assignee_id)),
    };
  });
  res.json({ tasks });
});

// --- Contacts ---

router.post('/:id/contacts', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  db.prepare('INSERT INTO client_contacts (client_id, name, role, email, phone) VALUES (?, ?, ?, ?, ?)')
    .run(client.id, name, String(req.body.role || '').trim(), String(req.body.email || '').trim(), String(req.body.phone || '').trim());
  res.status(201).json(db.prepare('SELECT * FROM client_contacts WHERE client_id = ? ORDER BY id').all(client.id));
});

router.patch('/:id/contacts/:cid', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const contact = db.prepare('SELECT * FROM client_contacts WHERE id = ? AND client_id = ?').get(req.params.cid, client.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  db.prepare('UPDATE client_contacts SET name = COALESCE(?, name), role = COALESCE(?, role), email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?')
    .run(req.body.name?.trim() || null, req.body.role ?? null, req.body.email ?? null, req.body.phone ?? null, contact.id);
  res.json(db.prepare('SELECT * FROM client_contacts WHERE client_id = ? ORDER BY id').all(client.id));
});

router.delete('/:id/contacts/:cid', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  db.prepare('DELETE FROM client_contacts WHERE id = ? AND client_id = ?').run(req.params.cid, client.id);
  res.json(db.prepare('SELECT * FROM client_contacts WHERE client_id = ? ORDER BY id').all(client.id));
});

// --- Notes ---

router.post('/:id/notes', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note cannot be empty' });
  db.prepare('INSERT INTO client_notes (client_id, user_id, body) VALUES (?, ?, ?)').run(client.id, req.user.id, body);
  res.status(201).json(db.prepare(`
    SELECT n.*, u.name AS user_name, u.avatar_color FROM client_notes n
    JOIN users u ON u.id = n.user_id WHERE n.client_id = ? ORDER BY n.id DESC
  `).all(client.id));
});

router.delete('/:id/notes/:nid', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const note = db.prepare('SELECT * FROM client_notes WHERE id = ? AND client_id = ?').get(req.params.nid, client.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if (note.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own notes' });
  db.prepare('DELETE FROM client_notes WHERE id = ?').run(note.id);
  res.json({ ok: true });
});

// --- Deadlines ---

router.post('/:id/deadlines', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const title = String(req.body.title || '').trim();
  const due_date = String(req.body.due_date || '').trim();
  if (!title) return res.status(400).json({ error: 'Deadline title is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return res.status(400).json({ error: 'A valid due date (YYYY-MM-DD) is required' });
  const recurrence = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : 'none';
  db.prepare('INSERT INTO client_deadlines (client_id, title, due_date, recurrence, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(client.id, title, due_date, recurrence, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM client_deadlines WHERE client_id = ? ORDER BY completed, due_date').all(client.id));
});

// Toggle a deadline done. Completing a recurring one spawns the next occurrence.
router.patch('/:id/deadlines/:did', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const dl = db.prepare('SELECT * FROM client_deadlines WHERE id = ? AND client_id = ?').get(req.params.did, client.id);
  if (!dl) return res.status(404).json({ error: 'Deadline not found' });
  if (req.body.completed !== undefined) {
    const done = req.body.completed ? 1 : 0;
    db.prepare('UPDATE client_deadlines SET completed = ? WHERE id = ?').run(done, dl.id);
    if (done && dl.recurrence !== 'none') {
      const next = advanceDate(dl.due_date, dl.recurrence);
      if (next) db.prepare('INSERT INTO client_deadlines (client_id, title, due_date, recurrence, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(client.id, dl.title, next, dl.recurrence, req.user.id);
    }
  }
  if (req.body.title !== undefined || req.body.due_date !== undefined || req.body.recurrence !== undefined) {
    db.prepare('UPDATE client_deadlines SET title = COALESCE(?, title), due_date = COALESCE(?, due_date), recurrence = COALESCE(?, recurrence) WHERE id = ?')
      .run(req.body.title?.trim() || null, req.body.due_date || null, RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null, dl.id);
  }
  res.json(db.prepare('SELECT * FROM client_deadlines WHERE client_id = ? ORDER BY completed, due_date').all(client.id));
});

router.delete('/:id/deadlines/:did', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  db.prepare('DELETE FROM client_deadlines WHERE id = ? AND client_id = ?').run(req.params.did, client.id);
  res.json(db.prepare('SELECT * FROM client_deadlines WHERE client_id = ? ORDER BY completed, due_date').all(client.id));
});

export default router;
