// Per-conversation message drafts. A half-typed message survives leaving and
// returning to a chat (like WhatsApp), and — because it's kept in localStorage
// — also survives an app reload. Keyed by channel id; stores the composer's
// rich HTML so formatting is preserved.
const KEY = 'teamhub_drafts';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function persist(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* storage full / disabled */ }
}

export function getDraft(channelId) {
  return load()[channelId] || '';
}

export function setDraft(channelId, html) {
  if (channelId == null) return;
  const map = load();
  const text = (html || '').replace(/<[^>]*>/g, '').replace(/​|&nbsp;/g, '').trim();
  if (text) map[channelId] = html; else delete map[channelId];
  persist(map);
}

export function clearDraft(channelId) {
  const map = load();
  if (map[channelId] != null) { delete map[channelId]; persist(map); }
}
