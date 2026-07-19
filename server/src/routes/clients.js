import { Router } from 'express';
import db, { getSetting, setSetting } from '../db.js';
import { publicUser } from '../auth.js';
import { completeDeadline } from '../compliance.js';
import { timeForClient } from './time.js';

// Custom compliance filing names, per workspace (on top of the built-in ones
// the client offers). Stored as a JSON array in app_settings.
const typesKey = (ws) => `compliance_types:${ws}`;
const getTypes = (ws) => { try { return JSON.parse(getSetting(typesKey(ws)) || '[]'); } catch { return []; } };

const router = Router();
const TYPES = ['company', 'individual'];
const STATUSES = ['active', 'prospect', 'inactive'];
const RECURRENCES = ['none', 'monthly', 'quarterly', 'yearly'];

// Deadlines for a client, with the assignee (who files it) joined in.
const deadlinesFor = (clientId) => db.prepare(`
  SELECT d.*, u.name AS assignee_name, u.avatar_color AS assignee_color
  FROM client_deadlines d LEFT JOIN users u ON u.id = d.assignee_id
  WHERE d.client_id = ? ORDER BY d.completed, d.due_date
`).all(clientId);

const isWsUser = (id, ws) => id && db.prepare('SELECT 1 FROM users WHERE id = ? AND workspace_id = ?').get(id, ws);

const tagsFor = (clientId) => db.prepare('SELECT tag FROM client_tags WHERE client_id = ? ORDER BY tag').all(clientId).map((r) => r.tag);

// Replace a client's tags with a cleaned, de-duplicated set (case-insensitive).
function setTags(clientId, tags) {
  if (!Array.isArray(tags)) return;
  db.prepare('DELETE FROM client_tags WHERE client_id = ?').run(clientId);
  const seen = new Set();
  const ins = db.prepare('INSERT OR IGNORE INTO client_tags (client_id, tag) VALUES (?, ?)');
  for (const raw of tags) {
    const tag = String(raw || '').trim().slice(0, 40);
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); ins.run(clientId, tag); }
  }
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
  const documentCount = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE client_id = ?').get(c.id).n;
  return { ...c, open_task_count: openTasks, next_deadline: nextDeadline, contact_count: contactCount, document_count: documentCount, tags: tagsFor(c.id) };
}

const load = (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return null; }
  return client;
};

// Free-text client-master fields, stored verbatim (trimmed).
const TEXT_FIELDS = [
  'email', 'phone', 'gstin', 'pan', 'address', 'notes',
  'client_code', 'constitution', 'firm', 'tan', 'cin', 'contact_person',
  'onboarding_date', 'gst_frequency', 'fee_model', 'fee_amount',
  'turnover_band', 'risk_rating', 'independence_flag',
];

// Sanitize the writable client fields from a request body.
function clientFields(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.type !== undefined) out.type = TYPES.includes(body.type) ? body.type : 'company';
  if (body.status !== undefined) out.status = STATUSES.includes(body.status) ? body.status : 'active';
  for (const f of TEXT_FIELDS) {
    if (body[f] !== undefined) out[f] = String(body[f] || '').trim();
  }
  return out;
}

// Build the full column set (with defaults) for an INSERT, so every code path
// stays in sync as the schema grows.
function insertRow(f, req) {
  const row = { name: f.name, type: f.type || 'company', status: f.status || 'active', created_by: req.user.id, workspace_id: req.workspaceId };
  for (const c of TEXT_FIELDS) row[c] = f[c] || '';
  return row;
}
const INSERT_COLS = ['name', 'type', 'status', ...TEXT_FIELDS, 'created_by', 'workspace_id'];
const insertClientSql = `INSERT INTO clients (${INSERT_COLS.join(', ')}) VALUES (${INSERT_COLS.map((c) => '@' + c).join(', ')})`;

// --- Clients ---

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM clients WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ clients: rows.map(clientWithMeta) });
});

router.post('/', (req, res) => {
  const f = clientFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Client name is required' });
  const info = db.prepare(insertClientSql).run(insertRow(f, req));
  if (req.body.tags !== undefined) setTags(info.lastInsertRowid, req.body.tags);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json(clientWithMeta(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid)));
});

// Distinct tags across the workspace's clients (for the segment filter).
router.get('/tags', (req, res) => {
  res.json({ tags: db.prepare(`
    SELECT DISTINCT ct.tag FROM client_tags ct JOIN clients c ON c.id = ct.client_id
    WHERE c.workspace_id = ? ORDER BY ct.tag
  `).all(req.workspaceId).map((r) => r.tag) });
});

// Custom compliance types (firm-wide additions to the built-in list).
router.get('/compliance-types', (req, res) => {
  res.json({ types: getTypes(req.workspaceId) });
});
router.post('/compliance-types', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A name is required' });
  const list = getTypes(req.workspaceId);
  if (!list.some((t) => t.toLowerCase() === name.toLowerCase())) {
    list.push(name);
    setSetting(typesKey(req.workspaceId), JSON.stringify(list.slice(0, 100)));
    req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  }
  res.status(201).json({ types: getTypes(req.workspaceId) });
});
router.delete('/compliance-types/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const list = getTypes(req.workspaceId).filter((t) => t.toLowerCase() !== name.toLowerCase());
  setSetting(typesKey(req.workspaceId), JSON.stringify(list));
  res.json({ types: list });
});

// Bulk-import clients. Default mode adds new clients and skips case-insensitive
// duplicate names. With `update: true`, an existing client is UPDATED in place
// (matched by client_code, else PAN, else name) so a firm can maintain the
// master by re-uploading — new rows are still created.
router.post('/bulk', (req, res) => {
  const rows = Array.isArray(req.body.clients) ? req.body.clients : [];
  if (!rows.length) return res.status(400).json({ error: 'Provide at least one client' });
  const update = !!req.body.update;

  const all = db.prepare('SELECT * FROM clients WHERE workspace_id = ?').all(req.workspaceId);
  const byName = new Map(all.map((c) => [c.name.toLowerCase(), c]));
  const byCode = new Map(all.filter((c) => c.client_code).map((c) => [c.client_code.toLowerCase(), c]));
  const byPan = new Map(all.filter((c) => c.pan).map((c) => [c.pan.toLowerCase(), c]));
  const findExisting = (f) =>
    (f.client_code && byCode.get(f.client_code.toLowerCase())) ||
    (f.pan && byPan.get(f.pan.toLowerCase())) ||
    (f.name && byName.get(f.name.toLowerCase())) || null;

  const ins = db.prepare(insertClientSql);
  let created = 0, updated = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      const f = clientFields(r);
      if (!f.name) { skipped++; continue; }
      const match = findExisting(f);
      if (match) {
        if (!update) { skipped++; continue; }
        // Update only the fields provided (non-empty), keep the rest.
        const merged = { ...match };
        for (const k of ['name', 'type', 'status', ...TEXT_FIELDS]) if (f[k] !== undefined && f[k] !== '') merged[k] = f[k];
        const sets = ['name', 'type', 'status', ...TEXT_FIELDS].map((c) => `${c}=@${c}`).join(', ');
        db.prepare(`UPDATE clients SET ${sets} WHERE id=@id`).run(merged);
        if (Array.isArray(r.tags) && r.tags.length) setTags(match.id, r.tags);
        updated++;
        continue;
      }
      const info = ins.run(insertRow(f, req));
      const created_c = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
      byName.set(created_c.name.toLowerCase(), created_c);
      if (created_c.client_code) byCode.set(created_c.client_code.toLowerCase(), created_c);
      if (created_c.pan) byPan.set(created_c.pan.toLowerCase(), created_c);
      if (Array.isArray(r.tags) && r.tags.length) setTags(info.lastInsertRowid, r.tags);
      created++;
    }
  })();
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json({ created, updated, skipped });
});

// Assign one recurring deadline (e.g. GSTR-3B, monthly) to many clients at once.
// Skips clients that already have an open deadline with the same title.
router.post('/deadlines/bulk', (req, res) => {
  const title = String(req.body.title || '').trim();
  const due_date = String(req.body.due_date || '').trim();
  const recurrence = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : 'monthly';
  const assignee_id = isWsUser(req.body.assignee_id, req.workspaceId) ? req.body.assignee_id : null;
  const createTasks = !!req.body.create_tasks;
  const ids = Array.isArray(req.body.client_ids) ? [...new Set(req.body.client_ids.map(Number).filter(Boolean))] : [];
  if (!title) return res.status(400).json({ error: 'A deadline title is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return res.status(400).json({ error: 'A valid due date (YYYY-MM-DD) is required' });
  if (!ids.length) return res.status(400).json({ error: 'Select at least one client' });
  const clientsById = new Map(db.prepare('SELECT id, name FROM clients WHERE workspace_id = ?').all(req.workspaceId).map((c) => [c.id, c]));
  const hasOpen = db.prepare('SELECT 1 FROM client_deadlines WHERE client_id = ? AND title = ? AND completed = 0');
  const insDl = db.prepare('INSERT INTO client_deadlines (client_id, title, due_date, recurrence, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?)');
  // For optional task generation.
  const wf = createTasks ? db.prepare('SELECT * FROM workflows WHERE workspace_id = ? ORDER BY id LIMIT 1').get(req.workspaceId) : null;
  const stage = wf ? db.prepare('SELECT id FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wf.id) : null;
  const insTask = db.prepare(`INSERT INTO tasks (title, workflow_id, client_id, stage_id, assignee_id, creator_id, priority, due_date, recurrence, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, 'high', ?, 'none', ?)`);
  const insWatch = db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)');
  let created = 0, skipped = 0, tasks = 0;
  db.transaction(() => {
    for (const cid of ids) {
      const client = clientsById.get(cid);
      if (!client || hasOpen.get(cid, title)) { skipped++; continue; }
      const dlInfo = insDl.run(cid, title, due_date, recurrence, assignee_id, req.user.id);
      created++;
      if (createTasks && stage) {
        const tInfo = insTask.run(`${title} — ${client.name}`, wf.id, cid, stage.id, assignee_id, req.user.id, due_date, req.workspaceId);
        insWatch.run(tInfo.lastInsertRowid, req.user.id);
        if (assignee_id) {
          insWatch.run(tInfo.lastInsertRowid, assignee_id);
          db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(tInfo.lastInsertRowid, assignee_id);
        }
        db.prepare('UPDATE client_deadlines SET task_id = ? WHERE id = ?').run(tInfo.lastInsertRowid, dlInfo.lastInsertRowid);
        tasks++;
      }
    }
  })();
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json({ created, skipped, tasks });
});

// Firm-wide compliance board: every deadline due up to the end of a month
// (plus anything still-open and overdue from before), with client + assignee,
// and a per-filing summary (how many filed vs total).
router.get('/deadlines/board', (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const start = `${m}-01`;
  const end = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10); // last day of month
  const rows = db.prepare(`
    SELECT d.*, c.name AS client_name, u.name AS assignee_name, u.avatar_color AS assignee_color,
           EXISTS (SELECT 1 FROM tasks t WHERE t.id = d.task_id) AS has_task
    FROM client_deadlines d
    JOIN clients c ON c.id = d.client_id
    LEFT JOIN users u ON u.id = d.assignee_id
    WHERE c.workspace_id = ?
      AND d.due_date <= ?
      AND (d.completed = 0 OR d.due_date >= ?)
    ORDER BY d.due_date, c.name
  `).all(req.workspaceId, end, start);
  // Per-filing progress (GSTR-3B: 40/100 filed, …).
  const byTitle = new Map();
  for (const r of rows) {
    if (!byTitle.has(r.title)) byTitle.set(r.title, { title: r.title, total: 0, done: 0 });
    const s = byTitle.get(r.title);
    s.total += 1;
    if (r.completed) s.done += 1;
  }
  res.json({ month: m, deadlines: rows, summary: [...byTitle.values()].sort((a, b) => b.total - a.total) });
});

// Compliance matrix: a grid of clients (rows) x filing types (columns), each
// cell showing that filing's status for the month (filed / overdue / due).
router.get('/matrix', (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const start = `${m}-01`;
  const end = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT d.client_id, c.name AS client_name, d.title, d.due_date, d.completed
    FROM client_deadlines d JOIN clients c ON c.id = d.client_id
    WHERE c.workspace_id = ? AND d.due_date <= ? AND (d.completed = 0 OR d.due_date >= ?)
    ORDER BY c.name
  `).all(req.workspaceId, end, start);

  const titles = new Set();
  const clients = new Map(); // id -> { client_id, name, cells }
  for (const r of rows) {
    titles.add(r.title);
    if (!clients.has(r.client_id)) clients.set(r.client_id, { client_id: r.client_id, name: r.client_name, tags: tagsFor(r.client_id), cells: {} });
    const status = r.completed ? 'filed' : (r.due_date < today ? 'overdue' : 'due');
    // Keep the most urgent status if a client has more than one of a title.
    const rank = { overdue: 3, due: 2, filed: 1 };
    const cur = clients.get(r.client_id).cells[r.title];
    if (!cur || rank[status] > rank[cur.status]) clients.get(r.client_id).cells[r.title] = { status, due_date: r.due_date };
  }
  res.json({
    month: m,
    columns: [...titles].sort(),
    rows: [...clients.values()].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

router.get('/:id', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const contacts = db.prepare('SELECT * FROM client_contacts WHERE client_id = ? ORDER BY id').all(client.id);
  const notes = db.prepare(`
    SELECT n.*, u.name AS user_name, u.avatar_color FROM client_notes n
    JOIN users u ON u.id = n.user_id WHERE n.client_id = ? ORDER BY n.id DESC
  `).all(client.id);
  const documents = db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, u.name AS uploaded_by
    FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id
    WHERE a.client_id = ? ORDER BY a.id DESC
  `).all(client.id);
  res.json({ client: clientWithMeta(client), contacts, notes, deadlines: deadlinesFor(client.id), documents, time: timeForClient(client.id) });
});

// --- Documents (files uploaded via /api/uploads, then filed here) ---
router.post('/:id/documents', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const ids = Array.isArray(req.body.attachment_ids) ? req.body.attachment_ids : [];
  const link = db.prepare('UPDATE attachments SET client_id = ? WHERE id = ? AND uploader_id = ? AND client_id IS NULL AND task_id IS NULL AND message_id IS NULL AND task_message_id IS NULL');
  for (const aid of ids) link.run(client.id, aid, req.user.id);
  req.app.get('io')?.to(`workspace:${req.workspaceId}`).emit('clients:changed');
  res.status(201).json(db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, u.name AS uploaded_by
    FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id
    WHERE a.client_id = ? ORDER BY a.id DESC
  `).all(client.id));
});

router.delete('/:id/documents/:attId', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  db.prepare('DELETE FROM attachments WHERE id = ? AND client_id = ?').run(req.params.attId, client.id);
  res.json(db.prepare(`
    SELECT a.id, a.original_name, a.mime_type, a.size, a.created_at, u.name AS uploaded_by
    FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id
    WHERE a.client_id = ? ORDER BY a.id DESC
  `).all(client.id));
});

router.patch('/:id', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const f = clientFields(req.body);
  if (f.name === '') return res.status(400).json({ error: 'Client name cannot be empty' });
  const merged = { ...client, ...f };
  const sets = ['name', 'type', 'status', ...TEXT_FIELDS].map((c) => `${c}=@${c}`).join(', ');
  db.prepare(`UPDATE clients SET ${sets} WHERE id=@id`).run(merged);
  if (req.body.tags !== undefined) setTags(client.id, req.body.tags);
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
  const assignee_id = isWsUser(req.body.assignee_id, req.workspaceId) ? req.body.assignee_id : null;
  db.prepare('INSERT INTO client_deadlines (client_id, title, due_date, recurrence, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(client.id, title, due_date, recurrence, assignee_id, req.user.id);
  res.status(201).json(deadlinesFor(client.id));
});

// Toggle a deadline done (recurring ones spawn the next), or edit its fields
// including the assignee.
router.patch('/:id/deadlines/:did', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const dl = db.prepare('SELECT * FROM client_deadlines WHERE id = ? AND client_id = ?').get(req.params.did, client.id);
  if (!dl) return res.status(404).json({ error: 'Deadline not found' });
  if (req.body.completed !== undefined) {
    if (req.body.completed) completeDeadline(dl, req.user.id);
    else db.prepare('UPDATE client_deadlines SET completed = 0 WHERE id = ?').run(dl.id);
  }
  if (req.body.assignee_id !== undefined) {
    const aid = isWsUser(req.body.assignee_id, req.workspaceId) ? req.body.assignee_id : null;
    db.prepare('UPDATE client_deadlines SET assignee_id = ? WHERE id = ?').run(aid, dl.id);
  }
  if (req.body.title !== undefined || req.body.due_date !== undefined || req.body.recurrence !== undefined) {
    db.prepare('UPDATE client_deadlines SET title = COALESCE(?, title), due_date = COALESCE(?, due_date), recurrence = COALESCE(?, recurrence) WHERE id = ?')
      .run(req.body.title?.trim() || null, req.body.due_date || null, RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null, dl.id);
  }
  res.json(deadlinesFor(client.id));
});

router.delete('/:id/deadlines/:did', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  db.prepare('DELETE FROM client_deadlines WHERE id = ? AND client_id = ?').run(req.params.did, client.id);
  res.json(deadlinesFor(client.id));
});

// Turn a deadline into an assignable task (in the default board), linked to the
// client + assignee, due on the deadline date. Completing that task later ticks
// the deadline off automatically.
router.post('/:id/deadlines/:did/task', (req, res) => {
  const client = load(req, res);
  if (!client) return;
  const dl = db.prepare('SELECT * FROM client_deadlines WHERE id = ? AND client_id = ?').get(req.params.did, client.id);
  if (!dl) return res.status(404).json({ error: 'Deadline not found' });
  if (dl.task_id && db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(dl.task_id)) {
    return res.status(400).json({ error: 'A task already exists for this deadline' });
  }
  const wf = db.prepare('SELECT * FROM workflows WHERE workspace_id = ? ORDER BY id LIMIT 1').get(req.workspaceId);
  if (!wf) return res.status(400).json({ error: 'No board exists to create the task in' });
  const stage = db.prepare('SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wf.id);
  if (!stage) return res.status(400).json({ error: 'The board has no stages yet — add a stage first.' });
  const info = db.prepare(`
    INSERT INTO tasks (title, description, workflow_id, client_id, stage_id, assignee_id, creator_id, priority, due_date, recurrence, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'high', ?, 'none', ?)
  `).run(`${dl.title} — ${client.name}`, '', wf.id, client.id, stage.id, dl.assignee_id || null, req.user.id, dl.due_date, req.workspaceId);
  const taskId = info.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, req.user.id);
  if (dl.assignee_id) {
    db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, dl.assignee_id);
    db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(taskId, dl.assignee_id);
  }
  db.prepare('UPDATE client_deadlines SET task_id = ? WHERE id = ?').run(taskId, dl.id);
  res.status(201).json({ task_id: taskId, deadlines: deadlinesFor(client.id) });
});

export default router;
