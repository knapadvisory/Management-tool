import { Router } from 'express';
import { registerToken, unregisterToken, pushEnabled } from '../push.js';

const router = Router();

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
