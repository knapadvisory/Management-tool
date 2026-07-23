// Per-user theming: a light/dark mode plus an accent colour. Applied by
// toggling data-theme on <html> and overriding the --accent variables.

// Each theme carries an accent (buttons, links, highlights) AND a deep
// sidebar colour, so picking one recolours the whole app (Slack-style).
export const ACCENTS = [
  { name: 'Indigo', accent: '#4f46e5', hover: '#4338ca', sidebar: '#1e1b4b' },
  { name: 'Violet', accent: '#7c3aed', hover: '#6d28d9', sidebar: '#2e1065' },
  { name: 'Aubergine', accent: '#a53692', hover: '#8a2a7a', sidebar: '#3f0e40' },
  { name: 'Blue', accent: '#2563eb', hover: '#1d4ed8', sidebar: '#0f2544' },
  { name: 'Teal', accent: '#0d9488', hover: '#0f766e', sidebar: '#062f2b' },
  { name: 'Green', accent: '#16a34a', hover: '#15803d', sidebar: '#08341e' },
  { name: 'Amber', accent: '#d97706', hover: '#b45309', sidebar: '#3a2408' },
  { name: 'Rose', accent: '#e11d48', hover: '#be123c', sidebar: '#4a0f22' },
  { name: 'Clementine', accent: '#e8590c', hover: '#c2410c', sidebar: '#3a1c06' },
  { name: 'Jade', accent: '#0f9d76', hover: '#0b7a5c', sidebar: '#06342a' },
  { name: 'Lagoon', accent: '#0e7490', hover: '#155e75', sidebar: '#07293a' },
  { name: 'Mood Indigo', accent: '#3730a3', hover: '#312e81', sidebar: '#191540' },
  { name: 'Barbra', accent: '#db2777', hover: '#be185d', sidebar: '#420f2b' },
  { name: 'Graphite', accent: '#4b5563', hover: '#374151', sidebar: '#171a21' },
  { name: 'Slate', accent: '#475569', hover: '#334155', sidebar: '#1a1d29' },
];

export const MODES = ['light', 'dark', 'system'];
const KEY = 'teamhub_theme';

export function loadLocalTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { mode: MODES.includes(t.mode) ? t.mode : 'light', accent: t.accent || ACCENTS[0].accent };
  } catch { return { mode: 'light', accent: ACCENTS[0].accent }; }
}

export function saveLocalTheme(theme) {
  try { localStorage.setItem(KEY, JSON.stringify(theme)); } catch { /* ignore */ }
}

export function applyTheme({ mode = 'light', accent } = {}) {
  const root = document.documentElement;
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  const a = ACCENTS.find((x) => x.accent.toLowerCase() === String(accent).toLowerCase()) || ACCENTS[0];
  root.style.setProperty('--accent', a.accent);
  root.style.setProperty('--accent-hover', a.hover);
  root.style.setProperty('--sidebar-bg', a.sidebar);
}
