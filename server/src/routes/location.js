// Consent-based location sharing. A user explicitly opts in; only then is any
// position accepted or stored, and only the latest one is kept. Turning sharing
// off immediately forgets the stored location. Admins can see who is *currently*
// sharing (see routes/admin.js) — never a covert capability: the app shows a
// persistent "you are sharing" indicator the whole time it's on.
import { Router } from 'express';
import db from '../db.js';

const router = Router();

/** Opt in or out. Opting out erases the last stored position. */
router.post('/consent', (req, res) => {
  const enabled = !!req.body?.enabled;
  db.prepare('UPDATE users SET location_sharing = ?, location_consent_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, enabled ? new Date().toISOString() : null, req.user.id);
  if (!enabled) db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(req.user.id);
  res.json({ location_sharing: enabled });
});

/** The app posts the current position — refused unless the user is sharing. */
router.post('/', (req, res) => {
  const u = db.prepare('SELECT location_sharing FROM users WHERE id = ?').get(req.user.id);
  if (!u || !u.location_sharing) return res.status(403).json({ error: 'Location sharing is off' });

  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = req.body?.accuracy != null ? Number(req.body.accuracy) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  db.prepare(`
    INSERT INTO user_locations (user_id, lat, lng, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, recorded_at = excluded.recorded_at
  `).run(req.user.id, lat, lng, Number.isFinite(accuracy) ? accuracy : null, new Date().toISOString());

  res.json({ ok: true });
});

/** The user's own sharing status + last stored position. */
router.get('/me', (req, res) => {
  const u = db.prepare('SELECT location_sharing, location_consent_at FROM users WHERE id = ?').get(req.user.id);
  const last = db.prepare('SELECT lat, lng, accuracy, recorded_at FROM user_locations WHERE user_id = ?').get(req.user.id);
  res.json({ location_sharing: !!u?.location_sharing, consent_at: u?.location_consent_at || null, last: last || null });
});

export default router;
