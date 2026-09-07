import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';

const parseUTC = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const pad = (n) => String(n).padStart(2, '0');
const localYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hhmm = (s) => parseUTC(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const REMIND = [['', 'No reminder'], ['0', 'At start time'], ['5', '5 min before'], ['10', '10 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['1440', '1 day before']];
const REPEAT = [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
const sundayOf = (d) => { const s = new Date(d); s.setDate(d.getDate() - d.getDay()); s.setHours(0, 0, 0, 0); return s; };

export default function CalendarView({ user, onOpenMeetings }) {
  const [mode, setMode] = useState('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [editing, setEditing] = useState(null); // event | { date } | null

  // Visible days: a 6-week month grid, or a single Sunday-based week.
  let gridStart, days;
  if (mode === 'week') {
    gridStart = sundayOf(cursor);
    days = Array.from({ length: 7 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  } else {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    gridStart = sundayOf(first);
    days = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  }
  const gridEnd = days[days.length - 1];

  const load = useCallback(() => {
    api(`/calendar-events?from=${localYMD(gridStart)}&to=${localYMD(gridEnd)}`).then((d) => { setEvents(d.events || []); setHolidays(d.holidays || []); }).catch(() => {});
    api('/meetings').then((d) => setMeetings(d.meetings || [])).catch(() => {});
  }, [gridStart.getTime(), gridEnd.getTime()]);
  useEffect(() => {
    load();
    const s = getSocket();
    s?.on('calendar:changed', load); s?.on('meetings:changed', load);
    return () => { s?.off('calendar:changed', load); s?.off('meetings:changed', load); };
  }, [load]);

  const evKey = (e) => (e.all_day ? e.starts_at.slice(0, 10) : localYMD(parseUTC(e.starts_at)));
  const byDay = {};
  for (const h of holidays) (byDay[h.date] ||= []).push({ kind: 'holiday', ...h });
  for (const e of events) (byDay[evKey(e)] ||= []).push({ kind: 'event', ...e });
  for (const m of meetings) (byDay[localYMD(parseUTC(m.scheduled_at))] ||= []).push({ kind: 'meeting', ...m });
  const timeKey = (it) => (it.kind === 'holiday' || it.all_day) ? '' : (it.starts_at || it.scheduled_at || '');
  for (const k in byDay) byDay[k].sort((a, b) => timeKey(a).localeCompare(timeKey(b)));

  const todayKey = localYMD(new Date());
  const shift = (n) => { const d = new Date(cursor); if (mode === 'week') d.setDate(d.getDate() + 7 * n); else d.setMonth(d.getMonth() + n); setCursor(d); };
  const title = mode === 'week'
    ? `${days[0].toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`
    : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  const chip = (it, setEditing2) => it.kind === 'holiday' ? (
    <div key={`h${it.date}${it.name}`} className={`cal-chip cal-holiday cal-holiday-${it.type}`} title={`${it.name}${it.type === 'festival' ? ' (festival)' : it.type === 'national' ? ' (national holiday)' : ' (gazetted holiday)'}`} onClick={(e) => e.stopPropagation()}>
      <span className="cal-dot" /> {it.type === 'festival' ? '🎉' : '🏛️'} {it.name}
    </div>
  ) : it.kind === 'meeting' ? (
    <button key={`m${it.id}`} className="cal-chip cal-meeting" title={it.title} onClick={(e) => { e.stopPropagation(); onOpenMeetings?.(); }}>
      <span className="cal-dot" /> {it.call_type === 'audio' ? '📞' : '🎥'} {hhmm(it.scheduled_at)} {it.title}
    </button>
  ) : (
    <button key={`e${it.id}${it.starts_at}`} className="cal-chip cal-event" title={it.title}
      style={it.color ? { background: it.color + '22', color: it.color } : undefined}
      onClick={(e) => { e.stopPropagation(); setEditing2(it); }}>
      <span className="cal-dot" /> {it.recurrence && it.recurrence !== 'none' ? '🔁 ' : ''}{it.all_day ? '' : hhmm(it.starts_at) + ' '}{it.title}
    </button>
  );

  return (
    <div className="cal-view">
      <div className="cal-head">
        <div className="cal-title">{title}</div>
        <div className="cal-nav">
          <div className="cal-modeswitch">
            <button className={mode === 'month' ? 'on' : ''} onClick={() => setMode('month')}>Month</button>
            <button className={mode === 'week' ? 'on' : ''} onClick={() => setMode('week')}>Week</button>
          </div>
          <button className="btn btn-sm" onClick={() => shift(-1)}>‹</button>
          <button className="btn btn-sm" onClick={() => setCursor(new Date())}>Today</button>
          <button className="btn btn-sm" onClick={() => shift(1)}>›</button>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ date: todayKey })}>＋ New event</button>
        </div>
      </div>

      {mode === 'month' ? (
        <div className="cal-grid">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
          {days.map((d) => {
            const key = localYMD(d);
            const items = byDay[key] || [];
            return (
              <div key={key} className={`cal-cell ${d.getMonth() !== cursor.getMonth() ? 'dim' : ''} ${key === todayKey ? 'today' : ''}`} onClick={() => setEditing({ date: key })}>
                <div className="cal-daynum">{d.getDate()}</div>
                <div className="cal-items">
                  {items.slice(0, 4).map((it) => chip(it, setEditing))}
                  {items.length > 4 && <div className="cal-more">+{items.length - 4} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="cal-week">
          {days.map((d) => {
            const key = localYMD(d);
            const items = byDay[key] || [];
            return (
              <div key={key} className={`cal-wcol ${key === todayKey ? 'today' : ''}`} onClick={() => setEditing({ date: key })}>
                <div className="cal-whead"><span>{DOW[d.getDay()]}</span><b>{d.getDate()}</b></div>
                <div className="cal-witems">
                  {items.map((it) => chip(it, setEditing))}
                  {items.length === 0 && <div className="cal-wempty">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && <EventEditor init={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function EventEditor({ init, onClose, onSaved }) {
  const existing = init.id ? init : null;
  // For a recurring series, edit from the series' base start, not the occurrence.
  const baseStart = existing ? (existing.series_start || existing.starts_at) : null;
  const baseDate = existing ? (existing.all_day ? baseStart.slice(0, 10) : localYMD(parseUTC(baseStart))) : init.date;
  const localTime = (s) => { const d = parseUTC(s); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const [f, setF] = useState({
    title: existing?.title || '',
    date: baseDate,
    all_day: existing ? !!existing.all_day : false,
    start: existing && !existing.all_day ? localTime(baseStart) : '10:00',
    end: existing && existing.ends_at && !existing.all_day ? localTime(existing.ends_at) : '10:30',
    remind_min: existing?.remind_min != null ? String(existing.remind_min) : '10',
    recurrence: existing?.recurrence || 'none',
    repeat_until: existing?.repeat_until ? existing.repeat_until.slice(0, 10) : '',
    notes: existing?.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (!f.title.trim()) return;
    setBusy(true); setError(null);
    const body = {
      title: f.title.trim(), all_day: f.all_day, notes: f.notes.trim(),
      remind_min: f.remind_min === '' ? null : Number(f.remind_min),
      recurrence: f.recurrence, repeat_until: f.recurrence !== 'none' ? (f.repeat_until || null) : null,
    };
    if (f.all_day) { body.starts_at = f.date; body.ends_at = null; }
    else {
      body.starts_at = new Date(`${f.date}T${f.start}`).toISOString();
      body.ends_at = f.end ? new Date(`${f.date}T${f.end}`).toISOString() : null;
    }
    try {
      if (existing) await api(`/calendar-events/${existing.id}`, { method: 'PATCH', body });
      else await api('/calendar-events', { method: 'POST', body });
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  }
  async function del() {
    if (!window.confirm(existing.recurrence && existing.recurrence !== 'none' ? 'Delete this repeating event (all occurrences)?' : 'Delete this event?')) return;
    await api(`/calendar-events/${existing.id}`, { method: 'DELETE' }).catch(() => {});
    onSaved();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxWidth: 440 }}>
        <div className="modal-header"><strong>{existing ? 'Edit event' : 'New event'}</strong><button type="button" className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input className="auth-input" placeholder="Title" value={f.title} onChange={set('title')} autoFocus required />
          <label className="cal-check"><input type="checkbox" checked={f.all_day} onChange={set('all_day')} /> All day</label>
          <div style={{ display: 'flex', gap: 10 }}>
            <label className="meeting-field">Date<input className="auth-input" type="date" value={f.date} onChange={set('date')} required /></label>
            {!f.all_day && <label className="meeting-field">Start<input className="auth-input" type="time" value={f.start} onChange={set('start')} /></label>}
            {!f.all_day && <label className="meeting-field">End<input className="auth-input" type="time" value={f.end} onChange={set('end')} /></label>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <label className="meeting-field">Repeat
              <select className="auth-input" value={f.recurrence} onChange={set('recurrence')}>
                {REPEAT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {f.recurrence !== 'none' && <label className="meeting-field">Until (optional)<input className="auth-input" type="date" value={f.repeat_until} onChange={set('repeat_until')} /></label>}
          </div>
          <label className="meeting-field">Reminder
            <select className="auth-input" value={f.remind_min} onChange={set('remind_min')}>
              {REMIND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <textarea className="auth-input" placeholder="Notes (optional)" rows={2} value={f.notes} onChange={set('notes')} />
          {existing && existing.recurrence !== 'none' && <div className="muted" style={{ fontSize: 12 }}>Changes apply to the whole series.</div>}
          {error && <div className="form-error">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busy} style={{ flex: 1 }}>{busy ? 'Saving…' : existing ? 'Save' : 'Add event'}</button>
            {existing && <button type="button" className="btn btn-danger" onClick={del}>Delete</button>}
          </div>
        </div>
      </form>
    </div>
  );
}
