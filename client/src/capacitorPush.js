import { Capacitor } from '@capacitor/core';
import { api } from './api.js';

// Register the device for FCM push and route notification taps. A no-op in a
// normal browser (only the native Android/iOS app has a device token). Safe to
// call unconditionally after login; returns a cleanup function.
export async function initPush(onOpen) {
  if (!Capacitor?.isNativePlatform?.()) return () => {};

  let PushNotifications;
  try {
    ({ PushNotifications } = await import('@capacitor/push-notifications'));
  } catch {
    return () => {}; // plugin not available in this build
  }

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
