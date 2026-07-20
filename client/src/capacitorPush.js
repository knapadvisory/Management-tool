import { Capacitor } from '@capacitor/core';
import { api } from './api.js';

// Register the device for FCM push and route notification taps. A no-op in a
// normal browser (only the native Android/iOS app has a device token). Safe to
// call unconditionally after login; returns a cleanup function.
export async function initPush(onOpen) {
  if (!Capacitor?.isNativePlatform?.()) return () => {};

  // Only register for FCM push when the server is actually configured to send
  // it. Calling PushNotifications.register() without Firebase configured throws
  // a native "Default FirebaseApp is not initialized" error that Capacitor
  // re-raises on a background thread — which crashes the whole app. Gating on
  // the server's push_enabled flag avoids that and means push turns on
  // automatically once Firebase/FCM is wired up, with no app change needed.
  try {
    const cfg = await api('/config');
    if (!cfg?.push_enabled) return () => {};
  } catch {
    return () => {}; // can't confirm push is configured — don't risk the crash
  }

  let PushNotifications;
  try {
    ({ PushNotifications } = await import('@capacitor/push-notifications'));
  } catch {
    return () => {}; // plugin not available in this build
  }

  // Android notification channels control sound, vibration and the LED light.
  // Calls get their own high-urgency channel so they stand out from message
  // pings. (No-op on iOS; best-effort.)
  try {
    await PushNotifications.createChannel({
      id: 'teamhub_messages', name: 'Messages & tasks',
      importance: 4, vibration: true, lights: true, lightColor: '#4F46E5', visibility: 1,
    });
    await PushNotifications.createChannel({
      id: 'teamhub_calls', name: 'Calls',
      importance: 5, vibration: true, lights: true, lightColor: '#4F46E5', visibility: 1,
    });
  } catch { /* channels are best-effort (Android only) */ }

  const perm = await PushNotifications.requestPermissions().catch(() => ({ receive: 'denied' }));
  if (perm.receive !== 'granted') return () => {};

  await PushNotifications.register().catch(() => {});

  const handles = [];
  handles.push(await PushNotifications.addListener('registration', (t) => {
    api('/push/register', { method: 'POST', body: { token: t.value, platform: Capacitor.getPlatform() } }).catch(() => {});
  }));
  handles.push(await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const data = action?.notification?.data || {};
    onOpen?.(data);
  }));

  return () => { handles.forEach((h) => h.remove?.()); };
}

// Best-effort: drop this device's token on logout so a shared phone stops
// getting the previous user's alerts.
export async function teardownPush() {
  if (!Capacitor?.isNativePlatform?.()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllListeners();
  } catch { /* ignore */ }
}
