import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { signPortalMagic, signPortalSession, requirePortal, JWT_SECRET } from '../auth.js';
import { clientDriveFolderId } from './clients.js';
import { emailEnabled, sendMail, layout, button } from '../email.js';
import { createNotification } from '../notifications.js';
import { emitClientChanged } from '../realtime.js';
import { getSetting } from '../db.js';
import jwt from 'jsonwebtoken';

const router = Router();

// The firm name shown on the portal (single-tenant: the sole workspace's name).
const firmName = () => getSetting('portal_firm_name')
  || db.prepare('SELECT name FROM workspaces ORDER BY id LIMIT 1').get()?.name
  || 'Client Portal';

// Let the firm know a client did something — notify the account manager who
// invited them (or, failing that, the workspace admins).
function notifyFirm(io, pu, text) {
  let ids = [];
  if (pu.created_by) ids = [pu.created_by];
  else ids = db.prepare("SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1").all(pu.workspace_id).map((r) => r.id);
  for (const uid of ids) createNotification(io, { user_id: uid, type: 'portal', text });
}

// Files land in the same store as staff uploads.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const appUrl = (req) => (process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`);
const publicPortalUser = (pu, clientName) => ({ name: pu.name || pu.email, email: pu.email, client: clientName });

// --- Sign in (unauthenticated) ---

// Request a magic sign-in link. Always answers 200 so we never reveal whether
// an email is registered; only sends when an active portal user matches.
router.post('/request-link', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Enter your email address.' });
  const pu = db.prepare('SELECT * FROM portal_users WHERE lower(email) = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(email);
  if (pu) {
    const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(pu.client_id);
    const link = `${appUrl(req)}/portal?token=${signPortalMagic(pu)}`;
    if (emailEnabled()) {
      sendMail({
        to: pu.email,
        subject: `Sign in to your ${client?.name || ''} client portal`,
        html: layout(`<p>Hello${pu.name ? ` ${pu.name}` : ''},</p><p>Use the button below to sign in to your client portal. The link is valid for 45 minutes.</p>${button('Open my portal', link)}<p style="color:#888;font-size:13px">If you didn't request this, you can ignore this email.</p>`),
      }).catch(() => {});
    }
  }
  res.json({ sent: true });
});

// Exchange a magic-link token for a portal session.
router.post('/login', (req, res) => {
  let p;
  try { p = jwt.verify(String(req.body?.token || ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'This sign-in link is invalid or has expired. Request a new one.' }); }
  if (p.purpose !== 'portal-magic') return res.status(401).json({ error: 'Invalid sign-in link.' });
  const pu = db.prepare('SELECT * FROM portal_users WHERE id = ? AND active = 1').get(p.pid);
  if (!pu) return res.status(401).json({ error: 'This portal access is no longer active.' });
  db.prepare("UPDATE portal_users SET last_login = datetime('now') WHERE id = ?").run(pu.id);
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(pu.client_id);
  res.json({ token: signPortalSession(pu), user: publicPortalUser(pu, client?.name || ''), firm: firmName() });
});

// Public branding for the sign-in screen (no session yet).
router.get('/branding', (req, res) => res.json({ firm: firmName() }));

// --- Authenticated portal (scoped to one client) ---

router.get('/me', requirePortal, (req, res) => {
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(req.portal.client_id);
  res.json({ user: publicPortalUser(req.portal, client?.name || ''), firm: firmName() });
});

const docsFor = (clientId) => db.prepare(`
  SELECT id, original_name, mime_type, size, created_at, portal_uploader_id
  FROM attachments WHERE client_id = ? AND archived_at IS NULL ORDER BY id DESC`).all(clientId).map((d) => ({
    id: d.id, original_name: d.original_name, mime_type: d.mime_type, size: d.size, created_at: d.created_at,
    source: d.portal_uploader_id ? 'you' : 'firm',
  }));

router.get('/documents', requirePortal, (req, res) => {
  res.json({ documents: docsFor(req.portal.client_id) });
});

// A client uploads documents — filed into their own Drive folder, credited to
// the inviting staff (so existing joins hold) but tagged as a portal upload.
// An optional request_id answers a specific document request.
router.post('/documents', requirePortal, upload.array('files', 10), (req, res) => {
  const pu = req.portal;
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND workspace_id = ?').get(pu.client_id, pu.workspace_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const staffId = pu.created_by
    || db.prepare("SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get(pu.workspace_id)?.id
    || db.prepare('SELECT id FROM users WHERE workspace_id = ? ORDER BY id LIMIT 1').get(pu.workspace_id)?.id;
  const folderId = clientDriveFolderId(client, pu.workspace_id, staffId);
  // Only honour a request_id that belongs to this client and is still open.
  const rid = req.body?.request_id ? Number(req.body.request_id) : null;
  const request = rid ? db.prepare("SELECT * FROM document_requests WHERE id = ? AND client_id = ? AND status != 'done'").get(rid, client.id) : null;
  const ins = db.prepare(`INSERT INTO attachments (uploader_id, portal_uploader_id, stored_name, original_name, mime_type, size, client_id, request_id, is_drive, drive_folder_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  for (const f of req.files || []) {
    ins.run(staffId, pu.id, f.filename, f.originalname, f.mimetype, f.size, client.id, request ? request.id : null, folderId, pu.workspace_id);
  }
  if (request && (req.files || []).length) {
    db.prepare("UPDATE document_requests SET status = 'received' WHERE id = ?").run(request.id);
  }
  const io = req.app.get('io');
  emitClientChanged(io, pu.workspace_id, client.id);
  io?.to(`workspace:${pu.workspace_id}`).emit('drive:changed');
  const n = (req.files || []).length;
  if (n) notifyFirm(io, pu, `${pu.name || pu.email} (${client.name}) uploaded ${n} document${n === 1 ? '' : 's'}${request ? ` for "${request.title}"` : ''}`);
  res.status(201).json({ documents: docsFor(client.id), requests: requestsForPortal(client.id) });
});

// Document requests the firm has raised for this client.
const requestsForPortal = (clientId) => db.prepare(`
  SELECT id, title, note, due_date, status, created_at FROM document_requests
  WHERE client_id = ? ORDER BY (status = 'done'), due_date IS NULL, due_date, id DESC`).all(clientId);

router.get('/requests', requirePortal, (req, res) => {
  res.json({ requests: requestsForPortal(req.portal.client_id) });
});

// Read-only filing status straight from the firm's compliance deadlines.
router.get('/filings', requirePortal, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT id, title, due_date, recurrence, completed, completed_at FROM client_deadlines
    WHERE client_id = ? ORDER BY (completed = 1), due_date`).all(req.portal.client_id).map((d) => ({
      id: d.id, title: d.title, due_date: d.due_date, recurrence: d.recurrence,
      status: d.completed ? 'filed' : (d.due_date < today ? 'overdue' : 'due'),
      filed_on: d.completed_at ? String(d.completed_at).slice(0, 10) : null,
    }));
  res.json({ filings: rows });
});

// --- Messages (two-way thread with the firm) ---
const msgsFor = (clientId) => db.prepare(`
  SELECT id, sender, author_name, body, created_at FROM portal_messages
  WHERE client_id = ? ORDER BY id`).all(clientId);

router.get('/messages', requirePortal, (req, res) => {
  res.json({ messages: msgsFor(req.portal.client_id) });
});

router.post('/messages', requirePortal, (req, res) => {
  const pu = req.portal;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  db.prepare('INSERT INTO portal_messages (client_id, workspace_id, sender, portal_id, author_name, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pu.client_id, pu.workspace_id, 'client', pu.id, pu.name || pu.email, body);
  const io = req.app.get('io');
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(pu.client_id);
  notifyFirm(io, pu, `${pu.name || pu.email} (${client?.name || 'a client'}) sent a portal message`);
  emitClientChanged(io, pu.workspace_id, pu.client_id);
  res.status(201).json({ messages: msgsFor(pu.client_id) });
});

// Stream a document the client is allowed to see (their own client's files).
router.get('/documents/:id/download', requirePortal, (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND client_id = ? AND archived_at IS NULL').get(req.params.id, req.portal.client_id);
  if (!att) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(uploadDir, att.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.download(filePath, att.original_name);
});

export default router;
