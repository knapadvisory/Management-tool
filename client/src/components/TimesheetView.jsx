import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { fmtDuration, emitTimeChanged, onTimeChanged } from '../time.js';

const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

// Parse "1h 30m" / "90" / "1.5h" into minutes.
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
  const [summary, setSummary] = useState({ today: 0, week: 0, month: 0 });
  const [report, setReport] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  const isAdmin = user.role === 'admin';

  const load = useCallback(async () => {
    const [e, s] = await Promise.all([api('/time'), api('/time/summary')]);
    setEntries(e.entries); setSummary(s);
    if (isAdmin) api('/time/report').then(setReport).catch(() => {});
  }, [isAdmin]);
  useEffect(() => { load(); return onTimeChanged(load); }, [load]);

  // Group my entries by day.
  const byDay = {};
  for (const e of entries) { (byDay[e.entry_date] ||= []).push(e); }
  const days = Object.keys(byDay).sort().reverse();

  async function del(id) {
    if (!confirm('Delete this time entry?')) return;
    await api(`/time/${id}`, { method: 'DELETE' });
    emitTimeChanged();
  }

  return (
    <div className="timesheet-view">
      <header className="ts-head">
        <h1>Timesheet</h1>
        <button className="btn btn-primary" onClick={() => setLogOpen(true)}>＋ Log time</button>
      </header>

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
          {days.length === 0 && <div className="empty-hint">No time logged yet. Start the timer or log time manually.</div>}
          {days.map((d) => {
            const dayTotal = byDay[d].reduce((s, e) => s + e.minutes, 0);
            return (
              <section key={d} className="ts-day">
                <div className="ts-day-head"><strong>{fmtDay(d)}</strong><span className="muted">{fmtDuration(dayTotal)}</span></div>
                {byDay[d].map((e) => (
                  <div key={e.id} className="ts-row">
                    <span className="ts-dur">{fmtDuration(e.minutes)}</span>
                    <span className="ts-what">
                      {e.task ? e.task.title : (e.client ? e.client.name : 'General')}
                      {e.description && <span className="muted"> · {e.description}</span>}
                      {!e.billable && <span className="ts-nonbill">non-billable</span>}
                    </span>
                    {e.client && <span className="muted small">{e.client.name}</span>}
                    <button className="icon-btn" title="Delete" onClick={() => del(e.id)}>✕</button>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {tab === 'team' && report && (
        <div className="ts-report">
          <section className="dash-panel">
            <div className="dash-block-head"><h2>Hours by employee <span className="muted small">this range</span></h2></div>
            {report.by_user.length === 0 && <div className="empty-hint">No time logged.</div>}
            {report.by_user.map((u) => {
              const max = Math.max(...report.by_user.map((x) => x.minutes), 1);
              return (
                <div key={u.id} className="ts-rp-row">
                  <span className="ts-rp-name"><Avatar user={u} size={22} /> {u.name}</span>
                  <div className="ts-rp-bar"><span style={{ width: `${(u.minutes / max) * 100}%`, background: u.avatar_color }} /></div>
                  <span className="ts-rp-val">{fmtDuration(u.minutes)} · {u.tasks} task{u.tasks === 1 ? '' : 's'}</span>
                </div>
              );
            })}
          </section>
          <section className="dash-panel">
            <div className="dash-block-head"><h2>Hours by client</h2></div>
            {report.by_client.length === 0 && <div className="empty-hint">No client time logged.</div>}
            {report.by_client.map((c) => (
              <div key={c.id} className="ts-rp-row">
                <span className="ts-rp-name">{c.name}</span>
                <span className="ts-rp-val">{fmtDuration(c.minutes)}</span>
              </div>
            ))}
          </section>
        </div>
      )}

      {logOpen && <LogTimeModal onClose={() => setLogOpen(false)} onDone={() => { setLogOpen(false); emitTimeChanged(); }} />}
    </div>
  );
}

// Manual time-entry modal (optionally pinned to a task or client).
export function LogTimeModal({ taskId = null, clientId = null, contextLabel, onClose, onDone }) {
  const [dur, setDur] = useState('');
  const [desc, setDesc] = useState('');
  const [date, setDate] = useState(todayStr());
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    const minutes = parseDuration(dur);
    if (!minutes) { setError('Enter a duration, e.g. 1h 30m or 90'); return; }
    setBusy(true); setError(null);
    try {
      await api('/time', { method: 'POST', body: { task_id: taskId, client_id: clientId, minutes, description: desc.trim(), entry_date: date, billable } });
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header"><strong>Log time{contextLabel ? ` · ${contextLabel}` : ''}</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">Time spent<input autoFocus value={dur} onChange={(e) => setDur(e.target.value)} placeholder="e.g. 1h 30m or 90" /></label>
          <label className="field">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field">Note <span className="muted">(optional)</span><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What did you work on?" /></label>
          <label className="checkbox"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <span />
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Log time'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
