// Personal calendar events (reminders / blocks). Private to the owner. The
// Calendar view merges these with the user's meetings and task due-dates.
import { Router } from 'express';
import db from '../db.js';

const router = Router();
// Accept an ISO datetime or a plain YYYY-MM-DD (all-day) → UTC store string.
const toStore = (v, allDay) => {
  if (!v) return null;
  if (allDay) return String(v).slice(0, 10) + ' 00:00:00';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
};
const own = (req) => db.prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

// Events overlapping [from, to] (inclusive), defaulting to a wide window.
router.get('/', (req, res) => {
  const from = String(req.query.from || '2000-01-01').slice(0, 10) + ' 00:00:00';
  const to = String(req.query.to || '2100-01-01').slice(0, 10) + ' 23:59:59';
  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE user_id = ? AND starts_at <= ? AND COALESCE(ends_at, starts_at) >= ?
    ORDER BY starts_at
  `).all(req.user.id, to, from);
  res.json({ events });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'A title is required' });
  const allDay = b.all_day ? 1 : 0;
  const starts = toStore(b.starts_at, allDay);
  if (!starts) return res.status(400).json({ error: 'A valid start time is required' });
  const ends = b.ends_at ? toStore(b.ends_at, allDay) : null;
  const remind = b.remind_min === '' || b.remind_min == null ? null : Math.max(0, Math.min(10080, parseInt(b.remind_min, 10) || 0));
  const info = db.prepare(`
    INSERT INTO calendar_events (workspace_id, user_id, title, starts_at, ends_at, all_day, notes, color, remind_min)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.workspaceId, req.user.id, title, starts, ends, allDay, String(b.notes || '').slice(0, 4000), String(b.color || '').slice(0, 20), remind);
  res.status(201).json({ event: db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/:id', (req, res) => {
  const ev = own(req);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const allDay = b.all_day !== undefined ? (b.all_day ? 1 : 0) : ev.all_day;
  const sets = []; const vals = [];
  if (b.title !== undefined) { sets.push('title = ?'); vals.push(String(b.title).trim().slice(0, 200)); }
  if (b.all_day !== undefined) { sets.push('all_day = ?'); vals.push(allDay); }
  if (b.starts_at !== undefined) {
    const s = toStore(b.starts_at, allDay);
    if (!s) return res.status(400).json({ error: 'A valid start time is required' });
    sets.push('starts_at = ?', 'reminded = 0'); vals.push(s);
  }
  if (b.ends_at !== undefined) { sets.push('ends_at = ?'); vals.push(b.ends_at ? toStore(b.ends_at, allDay) : null); }
  if (b.notes !== undefined) { sets.push('notes = ?'); vals.push(String(b.notes).slice(0, 4000)); }
  if (b.color !== undefined) { sets.push('color = ?'); vals.push(String(b.color).slice(0, 20)); }
  if (b.remind_min !== undefined) { sets.push('remind_min = ?', 'reminded = 0'); vals.push(b.remind_min === '' || b.remind_min == null ? null : Math.max(0, Math.min(10080, parseInt(b.remind_min, 10) || 0))); }
  if (sets.length) db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ev.id);
  res.json({ event: db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(ev.id) });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

export default router;
