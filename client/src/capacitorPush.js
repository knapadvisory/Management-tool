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

  // Notification channels (sound, vibration, LED, and the call ringtone) are
  // created natively in MainActivity — deliberately NOT here. The Capacitor
  // createChannel API can't set a ringtone sound, and a channel's sound is
  // frozen once created, so letting JS create them first would lock the calls
  // channel to a plain notification tone. Native ownership keeps it a ringtone.

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
