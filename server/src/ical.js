// Builds a subscribable iCalendar (RFC 5545) feed of a user's dated work — their
// assigned open tasks and the client compliance deadlines they own. Calendar apps
// (Google, Apple, Outlook) poll the feed URL periodically, so it always reflects
// the latest due dates without any push integration.
import db from './db.js';

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
