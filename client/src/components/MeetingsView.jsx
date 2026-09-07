import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

const parseUTC = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const fmtWhen = (s) => parseUTC(s).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const endsAt = (m) => new Date(parseUTC(m.scheduled_at).getTime() + (m.duration_min || 30) * 60000);
// A meeting is joinable from 10 min before start until it ends.
const joinable = (m) => { const now = Date.now(); return now >= parseUTC(m.scheduled_at).getTime() - 10 * 60000 && now <= endsAt(m).getTime(); };
const startCall = (m) => window.dispatchEvent(new CustomEvent('teamhub:start-room-call', { detail: { kind: 'meeting', target_id: m.id, call_type: m.call_type, title: m.title } }));

export default function MeetingsView({ user, users = [] }) {
  const [meetings, setMeetings] = useState([]);
  const [scheduling, setScheduling] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => { api('/meetings').then((d) => setMeetings(d.meetings || [])).catch(() => {}); }, []);
  useEffect(() => {
    load();
    const s = getSocket();
    s?.on('meetings:changed', load);
    const id = setInterval(load, 60000);
    return () => { s?.off('meetings:changed', load); clearInterval(id); };
  }, [load]);

  const now = Date.now();
  const upcoming = meetings.filter((m) => endsAt(m).getTime() >= now);
  const past = meetings.filter((m) => endsAt(m).getTime() < now).reverse();

  return (
    <div className="meetings-view">
      <div className="meetings-head">
        <div>
          <h2>Meetings</h2>
          <p className="muted">Schedule video or audio meetings, invite your team, and keep shared notes.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setScheduling(true)}>＋ Schedule meeting</button>
      </div>

      <MeetingList title="Upcoming" list={upcoming} onOpen={setSelected} empty="No meetings scheduled. Create one to get started." />
      {past.length > 0 && <MeetingList title="Past" list={past} onOpen={setSelected} past />}

      {scheduling && <ScheduleMeeting user={user} users={users} onClose={() => setScheduling(false)} onSaved={() => { setScheduling(false); load(); }} />}
      {selected && <MeetingDetail id={selected.id} user={user} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function MeetingList({ title, list, onOpen, past, empty }) {
  return (
    <div className="meetings-section">
      <div className="meetings-section-title">{title}</div>
      {list.length === 0 && empty && <div className="muted" style={{ fontSize: 13 }}>{empty}</div>}
      <div className="meeting-cards">
        {list.map((m) => (
          <button key={m.id} className={`meeting-card ${past ? 'past' : ''}`} onClick={() => onOpen(m)}>
            <span className="meeting-ico">{m.call_type === 'audio' ? '📞' : '🎥'}</span>
            <div className="meeting-card-main">
              <div className="meeting-card-title">{m.title}</div>
              <div className="meeting-card-when">{fmtWhen(m.scheduled_at)} · {m.duration_min}m</div>
            </div>
            <div className="meeting-card-people">
              <Avatar user={m.host} size={22} />
              {m.invitees.slice(0, 3).map((u) => <Avatar key={u.id} user={u} size={22} />)}
              {m.invitees.length > 3 && <span className="meeting-more">+{m.invitees.length - 3}</span>}
            </div>
            {!past && joinable(m) && <span className="meeting-live-dot" title="Joinable now" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScheduleMeeting({ user, users, onClose, onSaved }) {
  const now = new Date(Date.now() + 60 * 60000);
  const localDefault = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState({ title: '', description: '', when: localDefault, duration_min: 30, call_type: 'video' });
  const [invitees, setInvitees] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (id) => setInvitees((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  async function submit(e) {
    e.preventDefault();
    if (!f.title.trim() || !f.when) return;
    setBusy(true); setError(null);
    try {
      await api('/meetings', { method: 'POST', body: {
        title: f.title.trim(), description: f.description.trim(),
        scheduled_at: new Date(f.when).toISOString(),
        duration_min: Number(f.duration_min), call_type: f.call_type, invitee_ids: invitees,
      } });
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const team = users.filter((u) => u.id !== user.id && u.role !== 'guest');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxWidth: 500 }}>
        <div className="modal-header"><strong>Schedule meeting</strong><button type="button" className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input className="auth-input" placeholder="Meeting title" value={f.title} onChange={set('title')} autoFocus required />
          <textarea className="auth-input" placeholder="Agenda / description (optional)" rows={2} value={f.description} onChange={set('description')} />
          <div style={{ display: 'flex', gap: 10 }}>
            <label className="meeting-field">When<input className="auth-input" type="datetime-local" value={f.when} onChange={set('when')} required /></label>
            <label className="meeting-field">Length
              <select className="auth-input" value={f.duration_min} onChange={set('duration_min')}>
                {[15, 30, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} min</option>)}
              </select>
            </label>
          </div>
          <label className="meeting-field">Type
            <select className="auth-input" value={f.call_type} onChange={set('call_type')}>
              <option value="video">🎥 Video</option><option value="audio">📞 Audio</option>
            </select>
          </label>
          <div className="lead-field-label">Invite</div>
          <div className="meeting-invite-list">
            {team.map((u) => (
              <button type="button" key={u.id} className={`meeting-invite ${invitees.includes(u.id) ? 'on' : ''}`} onClick={() => toggle(u.id)}>
                <Avatar user={u} size={22} /> {u.name} {invitees.includes(u.id) && <span>✓</span>}
              </button>
            ))}
            {team.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No teammates to invite yet.</span>}
          </div>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Scheduling…' : 'Schedule'}</button>
        </div>
      </form>
    </div>
  );
}

function MeetingDetail({ id, user, onClose, onChanged }) {
  const [m, setM] = useState(null);
  const [notes, setNotes] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const load = useCallback(() => { api(`/meetings/${id}`).then((d) => { setM(d.meeting); setNotes(d.meeting.notes || ''); }).catch(() => {}); }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!m) return null;
  async function saveNotes() {
    if (notes === (m.notes || '')) return;
    const { meeting } = await api(`/meetings/${id}`, { method: 'PATCH', body: { notes } });
    setM(meeting); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1200);
  }
  async function reschedule(whenLocal) {
    const { meeting } = await api(`/meetings/${id}`, { method: 'PATCH', body: { scheduled_at: new Date(whenLocal).toISOString() } });
    setM(meeting); onChanged?.();
  }
  async function cancel() {
    if (!window.confirm('Cancel this meeting for everyone?')) return;
    await api(`/meetings/${id}`, { method: 'DELETE' }).catch(() => {});
    onChanged?.(); onClose();
  }
  const canJoin = joinable(m);
  const whenLocal = new Date(parseUTC(m.scheduled_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="lead-detail" onClick={(e) => e.stopPropagation()}>
        <div className="lead-detail-head">
          <h3>{m.call_type === 'audio' ? '📞' : '🎥'} {m.title}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="meeting-when-row">
          <div>{fmtWhen(m.scheduled_at)} · {m.duration_min} min</div>
          <button className={`btn btn-sm ${canJoin ? 'btn-primary' : ''}`} disabled={!canJoin} onClick={() => { startCall(m); onClose(); }}>
            {canJoin ? 'Join now' : 'Not started'}
          </button>
        </div>
        {m.description && <div className="lead-message" style={{ marginTop: 8 }}>{m.description}</div>}

        <label className="lead-field-label">Participants</label>
        <div className="meeting-people">
          <span className="meeting-person"><Avatar user={m.host} size={24} /> {m.host.name} <span className="muted">host</span></span>
          {m.invitees.map((u) => <span className="meeting-person" key={u.id}><Avatar user={u} size={24} /> {u.name}</span>)}
        </div>

        <label className="lead-field-label">Shared notes {savedFlash && <span className="muted">saved ✓</span>}</label>
        <textarea className="auth-input" rows={5} placeholder="Notes everyone on this meeting can see and edit…"
          value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />

        {m.is_host && (
          <div className="meeting-host-tools">
            <label className="meeting-field" style={{ flex: 1 }}>Reschedule
              <input className="auth-input" type="datetime-local" defaultValue={whenLocal} onChange={(e) => e.target.value && reschedule(e.target.value)} />
            </label>
            <button className="btn btn-sm btn-danger" onClick={cancel}>Cancel meeting</button>
          </div>
        )}
      </div>
    </div>
  );
}
