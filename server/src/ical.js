// Builds a subscribable iCalendar (RFC 5545) feed of a user's dated work — their
// assigned open tasks and the client compliance deadlines they own. Calendar apps
// (Google, Apple, Outlook) poll the feed URL periodically, so it always reflects
// the latest due dates without any push integration.
import db from './db.js';
import { HOLIDAYS } from './holidays.js';

// Escape a text value for an iCal property (RFC 5545 §3.3.11).
function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold long lines to 75 octets with a leading space on continuations.
function fold(line) {
  if (line.length <= 74) return line;
  const out = [];
  let s = line;
  out.push(s.slice(0, 74));
  s = s.slice(74);
  while (s.length) { out.push(' ' + s.slice(0, 73)); s = s.slice(73); }
  return out.join('\r\n');
}

const dateCompact = (ymd) => String(ymd).slice(0, 10).replace(/-/g, ''); // 2026-08-20 -> 20260820
const nextDay = (ymd) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

// A timed VEVENT (UTC). start/end are 'YYYY-MM-DD HH:MM:SS' UTC strings.
const utcStamp = (s) => String(s).replace(' ', 'T').replace(/-/g, '').replace(/:/g, '').slice(0, 15) + 'Z';
function veventTimed({ uid, start, end, summary, description, category, alarmMin }, stamp) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${utcStamp(start)}`,
    end ? `DTEND:${utcStamp(end)}` : null,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    `CATEGORIES:${category}`,
    'STATUS:CONFIRMED',
    alarmMin != null ? 'BEGIN:VALARM' : null,
    alarmMin != null ? 'ACTION:DISPLAY' : null,
    alarmMin != null ? `DESCRIPTION:${esc(summary)}` : null,
    alarmMin != null ? `TRIGGER:-PT${alarmMin}M` : null,
    alarmMin != null ? 'END:VALARM' : null,
    'END:VEVENT',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n');
}

function vevent({ uid, date, summary, description, category }, stamp) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateCompact(date)}`,
    `DTEND;VALUE=DATE:${nextDay(date)}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    `CATEGORIES:${category}`,
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
    // Remind the day before, in the morning.
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(summary)}`, 'TRIGGER:-P1D', 'END:VALARM',
    'END:VEVENT',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n');
}

// The user's open, dated tasks + the compliance deadlines assigned to them.
export function buildUserCalendar(user) {
  const ws = user.workspace_id;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15) + 'Z';

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.description, t.due_date, s.name AS stage
    FROM tasks t LEFT JOIN workflow_stages s ON s.id = t.stage_id
    WHERE t.workspace_id = ? AND t.archived_at IS NULL AND t.status NOT IN ('completed','cancelled')
      AND t.due_date IS NOT NULL AND t.due_date != ''
      AND (t.assignee_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?))
    ORDER BY t.due_date
  `).all(ws, user.id, user.id);

  const deadlines = db.prepare(`
    SELECT d.id, d.title, d.due_date, c.name AS client_name
    FROM client_deadlines d JOIN clients c ON c.id = d.client_id
    WHERE c.workspace_id = ? AND d.completed = 0 AND d.assignee_id = ?
      AND d.due_date IS NOT NULL AND d.due_date != ''
    ORDER BY d.due_date
  `).all(ws, user.id);

  // Scheduled meetings the user hosts or is invited to.
  const meetings = db.prepare(`
    SELECT DISTINCT m.id, m.title, m.description, m.scheduled_at, m.duration_min, m.call_type
    FROM meetings m LEFT JOIN meeting_invitees mi ON mi.meeting_id = m.id
    WHERE m.workspace_id = ? AND m.status = 'scheduled' AND (m.host_id = ? OR mi.user_id = ?)
    ORDER BY m.scheduled_at
  `).all(ws, user.id, user.id);

  // The user's own calendar events.
  const calEvents = db.prepare('SELECT * FROM calendar_events WHERE user_id = ? ORDER BY starts_at').all(user.id);
  const plusMin = (s, min) => new Date(new Date(s.replace(' ', 'T') + 'Z').getTime() + min * 60000).toISOString().slice(0, 19).replace('T', ' ');

  const events = [
    ...tasks.map((t) => vevent({
      uid: `task-${t.id}@teamhub`,
      date: t.due_date,
      summary: t.title,
      description: [t.description, t.stage ? `Stage: ${t.stage}` : null].filter(Boolean).join('\n'),
      category: 'Task',
    }, stamp)),
    ...deadlines.map((d) => vevent({
      uid: `deadline-${d.id}@teamhub`,
      date: d.due_date,
      summary: `${d.title} — ${d.client_name}`,
      description: `Compliance filing for ${d.client_name}`,
      category: 'Compliance',
    }, stamp)),
    ...meetings.map((m) => veventTimed({
      uid: `meeting-${m.id}@teamhub`,
      start: m.scheduled_at,
      end: plusMin(m.scheduled_at, m.duration_min || 30),
      summary: `${m.call_type === 'audio' ? '📞' : '🎥'} ${m.title}`,
      description: m.description || 'TeamHub meeting',
      category: 'Meeting',
      alarmMin: 10,
    }, stamp)),
    ...HOLIDAYS.map((h) => vevent({
      uid: `holiday-${h.date}-${h.name.replace(/[^a-z0-9]/gi, '')}@teamhub`,
      date: h.date,
      summary: `${h.type === 'festival' ? '🎉' : '🇮🇳'} ${h.name}`,
      description: h.type === 'national' ? 'National holiday' : h.type === 'gazetted' ? 'Gazetted holiday' : 'Festival',
      category: 'Holiday',
    }, stamp)),
    ...calEvents.map((e) => (e.all_day
      ? vevent({ uid: `cal-${e.id}@teamhub`, date: e.starts_at.slice(0, 10), summary: e.title, description: e.notes, category: 'Personal' }, stamp)
      : veventTimed({
        uid: `cal-${e.id}@teamhub`,
        start: e.starts_at,
        end: e.ends_at || plusMin(e.starts_at, 30),
        summary: e.title,
        description: e.notes,
        category: 'Personal',
        alarmMin: e.remind_min != null ? e.remind_min : null,
      }, stamp))),
  ];

  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KNAP Advisory//TeamHub//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:TeamHub — ${esc(user.name)}`),
    'X-WR-TIMEZONE:Asia/Kolkata',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  return [...header, ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
