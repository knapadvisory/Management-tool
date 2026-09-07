// Expand recurring calendar events into concrete occurrences.
export const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];

const toDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const toStore = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// Advance a UTC store-string by one interval of the given recurrence.
export function stepStart(startStr, recurrence, n = 1) {
  const d = toDate(startStr);
  if (recurrence === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  else return null;
  return toStore(d);
}

// Occurrence start strings within [fromYMD, toYMD] (inclusive, by date part),
// honouring repeat_until. Non-recurring events return their single start if in
// range. Capped so a runaway rule can't loop forever.
export function occurrencesInRange(ev, fromYMD, toYMD) {
  const lo = String(fromYMD).slice(0, 10);
  const hi = String(toYMD).slice(0, 10);
  const until = ev.repeat_until ? String(ev.repeat_until).slice(0, 10) : null;
  if (!ev.recurrence || ev.recurrence === 'none') {
    const day = String(ev.starts_at).slice(0, 10);
    return day >= lo && day <= hi ? [ev.starts_at] : [];
  }
  const out = [];
  let cur = ev.starts_at;
  for (let i = 0; i < 1000; i++) {
    const day = String(cur).slice(0, 10);
    if (day > hi) break;
    if (until && day > until) break;
    if (day >= lo) out.push(cur);
    const next = stepStart(cur, ev.recurrence);
    if (!next) break;
    cur = next;
  }
  return out;
}

// The next occurrence start (Date) at or after `afterMs`, or null.
export function nextOccurrence(ev, afterMs) {
  if (!ev.recurrence || ev.recurrence === 'none') {
    const d = toDate(ev.starts_at);
    return d.getTime() >= afterMs ? d : null;
  }
  const untilMs = ev.repeat_until ? toDate(String(ev.repeat_until).slice(0, 10) + ' 23:59:59').getTime() : Infinity;
  let cur = ev.starts_at;
  for (let i = 0; i < 4000; i++) {
    const d = toDate(cur);
    if (d.getTime() > untilMs) return null;
    if (d.getTime() >= afterMs) return d;
    const next = stepStart(cur, ev.recurrence);
    if (!next) return null;
    cur = next;
  }
  return null;
}
