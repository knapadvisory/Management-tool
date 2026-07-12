// Locale options for date/number formatting (the UI text stays English for
// now; picking one changes how dates, times and numbers are formatted).
export const LANGUAGES = [
  { code: 'auto', name: 'Automatic (device)' },
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'hi', name: 'Hindi — हिन्दी' },
  { code: 'bn', name: 'Bengali — বাংলা' },
  { code: 'ta', name: 'Tamil — தமிழ்' },
  { code: 'es', name: 'Spanish — Español' },
  { code: 'fr', name: 'French — Français' },
  { code: 'de', name: 'German — Deutsch' },
  { code: 'pt-BR', name: 'Portuguese — Português' },
  { code: 'it', name: 'Italian — Italiano' },
  { code: 'nl', name: 'Dutch — Nederlands' },
  { code: 'ru', name: 'Russian — Русский' },
  { code: 'tr', name: 'Turkish — Türkçe' },
  { code: 'pl', name: 'Polish — Polski' },
  { code: 'ar', name: 'Arabic — العربية' },
  { code: 'zh-CN', name: 'Chinese (Simplified) — 简体中文' },
  { code: 'ja', name: 'Japanese — 日本語' },
  { code: 'ko', name: 'Korean — 한국어' },
  { code: 'id', name: 'Indonesian — Bahasa Indonesia' },
  { code: 'vi', name: 'Vietnamese — Tiếng Việt' },
];

// A curated fallback in case Intl.supportedValuesOf isn't available.
const FALLBACK_ZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

export function timeZones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch { /* fall through */ }
  return FALLBACK_ZONES;
}
