import crypto from 'crypto';
import webpush from 'web-push';
import db, { getSetting, setSetting } from './db.js';

/**
 * Mobile push via Firebase Cloud Messaging (HTTP v1). Configured from a service
 * account through three env vars (from the Firebase service-account JSON):
 *   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
 * When they're absent, every call is a graceful no-op — nothing breaks, push is
 * simply off (same pattern as email). No third-party SDKs; just crypto + fetch.
 */
// Most reliable option: the whole service-account JSON in one (optionally
// base64) env var — no newline-escaping pitfalls at all.
function serviceAccount() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT || process.env.FCM_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (!raw) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return tryParse(raw) || tryParse(Buffer.from(raw, 'base64').toString('utf8'));
}
const SA = serviceAccount();

const PROJECT_ID = () => (SA?.project_id || process.env.FCM_PROJECT_ID || '').trim();
const CLIENT_EMAIL = () => (SA?.client_email || process.env.FCM_CLIENT_EMAIL || '').trim();
// A pasted key often arrives with escaped newlines ("\n" or even "\\n") or
// surrounding quotes; normalize to a real PEM. The JSON path already has real
// newlines, so the replaces are no-ops there.
const PRIVATE_KEY = () => {
  let k = (SA?.private_key || process.env.FCM_PRIVATE_KEY || '').trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\+r/g, '').replace(/\\+n/g, '\n').trim();
};

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
  const errText = await res.text().catch(() => '');
  console.log(`[push] FCM send failed: ${res.status} ${errText.slice(0, 300)}`);
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
export function sendPushToUser(userId, payload) {
  sendFcmToUser(userId, payload);
  sendWebPushToUser(userId, payload);
}

function sendFcmToUser(userId, { title, body, data = {} }) {
  if (!pushEnabled() || !userId) return;
  const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId).map((r) => r.token);
  console.log(`[push] FCM → user ${userId}: ${tokens.length} device token(s)`);
  if (!tokens.length) return;
  const stringData = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const message = {
    notification: { title, body },
    data: stringData,
    android: { priority: 'high', notification: { sound: 'default' } },
  };
  (async () => {
    for (const token of tokens) {
      try {
        const r = await sendToToken(token, message);
        console.log(`[push] FCM → ${token.slice(0, 10)}… ${r.ok ? 'OK' : 'FAILED (' + r.status + ')'}`);
      } catch (e) { console.log('[push] FCM send error:', e?.message || e); }
    }
  })();
}

// --- Browser Web Push (VAPID) ---------------------------------------------
// VAPID keys are read from env, else generated once and persisted in settings,
// so browser push works out of the box (no manual key setup) while still being
// overridable via WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY.
let vapid = null;
function getVapid() {
  if (vapid) return vapid;
  let pub = (process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  let priv = (process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
  if (!pub || !priv) {
    pub = getSetting('vapid_public_key');
    priv = getSetting('vapid_private_key');
  }
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    setSetting('vapid_public_key', pub);
    setSetting('vapid_private_key', priv);
  }
  const subject = (process.env.WEB_PUSH_SUBJECT || 'mailto:admin@teamhub.local').trim();
  webpush.setVapidDetails(subject, pub, priv);
  vapid = { publicKey: pub, privateKey: priv };
  return vapid;
}

export function getVapidPublicKey() {
  try { return getVapid().publicKey; } catch { return ''; }
}

export function registerWebPush(userId, sub) {
  if (!userId || !sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return;
  db.prepare(`
    INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth);
}

export function unregisterWebPush(userId, endpoint) {
  db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

function sendWebPushToUser(userId, { title, body, data = {} }) {
  if (!userId) return;
  const rows = db.prepare('SELECT endpoint, p256dh, auth FROM web_push_subscriptions WHERE user_id = ?').all(userId);
  if (!rows.length) return;
  getVapid();
  const json = JSON.stringify({ title: title || 'TeamHub', body: body || '', data });
  (async () => {
    for (const r of rows) {
      const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      try {
        await webpush.sendNotification(subscription, json);
      } catch (err) {
        // 404/410 = the browser dropped the subscription — prune it.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint = ?').run(r.endpoint);
        }
      }
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
