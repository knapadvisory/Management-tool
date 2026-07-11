// Per-user theming: a light/dark mode plus an accent colour. Applied by
// toggling data-theme on <html> and overriding the --accent variables.

export const ACCENTS = [
  { name: 'Indigo', accent: '#4f46e5', hover: '#4338ca' },
  { name: 'Violet', accent: '#7c3aed', hover: '#6d28d9' },
  { name: 'Aubergine', accent: '#8b34a5', hover: '#722a89' },
  { name: 'Blue', accent: '#2563eb', hover: '#1d4ed8' },
  { name: 'Teal', accent: '#0d9488', hover: '#0f766e' },
  { name: 'Green', accent: '#16a34a', hover: '#15803d' },
  { name: 'Amber', accent: '#d97706', hover: '#b45309' },
  { name: 'Rose', accent: '#e11d48', hover: '#be123c' },
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
}
