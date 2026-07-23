// Format minutes as "2h 15m" / "45m" / "0m".
export function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h && mm) return `${h}h ${mm}m`;
  if (h) return `${h}h`;
  return `${mm}m`;
}

// Live "HH:MM:SS" from a running entry's started_at (a UTC SQL datetime).
export function elapsedClock(startedAt) {
  if (!startedAt) return '00:00';
  const start = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
  let s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Tiny event bus so the header timer refreshes when time is logged anywhere.
export const emitTimeChanged = () => window.dispatchEvent(new Event('time:changed'));
export function onTimeChanged(cb) {
  window.addEventListener('time:changed', cb);
  return () => window.removeEventListener('time:changed', cb);
}
