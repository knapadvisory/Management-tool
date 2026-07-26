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
import jwt from 'jsonwebtoken';

const router = Router();

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
  res.json({ token: signPortalSession(pu), user: publicPortalUser(pu, client?.name || '') });
});

// --- Authenticated portal (scoped to one client) ---

router.get('/me', requirePortal, (req, res) => {
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(req.portal.client_id);
  res.json({ user: publicPortalUser(req.portal, client?.name || '') });
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
router.post('/documents', requirePortal, upload.array('files', 10), (req, res) => {
  const pu = req.portal;
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND workspace_id = ?').get(pu.client_id, pu.workspace_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const staffId = pu.created_by
    || db.prepare("SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get(pu.workspace_id)?.id
    || db.prepare('SELECT id FROM users WHERE workspace_id = ? ORDER BY id LIMIT 1').get(pu.workspace_id)?.id;
  const folderId = clientDriveFolderId(client, pu.workspace_id, staffId);
  const ins = db.prepare(`INSERT INTO attachments (uploader_id, portal_uploader_id, stored_name, original_name, mime_type, size, client_id, is_drive, drive_folder_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  for (const f of req.files || []) {
    ins.run(staffId, pu.id, f.filename, f.originalname, f.mimetype, f.size, client.id, folderId, pu.workspace_id);
  }
  // Let the firm know a client sent something.
  req.app.get('io')?.to(`workspace:${pu.workspace_id}`).emit('clients:changed');
  req.app.get('io')?.to(`workspace:${pu.workspace_id}`).emit('drive:changed');
  res.status(201).json({ documents: docsFor(client.id) });
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
