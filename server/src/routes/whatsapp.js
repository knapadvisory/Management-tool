// Authenticated WhatsApp settings: admins configure the Cloud API connection;
// each teammate links their own WhatsApp number so the bot knows who they are.
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { digits } from '../whatsapp.js';

const router = Router();
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
const baseUrl = (req) => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

router.get('/config', requireAdmin, (req, res) => {
  let ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  if (!ws.wa_verify_token) {
    db.prepare('UPDATE workspaces SET wa_verify_token = ? WHERE id = ?').run(crypto.randomBytes(16).toString('hex'), ws.id);
    ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id);
  }
  res.json({
    enabled: !!ws.wa_enabled,
    phone_number_id: ws.wa_phone_number_id || '',
    verify_token: ws.wa_verify_token,
    has_token: !!ws.wa_access_token,
    task_workflow_id: ws.wa_task_workflow_id || null,
    webhook_url: `${baseUrl(req)}/api/whatsapp/webhook`,
    workflows: db.prepare('SELECT id, name FROM workflows WHERE workspace_id = ? ORDER BY id').all(req.workspaceId),
  });
});

router.put('/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.phone_number_id !== undefined) { sets.push('wa_phone_number_id = ?'); vals.push(String(b.phone_number_id).trim() || null); }
  if (b.access_token) { sets.push('wa_access_token = ?'); vals.push(String(b.access_token).trim()); } // only when provided
  if (b.enabled !== undefined) { sets.push('wa_enabled = ?'); vals.push(b.enabled ? 1 : 0); }
  if (b.task_workflow_id !== undefined) {
    const wf = b.task_workflow_id ? db.prepare('SELECT id FROM workflows WHERE id = ? AND workspace_id = ?').get(b.task_workflow_id, req.workspaceId) : null;
    sets.push('wa_task_workflow_id = ?'); vals.push(wf ? wf.id : null);
  }
  if (sets.length) db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.workspaceId);
  res.json({ ok: true });
});

router.post('/config/verify-token', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE workspaces SET wa_verify_token = ? WHERE id = ?').run(token, req.workspaceId);
  res.json({ verify_token: token });
});

// A teammate links (or clears) their own WhatsApp number.
router.put('/me', (req, res) => {
  const num = req.body?.whatsapp_number ? digits(req.body.whatsapp_number).slice(0, 20) : null;
  db.prepare('UPDATE users SET whatsapp_number = ? WHERE id = ?').run(num, req.user.id);
  res.json({ whatsapp_number: num });
});
router.get('/me', (req, res) => {
  res.json({ whatsapp_number: db.prepare('SELECT whatsapp_number FROM users WHERE id = ?').get(req.user.id).whatsapp_number || '' });
});

// Admin sets/clears a teammate's number (from the roster).
router.put('/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const num = req.body?.whatsapp_number ? digits(req.body.whatsapp_number).slice(0, 20) : null;
  db.prepare('UPDATE users SET whatsapp_number = ? WHERE id = ?').run(num, target.id);
  res.json({ ok: true, whatsapp_number: num });
});

export default router;
