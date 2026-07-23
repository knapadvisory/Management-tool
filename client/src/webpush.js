import { api } from './api.js';

// Browser Web Push registration. Registers the service worker, asks permission,
// subscribes with the server's VAPID public key, and stores the subscription.
// No-op on unsupported browsers or when the user declines. Native (Capacitor)
// builds use FCM instead and skip this.

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

// Call after login. Returns true if a subscription is active.
export async function initWebPush() {
  try {
    if (!supported()) return false;
    // A Capacitor native shell handles push via FCM — don't double-register.
    if (window.Capacitor?.isNativePlatform?.()) return false;

    const { public_key } = await api('/push/vapid').catch(() => ({}));
    if (!public_key) return false;

    if (Notification.permission === 'denied') return false;
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
    }

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key),
      });
    }
    await api('/push/web/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    return true;
  } catch {
    return false;
  }
}

// Ask for permission explicitly (e.g. from a Settings toggle), then subscribe.
export async function enableWebPush() {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: perm };
  const ok = await initWebPush();
  return { ok, reason: ok ? 'granted' : 'failed' };
}
