// Per-user theming: a light/dark mode plus an accent colour. Applied by
// toggling data-theme on <html> and overriding the --accent variables.

// Each theme carries an accent (buttons, links, highlights) AND a deep
// sidebar colour, so picking one recolours the whole app (Slack-style).
//
// The set is deliberately restrained — this is a professional-services tool, so
// the palette stays in sober blues, indigos, teals and greys rather than loud
// pinks/oranges. The first entry (Indigo) is the default; it also matches the
// server-side default accent (#4f46e5). Any account still carrying an accent
// that was removed here falls back to this default automatically (see
// applyTheme), so retiring the louder colours quietly resets those users too.
export const ACCENTS = [
  { name: 'Indigo', accent: '#4f46e5', hover: '#4338ca', sidebar: '#1e1b4b' },
  { name: 'Blue', accent: '#2563eb', hover: '#1d4ed8', sidebar: '#0f2544' },
  { name: 'Mood Indigo', accent: '#3730a3', hover: '#312e81', sidebar: '#191540' },
  { name: 'Violet', accent: '#7c3aed', hover: '#6d28d9', sidebar: '#2e1065' },
  { name: 'Teal', accent: '#0d9488', hover: '#0f766e', sidebar: '#062f2b' },
  { name: 'Lagoon', accent: '#0e7490', hover: '#155e75', sidebar: '#07293a' },
  { name: 'Slate', accent: '#475569', hover: '#334155', sidebar: '#1a1d29' },
  { name: 'Graphite', accent: '#4b5563', hover: '#374151', sidebar: '#171a21' },
];

export const MODES = ['light', 'dark', 'system'];

// Visual "skins" — a whole different look, not just an accent. 'original' is the
// default TeamHub palette; 'editorial' is a warm, minimalist, classy look
// (cream paper, muted teal, serif headings) with its own accent + sidebar.
export const SKINS = ['original', 'editorial'];
const EDITORIAL = { accent: '#3f6b74', hover: '#345a62', sidebar: '#211f1b' };

const KEY = 'teamhub_theme';

export function loadLocalTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      mode: MODES.includes(t.mode) ? t.mode : 'light',
      accent: t.accent || ACCENTS[0].accent,
      skin: SKINS.includes(t.skin) ? t.skin : 'original',
    };
  } catch { return { mode: 'light', accent: ACCENTS[0].accent, skin: 'original' }; }
}

export function saveLocalTheme(theme) {
  try { localStorage.setItem(KEY, JSON.stringify(theme)); } catch { /* ignore */ }
}

export function applyTheme({ mode = 'light', accent, skin = 'original' } = {}) {
  const root = document.documentElement;
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  const editorial = skin === 'editorial';
  root.setAttribute('data-skin', editorial ? 'editorial' : 'original');
  // The editorial skin ships its own accent + sidebar so it reads as one
  // cohesive palette; the accent picker only applies to the original skin.
  if (editorial) {
    root.style.setProperty('--accent', EDITORIAL.accent);
    root.style.setProperty('--accent-hover', EDITORIAL.hover);
    root.style.setProperty('--sidebar-bg', EDITORIAL.sidebar);
  } else {
    const a = ACCENTS.find((x) => x.accent.toLowerCase() === String(accent).toLowerCase()) || ACCENTS[0];
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-hover', a.hover);
    root.style.setProperty('--sidebar-bg', a.sidebar);
  }
}
