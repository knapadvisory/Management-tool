import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';

// Renders a persistent, non-dismissible banner whenever the signed-in user has
// location sharing ON, and posts their current position every couple of minutes
// while the app is open. The banner is the transparency guarantee — a person is
// always shown, in plain sight, that their location is being shared and who can
// see it, with a one-tap way to stop. Sharing is only ever on because the user
// opted in (Settings → Location); this component never enables it.
export default function LocationSharing() {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const refresh = useCallback(() => {
    api('/location/me').then((d) => setSharing(!!d.location_sharing)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener('location-consent-changed', onChange);
    return () => window.removeEventListener('location-consent-changed', onChange);
  }, [refresh]);

  const postNow = useCallback(() => {
    if (!navigator.geolocation) { setError('this device has no location'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setError(null);
        api('/location', { method: 'POST', body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }).catch(() => {});
      },
      (err) => setError(err.code === 1 ? 'permission denied' : 'location unavailable'),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  }, []);

  useEffect(() => {
    clearInterval(timer.current);
    if (!sharing) return undefined;
    postNow();
    timer.current = setInterval(postNow, 120000); // every 2 min, only while the app is open
    return () => clearInterval(timer.current);
  }, [sharing, postNow]);

  async function stop() {
    try { await api('/location/consent', { method: 'POST', body: { enabled: false } }); }
    finally { setSharing(false); window.dispatchEvent(new Event('location-consent-changed')); }
  }

  if (!sharing) return null;
  return (
    <div className="location-banner" role="status" aria-live="polite">
      <span aria-hidden>📍</span>
      <span>Location sharing is <strong>on</strong> — your workspace admins can see your current location{error ? ` (${error})` : ''}.</span>
      <button type="button" className="location-banner-stop" onClick={stop}>Stop sharing</button>
    </div>
  );
}
