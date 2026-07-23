// Lightweight natural-language parser for the quick-add task field.
// Extracts priority (!high), tags (#kyc) and a due date from free text,
// returning the cleaned title plus whatever it found. Everything it pulls
// out is shown as a preview and stays fully editable in the form.

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const PRIORITIES = { low: 'low', medium: 'medium', med: 'medium', high: 'high', urgent: 'urgent' };

function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Try to find a due date in the text. Returns { ymd, match } or null.
function findDate(text) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ISO date: 2026-07-20
  let m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) return { ymd: m[1], match: m[0] };

  // "in 3 days" / "in 2 weeks"
  m = text.match(/\bin\s+(\d{1,3})\s+(day|days|week|weeks)\b/i);
  if (m) {
    const n = Number(m[1]) * (/week/i.test(m[2]) ? 7 : 1);
    const d = new Date(today); d.setDate(d.getDate() + n);
    return { ymd: toYMD(d), match: m[0] };
  }

  // "today" / "tonight" / "tomorrow"
  m = text.match(/\b(today|tonight|tomorrow|tmrw)\b/i);
  if (m) {
    const d = new Date(today);
    if (/tomorrow|tmrw/i.test(m[1])) d.setDate(d.getDate() + 1);
    return { ymd: toYMD(d), match: m[0] };
  }

  // "next week"
  m = text.match(/\bnext\s+week\b/i);
  if (m) { const d = new Date(today); d.setDate(d.getDate() + 7); return { ymd: toYMD(d), match: m[0] }; }

  // "jul 20" / "20 jul" / "july 20th"
  m = text.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const d = monthDay(today, MONTHS[m[1].toLowerCase()], Number(m[2]));
    if (d) return { ymd: toYMD(d), match: m[0] };
  }
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const d = monthDay(today, MONTHS[m[2].toLowerCase()], Number(m[1]));
    if (d) return { ymd: toYMD(d), match: m[0] };
  }

  // weekday name → next upcoming (or today if it matches); "next mon" → the week after
  const wdRe = /\b(next\s+)?([a-z]{3,9})\b/gi;
  let wm;
  while ((wm = wdRe.exec(text)) !== null) {
    const target = WEEKDAYS[wm[2].toLowerCase()];
    if (target === undefined) continue;
    const baseOffset = (target - today.getDay() + 7) % 7;
    const offset = baseOffset + (wm[1] ? 7 : 0);
    const d = new Date(today); d.setDate(d.getDate() + offset);
    return { ymd: toYMD(d), match: wm[0] };
  }
  return null;
}

function monthDay(today, monthIdx, day) {
  if (day < 1 || day > 31) return null;
  let year = today.getFullYear();
  let d = new Date(year, monthIdx, day);
  if (d < today) d = new Date(year + 1, monthIdx, day); // roll to next year if already past
  return d;
}

export function parseQuickAdd(raw) {
  let text = ` ${raw} `;
  const tags = [];
  let priority = null;

  // Priority: !high, !urgent, ...
  text = text.replace(/(^|\s)!([a-z]+)/gi, (full, pre, word) => {
    const p = PRIORITIES[word.toLowerCase()];
    if (p) { priority = p; return pre; }
    return full;
  });

  // Tags: #kyc, #q3
  text = text.replace(/(^|\s)#([a-z0-9][a-z0-9-]*)/gi, (full, pre, tag) => {
    const clean = tag.toLowerCase();
    if (!tags.includes(clean)) tags.push(clean);
    return pre;
  });

  // Date phrase (strip the first one we recognize).
  const date = findDate(text);
  if (date) text = text.replace(date.match, ' ');

  const title = text.replace(/\s+/g, ' ').trim();
  return { title, priority, tags, due_date: date ? date.ymd : null };
}
