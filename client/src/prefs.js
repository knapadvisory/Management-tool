// Client-side user preferences (Messages & media, Accessibility, Language &
// region). Stored in localStorage and applied to <html> via data-attributes so
// CSS can react. Time-format helpers read `clock24` live.

const KEY = 'teamhub_prefs';
const DEFAULTS = {
  density: 'comfortable',   // 'comfortable' | 'compact'
  clock24: false,           // 24-hour clock
  showTyping: true,         // show "X is typing…"
  underlineLinks: false,    // underline links in messages
  reduceMotion: false,      // disable transitions/animations
  spellcheck: true,         // browser spellcheck in the composer
  enterToSend: true,        // Enter sends (vs. Enter = newline, Ctrl+Enter sends)
  locale: 'auto',           // date/number formatting locale ('auto' = device)
  timezone: 'auto',         // IANA time zone for displayed times ('auto' = device)
};

let cache = null;

export function getPrefs() {
  if (!cache) {
    try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { cache = { ...DEFAULTS }; }
  }
  return cache;
}

export function setPref(key, value) {
  const p = getPrefs();
  p[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
  applyPrefs();
}

// Reflect prefs onto <html> so the stylesheet can respond.
export function applyPrefs() {
  const p = getPrefs();
  const r = document.documentElement;
  r.setAttribute('data-density', p.density);
  r.setAttribute('data-underline-links', p.underlineLinks ? 'on' : 'off');
  r.setAttribute('data-reduce-motion', p.reduceMotion ? 'on' : 'off');
}

export const clock24 = () => getPrefs().clock24;
// Locale for toLocale* (undefined = device default). Time zone likewise.
export const localeArg = () => { const l = getPrefs().locale; return l && l !== 'auto' ? l : undefined; };
export const timeZoneArg = () => { const z = getPrefs().timezone; return z && z !== 'auto' ? z : undefined; };
// Shared options object for date/time formatting that respects all three prefs.
export function dateOpts(extra = {}) {
  const o = { ...extra, hour12: !clock24() };
  const z = timeZoneArg();
  if (z) o.timeZone = z;
  return o;
}
