import { Router } from 'express';
import { registerToken, unregisterToken, pushEnabled, registerWebPush, unregisterWebPush, getVapidPublicKey } from '../push.js';

const router = Router();

// Browser Web Push: the frontend subscribes here after asking permission.
router.get('/vapid', (req, res) => {
  res.json({ public_key: getVapidPublicKey() });
});
router.post('/web/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'A push subscription is required' });
  registerWebPush(req.user.id, sub);
  res.json({ ok: true });
});
router.post('/web/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) unregisterWebPush(req.user.id, String(endpoint));
  res.json({ ok: true });
});

// The mobile app registers its FCM device token here after login.
router.post('/register', (req, res) => {
  const { token, platform = 'android' } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'A device token is required' });
  registerToken(req.user.id, token.trim(), platform === 'ios' ? 'ios' : 'android');
  res.json({ ok: true, push_enabled: pushEnabled() });
});

// Drop a token (on logout / when push is turned off).
router.post('/unregister', (req, res) => {
  const { token } = req.body || {};
  if (token) unregisterToken(req.user.id, String(token).trim());
  res.json({ ok: true });
});

export default router;
