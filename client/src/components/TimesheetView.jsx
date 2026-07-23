import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { fmtDuration, elapsedClock, emitTimeChanged, onTimeChanged } from '../time.js';

const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
// A UTC SQL datetime → local "9:15 AM".
const localTime = (sql) => {
  if (!sql) return '';
  return new Date(sql.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// Parse "1h 30m" / "90" / "1.5h" into minutes (for manual corrections).
function parseDuration(str) {
  const s = String(str).trim().toLowerCase();
  if (!s) return 0;
  const hm = s.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/);
  if (hm) return Math.round(Number(hm[1]) * 60 + (Number(hm[2]) || 0));
  const m = s.match(/^(\d+)\s*m$/);
  if (m) return Number(m[1]);
  return Math.round(Number(s) || 0);
}

export default function TimesheetView({ user }) {
  const [tab, setTab] = useState('mine');
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState({ today: 0, week: 0, month: 0, running: null });
  const [report, setReport] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [, tick] = useState(0);
  const isAdmin = user.role === 'admin';
  const clockedIn = summary.running || null;

  const load = useCallback(async () => {
    const [e, s] = await Promise.all([api('/time'), api('/time/summary')]);
    setEntries(e.entries); setSummary(s);
    if (isAdmin) api('/time/report').then(setReport).catch(() => {});
  }, [isAdmin]);
  useEffect(() => { load(); return onTimeChanged(load); }, [load]);
  // Tick the live "clocked in" clock every second.
  useEffect(() => {
    if (!clockedIn) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [clockedIn]);

  async function clockIn() { await api('/time/start', { method: 'POST', body: {} }); emitTimeChanged(); }
  async function clockOut() { await api('/time/stop', { method: 'POST' }); emitTimeChanged(); }
  async function del(id) {
    if (!confirm('Delete this entry?')) return;
    await api(`/time/${id}`, { method: 'DELETE' }); emitTimeChanged();
  }

  // Group entries by day.
  const byDay = {};
  for (const e of entries) { (byDay[e.entry_date] ||= []).push(e); }
  const days = Object.keys(byDay).sort().reverse();

  return (
    <div className="timesheet-view">
      <header className="ts-head">
        <h1>Timesheet</h1>
        <button className="btn" onClick={() => setAddOpen(true)}>＋ Add hours</button>
      </header>

      {/* Clock in / out */}
      <div className={`clock-card ${clockedIn ? 'in' : ''}`}>
        {clockedIn ? (
          <>
            <div className="clock-status">
              <span className="clock-dot" />
              <div>
                <div className="clock-big">Clocked in · {elapsedClock(clockedIn.started_at)}</div>
                <div className="muted">since {localTime(clockedIn.started_at)} today</div>
              </div>
            </div>
            <button className="btn btn-danger" onClick={clockOut}>Clock out</button>
          </>
        ) : (
          <>
            <div className="clock-status">
              <span className="clock-dot off" />
              <div>
                <div className="clock-big">You're clocked out</div>
                <div className="muted">Clock in when you start work</div>
              </div>
            </div>
            <button className="btn btn-primary" onClick={clockIn}>Clock in</button>
          </>
        )}
      </div>

      <div className="ts-summary">
        <div className="ts-stat"><span className="ts-num">{fmtDuration(summary.today)}</span><span className="ts-lbl">Today</span></div>
        <div className="ts-stat"><span className="ts-num">{fmtDuration(summary.week)}</span><span className="ts-lbl">This week</span></div>
        <div className="ts-stat"><span className="ts-num">{fmtDuration(summary.month)}</span><span className="ts-lbl">This month</span></div>
      </div>

      {isAdmin && (
        <div className="ts-tabs">
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>My time</button>
          <button className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>Team report</button>
        </div>
      )}

      {tab === 'mine' && (
        <div className="ts-days">
          {days.length === 0 && <div className="empty-hint">No hours yet. Clock in above to start today's timesheet.</div>}
          {days.map((d) => {
            const dayTotal = byDay[d].reduce((s, e) => s + e.minutes, 0);
            return (
              <section key={d} className="ts-day">
                <div className="ts-day-head"><strong>{fmtDay(d)}</strong><span className="muted">{fmtDuration(dayTotal)}</span></div>
                {byDay[d].map((e) => (
                  <div key={e.id} className="ts-row">
                    <span className="ts-dur">{fmtDuration(e.minutes)}</span>
                    <span className="ts-what">
                      {e.started_at && e.ended_at ? `${localTime(e.started_at)} – ${localTime(e.ended_at)}`
                        : e.is_running ? <span className="muted">running…</span> : <span className="muted">manual entry</span>}
                      {e.description && <span className="muted"> · {e.description}</span>}
                    </span>
                    {!e.is_running && <button className="icon-btn" title="Delete" onClick={() => del(e.id)}>✕</button>}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {tab === 'team' && report && (
        <section className="dash-panel">
          <div className="dash-block-head"><h2>Hours by employee <span className="muted small">this month range</span></h2></div>
          {report.by_user.length === 0 && <div className="empty-hint">No hours logged.</div>}
          {report.by_user.map((u) => {
            const max = Math.max(...report.by_user.map((x) => x.minutes), 1);
            return (
              <div key={u.id} className="ts-rp-row">
                <span className="ts-rp-name"><Avatar user={u} size={22} /> {u.name}</span>
                <div className="ts-rp-bar"><span style={{ width: `${(u.minutes / max) * 100}%`, background: u.avatar_color }} /></div>
                <span className="ts-rp-val">{fmtDuration(u.minutes)}</span>
              </div>
            );
          })}
        </section>
      )}

      {addOpen && <AddHoursModal onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); emitTimeChanged(); }} />}
    </div>
  );
}

// Manually add hours for a day you forgot to clock (correction).
function AddHoursModal({ onClose, onDone }) {
  const [dur, setDur] = useState('');
  const [date, setDate] = useState(todayStr());
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    const minutes = parseDuration(dur);
    if (!minutes) { setError('Enter hours, e.g. 8h or 7h 30m'); return; }
    setBusy(true); setError(null);
    try {
      await api('/time', { method: 'POST', body: { minutes, entry_date: date, description: desc.trim() } });
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header"><strong>Add hours</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">Hours<input autoFocus value={dur} onChange={(e) => setDur(e.target.value)} placeholder="e.g. 8h or 7h 30m" /></label>
          <label className="field">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field">Note <span className="muted">(optional)</span><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. forgot to clock in" /></label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <span />
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
