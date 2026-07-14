import crypto from 'crypto';
import db from './db.js';

/**
 * Mobile push via Firebase Cloud Messaging (HTTP v1). Configured from a service
 * account through three env vars (from the Firebase service-account JSON):
 *   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
 * When they're absent, every call is a graceful no-op — nothing breaks, push is
 * simply off (same pattern as email). No third-party SDKs; just crypto + fetch.
 */
const PROJECT_ID = () => (process.env.FCM_PROJECT_ID || '').trim();
const CLIENT_EMAIL = () => (process.env.FCM_CLIENT_EMAIL || '').trim();
// A service-account key often arrives with literal "\n"; normalize to newlines.
const PRIVATE_KEY = () => (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

export function pushEnabled() {
  return !!(PROJECT_ID() && CLIENT_EMAIL() && PRIVATE_KEY());
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Cache the OAuth access token until shortly before it expires.
let cachedToken = null;
let cachedExp = 0;

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExp - 60) return cachedToken;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: CLIENT_EMAIL(),
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(PRIVATE_KEY()));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'FCM token exchange failed');
  cachedToken = data.access_token;
  cachedExp = now + (data.expires_in || 3600);
  return cachedToken;
}

async function sendToToken(token, message) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID()}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { ...message, token } }),
  });
  if (res.ok) return { ok: true };
  // A 404/UNREGISTERED means the device token is dead — prune it.
  if (res.status === 404 || res.status === 400) {
    db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }
  return { ok: false, status: res.status };
}

/**
 * Fire a push to all of a user's registered devices. Fire-and-forget; never
 * throws. `data` values must be strings (FCM requirement) so taps can route.
 */
export function sendPushToUser(userId, { title, body, data = {} }) {
  if (!pushEnabled() || !userId) return;
  const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId).map((r) => r.token);
  if (!tokens.length) return;
  const stringData = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const message = {
    notification: { title, body },
    data: stringData,
    android: { priority: 'high', notification: { sound: 'default' } },
  };
  (async () => {
    for (const token of tokens) {
      try { await sendToToken(token, message); } catch { /* offline / transient — skip */ }
    }
  })();
}

export function registerToken(userId, token, platform = 'android') {
  if (!token) return;
  db.prepare(`
    INSERT INTO push_tokens (token, user_id, platform) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform
  `).run(token, userId, platform);
}

export function unregisterToken(userId, token) {
  db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(token, userId);
}
