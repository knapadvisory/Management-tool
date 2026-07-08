// Thin wrapper around the browser Web Notifications API. Desktop
// notifications are shown for incoming alerts when the tab is in the
// background, so teammates hear about mentions, assignments, task activity
// and reminders even when TeamHub isn't the focused window.

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'denied';
}

// Ask the user to allow desktop notifications. Must be called from a user
// gesture (e.g. a click). Resolves to the resulting permission string.
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Show a desktop notification. By default it only appears when the tab is
// hidden (in-app toasts cover the foreground). Pass force:true to always show.
export function showDesktopNotification(title, { body, tag, onClick, force = false } = {}) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (!force && document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body, tag });
    if (onClick) {
      n.onclick = () => { window.focus(); n.close(); onClick(); };
    }
    // Auto-dismiss so alerts don't pile up on the desktop.
    setTimeout(() => n.close(), 8000);
  } catch {
    /* some browsers throw if constructed without a service worker; ignore */
  }
}
