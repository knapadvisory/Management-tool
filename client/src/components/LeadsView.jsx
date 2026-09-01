import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';

// Column accent colours, assigned by position so custom stages still get one.
const STAGE_COLORS = ['#4f46e5', '#d97706', '#2563eb', '#16a34a', '#64748b', '#db2777', '#0891b2', '#7c3aed'];
const digits = (s) => String(s || '').replace(/\D/g, '');
// Reminders are stored as a UTC "YYYY-MM-DD HH:MM:SS" string (no zone marker).
const parseUTC = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const fmtWhen = (s) => parseUTC(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export default function LeadsView({ user, users = [], onOpenTask }) {
  const manageAll = user.role === 'admin' || user.role === 'sales';
  const [leads, setLeads] = useState([]);
  const [stages, setStages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState(false);
  const [managing, setManaging] = useState(false);
  const [insights, setInsights] = useState(false);
  const [drag, setDrag] = useState(null);

  const load = useCallback(() => { api('/leads').then((d) => setLeads(d.leads || [])).catch(() => {}); }, []);
  const loadStages = useCallback(() => { api('/leads/stages').then((d) => setStages(d.stages || [])).catch(() => {}); }, []);
  useEffect(() => {
    load(); loadStages();
    const s = getSocket();
    s?.on('leads:changed', load);
    s?.on('leads:stages', loadStages);
    const id = setInterval(load, 45000);
    return () => { s?.off('leads:changed', load); s?.off('leads:stages', loadStages); clearInterval(id); };
  }, [load, loadStages]);

  async function patch(id, body) {
    const { lead } = await api(`/leads/${id}`, { method: 'PATCH', body });
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...lead } : l)));
    setSelected((cur) => (cur && cur.id === id ? { ...cur, ...lead } : cur));
  }
  async function remove(id) {
    if (!window.confirm('Delete this lead?')) return;
    await api(`/leads/${id}`, { method: 'DELETE' }).catch(() => {});
    setSelected(null); load();
  }

  return (
    <div className="leads-view">
      <div className="leads-head">
        <div>
          <h2>Leads</h2>
          <p className="muted">
            {manageAll
              ? 'Enquiries from your website, email and manual entry — move them along the pipeline.'
              : 'Leads assigned to you — move them along the pipeline.'}
          </p>
        </div>
        <div className="leads-head-actions">
          <button className="btn" onClick={() => setAdding(true)}>＋ Add lead</button>
          {manageAll && <button className="btn" onClick={() => setInsights(true)}>📊 Insights</button>}
          {user.role === 'admin' && <button className="btn" onClick={() => setManaging(true)}>▤ Stages</button>}
          {user.role === 'admin' && <button className="btn" onClick={() => setSetup(true)}>⚙ Website setup</button>}
        </div>
      </div>

      <div className="leads-board">
        {stages.map((col, i) => {
          const items = leads.filter((l) => l.status === col.key);
          return (
            <div
              key={col.id}
              className={`leads-col ${drag ? 'droppable' : ''}`}
              onDragOver={(e) => { if (drag) e.preventDefault(); }}
              onDrop={() => { if (drag && drag.status !== col.key) patch(drag.id, { status: col.key }); setDrag(null); }}
            >
              <div className="leads-col-head">
                <span className="dot" style={{ background: STAGE_COLORS[i % STAGE_COLORS.length] }} /> {col.label}
                <span className="leads-count">{items.length}</span>
              </div>
              <div className="leads-col-body">
                {items.map((l) => (
                  <div
                    key={l.id}
                    className="lead-card"
                    draggable
                    onDragStart={() => setDrag(l)}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => setSelected(l)}
                  >
                    <div className="lead-card-name">{l.name || l.email || l.phone || 'Enquiry'}</div>
                    {l.message && <div className="lead-card-msg">{l.message}</div>}
                    <div className="lead-card-foot">
                      {l.note_count > 0 && <span className="lead-chip" title={`${l.note_count} note(s)`}>📝 {l.note_count}</span>}
                      {l.next_reminder && <span className="lead-chip lead-chip-due" title={`Follow-up ${fmtWhen(l.next_reminder)}`}>⏰</span>}
                      <span className={`lead-src src-${l.source}`}>{l.source}</span>
                      {l.owner_id && <Avatar user={{ name: l.owner_name, avatar_color: l.owner_avatar_color }} size={20} />}
                    </div>
                  </div>
                ))}
                {items.length === 0 && <div className="leads-empty muted">—</div>}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <LeadDetail
          lead={selected} user={user} users={users} stages={stages} onClose={() => setSelected(null)}
          onPatch={patch} onDelete={remove} onOpenTask={onOpenTask} onRefresh={load}
        />
      )}
      {adding && <AddLead users={users} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
      {setup && <LeadSetup onClose={() => setSetup(false)} />}
      {managing && <ManageStages stages={stages} onClose={() => setManaging(false)} onChange={setStages} />}
      {insights && <LeadInsights onClose={() => setInsights(false)} />}
    </div>
  );
}

function LeadInsights({ onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api('/leads/analytics').then(setD).catch(() => setD({ error: true })); }, []);
  const maxStage = d && d.byStage ? Math.max(1, ...d.byStage.map((s) => s.count)) : 1;
  const maxSrc = d && d.bySource ? Math.max(1, ...d.bySource.map((s) => s.count)) : 1;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="modal-header"><strong>Lead insights</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16 }}>
          {!d && <div className="muted">Loading…</div>}
          {d && d.error && <div className="muted">Couldn't load analytics.</div>}
          {d && !d.error && (
            <>
              <div className="insight-tiles">
                <div className="insight-tile"><div className="insight-num">{d.total}</div><div className="insight-lbl">Total leads</div></div>
                <div className="insight-tile"><div className="insight-num">{d.open}</div><div className="insight-lbl">Open</div></div>
                <div className="insight-tile"><div className="insight-num">{d.won}</div><div className="insight-lbl">Won</div></div>
                <div className="insight-tile"><div className="insight-num">{d.conversion}%</div><div className="insight-lbl">Win rate</div></div>
                <div className="insight-tile"><div className="insight-num">{d.avgDaysToWin ?? '—'}</div><div className="insight-lbl">Avg days to win</div></div>
                <div className="insight-tile"><div className="insight-num">{d.newThisWeek}</div><div className="insight-lbl">New this week</div></div>
              </div>

              <label className="lead-field-label">Leads by stage</label>
              <div className="insight-bars">
                {d.byStage.map((s, i) => (
                  <div className="insight-bar-row" key={i}>
                    <span className="insight-bar-lbl">{s.label}{s.outcome !== 'open' ? (s.outcome === 'won' ? ' ✅' : ' ✖') : ''}</span>
                    <span className="insight-bar-track"><span className="insight-bar-fill" style={{ width: `${(s.count / maxStage) * 100}%`, background: STAGE_COLORS[i % STAGE_COLORS.length] }} /></span>
                    <span className="insight-bar-val">{s.count}</span>
                  </div>
                ))}
              </div>

              <label className="lead-field-label">By source</label>
              <div className="insight-bars">
                {d.bySource.map((s, i) => (
                  <div className="insight-bar-row" key={i}>
                    <span className="insight-bar-lbl">{s.source}</span>
                    <span className="insight-bar-track"><span className="insight-bar-fill" style={{ width: `${(s.count / maxSrc) * 100}%` }} /></span>
                    <span className="insight-bar-val">{s.count}</span>
                  </div>
                ))}
              </div>

              {d.topOwners.length > 0 && (
                <>
                  <label className="lead-field-label">Top closers (won)</label>
                  <div className="insight-owners">
                    {d.topOwners.map((o, i) => (
                      <div className="insight-owner" key={i}>
                        <Avatar user={{ name: o.name, avatar_color: o.avatar_color }} size={24} />
                        <span>{o.name}</span><span className="insight-bar-val">{o.won}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LeadDetail({ lead, user, users, stages, onClose, onPatch, onDelete, onOpenTask, onRefresh }) {
  const wa = digits(lead.phone);
  const [notes, setNotes] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [noteText, setNoteText] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [remindNote, setRemindNote] = useState('');

  const loadNotes = useCallback(() => { api(`/leads/${lead.id}/notes`).then((d) => setNotes(d.notes || [])).catch(() => {}); }, [lead.id]);
  const loadReminders = useCallback(() => { api(`/leads/${lead.id}/reminders`).then((d) => setReminders(d.reminders || [])).catch(() => {}); }, [lead.id]);
  useEffect(() => { loadNotes(); loadReminders(); }, [loadNotes, loadReminders]);

  async function addNote(e) {
    e.preventDefault();
    if (!noteText.trim()) return;
    const { note } = await api(`/leads/${lead.id}/notes`, { method: 'POST', body: { body: noteText.trim() } });
    setNotes((n) => [note, ...n]); setNoteText(''); onRefresh?.();
  }
  async function delNote(id) {
    await api(`/leads/${lead.id}/notes/${id}`, { method: 'DELETE' }).catch(() => {});
    setNotes((n) => n.filter((x) => x.id !== id)); onRefresh?.();
  }
  async function addReminder(e) {
    e.preventDefault();
    if (!remindAt) return;
    const iso = new Date(remindAt).toISOString();
    const { reminders: rs } = await api(`/leads/${lead.id}/reminders`, { method: 'POST', body: { remind_at: iso, note: remindNote.trim() } });
    setReminders(rs); setRemindAt(''); setRemindNote(''); onRefresh?.();
  }
  async function delReminder(id) {
    const { reminders: rs } = await api(`/leads/${lead.id}/reminders/${id}`, { method: 'DELETE' });
    setReminders(rs); onRefresh?.();
  }
  // A sensible default for the picker: tomorrow 10:00 local.
  function quickPick(days) {
    const d = new Date(); d.setDate(d.getDate() + days); d.setHours(10, 0, 0, 0);
    const off = d.getTimezoneOffset();
    setRemindAt(new Date(d.getTime() - off * 60000).toISOString().slice(0, 16));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="lead-detail" onClick={(e) => e.stopPropagation()}>
        <div className="lead-detail-head">
          <h3>{lead.name || 'Enquiry'}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="lead-detail-actions">
          {lead.email && <a className="btn btn-sm" href={`mailto:${lead.email}`}>✉ Email</a>}
          {lead.phone && <a className="btn btn-sm" href={`tel:${lead.phone}`}>📞 Call</a>}
          {wa && <a className="btn btn-sm" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
        </div>

        <label className="lead-field-label">Stage</label>
        <select value={lead.status} onChange={(e) => onPatch(lead.id, { status: e.target.value })} className="lead-select">
          {stages.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>

        <label className="lead-field-label">Owner</label>
        <select value={lead.owner_id || ''} onChange={(e) => onPatch(lead.id, { owner_id: e.target.value ? Number(e.target.value) : null })} className="lead-select">
          <option value="">Unassigned</option>
          {users.filter((u) => u.role !== 'guest').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>

        <div className="lead-detail-info">
          {lead.email && <div><span className="muted">Email</span> {lead.email}</div>}
          {lead.phone && <div><span className="muted">Phone</span> {lead.phone}</div>}
          <div><span className="muted">Source</span> {lead.source}</div>
          <div><span className="muted">Received</span> {new Date(lead.created_at).toLocaleString()}</div>
        </div>

        {lead.message && (
          <>
            <label className="lead-field-label">Enquiry</label>
            <div className="lead-message">{lead.message}</div>
          </>
        )}

        {/* Follow-up reminders */}
        <label className="lead-field-label">Follow-up reminders</label>
        {reminders.length > 0 && (
          <div className="lead-reminders">
            {reminders.map((r) => (
              <div key={r.id} className={`lead-reminder ${r.sent ? 'done' : ''}`}>
                <span>{r.sent ? '✅' : '⏰'} {fmtWhen(r.remind_at)}{r.note ? ` — ${r.note}` : ''}</span>
                <button className="icon-btn" title="Remove" onClick={() => delReminder(r.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={addReminder} className="lead-remind-form">
          <div className="lead-quickpick">
            <button type="button" className="btn btn-sm" onClick={() => quickPick(1)}>Tomorrow</button>
            <button type="button" className="btn btn-sm" onClick={() => quickPick(3)}>In 3 days</button>
            <button type="button" className="btn btn-sm" onClick={() => quickPick(7)}>Next week</button>
          </div>
          <input className="auth-input" type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
          <input className="auth-input" placeholder="What to do (optional)" value={remindNote} onChange={(e) => setRemindNote(e.target.value)} />
          <button className="btn btn-sm btn-primary" disabled={!remindAt}>Set reminder</button>
        </form>

        {/* Notes / remarks */}
        <label className="lead-field-label">Notes &amp; remarks</label>
        <form onSubmit={addNote} className="lead-note-form">
          <textarea className="auth-input" rows={2} placeholder="Log a call, remark or next step…" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          <button className="btn btn-sm btn-primary" disabled={!noteText.trim()}>Add note</button>
        </form>
        <div className="lead-notes">
          {notes.map((n) => (
            <div key={n.id} className="lead-note">
              <Avatar user={{ name: n.author_name, avatar_color: n.author_color }} size={24} />
              <div className="lead-note-body">
                <div className="lead-note-meta">
                  <strong>{n.author_name || 'Someone'}</strong>
                  <span className="muted">{new Date(n.created_at + 'Z').toLocaleString()}</span>
                  {(n.user_id === user.id || user.role === 'admin') && <button className="icon-btn lead-note-del" title="Delete" onClick={() => delNote(n.id)}>✕</button>}
                </div>
                <div className="lead-note-text">{n.body}</div>
              </div>
            </div>
          ))}
          {notes.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No notes yet.</div>}
        </div>

        <div className="lead-detail-foot">
          {lead.task_id && <button className="btn btn-sm" onClick={() => onOpenTask?.(lead.task_id)}>Open follow-up task →</button>}
          <button className="btn btn-sm btn-danger" onClick={() => onDelete(lead.id)}>Delete</button>
        </div>
      </div>
    </div>
  );
}

const SOURCE_SUGGESTIONS = ['Referral', 'Walk-in', 'Phone call', 'WhatsApp', 'Social media', 'Email', 'Event', 'Other'];

function AddLead({ users, onClose, onAdded }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '', owner_id: '', source: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try { await api('/leads', { method: 'POST', body: { ...f, source: f.source.trim() || 'manual', owner_id: f.owner_id ? Number(f.owner_id) : null } }); onAdded(); }
    catch { setBusy(false); }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-header"><strong>Add lead</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <form onSubmit={submit} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input className="auth-input" placeholder="Name" value={f.name} onChange={set('name')} />
          <input className="auth-input" placeholder="Email" value={f.email} onChange={set('email')} />
          <input className="auth-input" placeholder="Phone" value={f.phone} onChange={set('phone')} />
          <textarea className="auth-input" placeholder="Enquiry / message" rows={3} value={f.message} onChange={set('message')} />
          <input className="auth-input" list="lead-source-list" placeholder="Source (e.g. Referral, Walk-in)" value={f.source} onChange={set('source')} />
          <datalist id="lead-source-list">
            {SOURCE_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
          </datalist>
          <select className="auth-input" value={f.owner_id} onChange={set('owner_id')}>
            <option value="">Assign owner (optional)</option>
            {users.filter((u) => u.role !== 'guest').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add lead'}</button>
        </form>
      </div>
    </div>
  );
}

function ManageStages({ stages, onClose, onChange }) {
  const [items, setItems] = useState(stages);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setItems(stages); }, [stages]);

  const apply = (res) => { const s = res.stages || []; setItems(s); onChange(s); };
  async function addStage(e) {
    e.preventDefault();
    if (!adding.trim() || busy) return;
    setBusy(true);
    try { apply(await api('/leads/stages', { method: 'POST', body: { label: adding.trim() } })); setAdding(''); }
    finally { setBusy(false); }
  }
  async function rename(id, label) {
    const cur = stages.find((s) => s.id === id);
    if (!label.trim() || (cur && cur.label === label.trim())) return;
    apply(await api(`/leads/stages/${id}`, { method: 'PATCH', body: { label: label.trim() } }));
  }
  async function del(stage) {
    if (items.length <= 1) return;
    if (!window.confirm(`Delete the "${stage.label}" column? Any leads in it move to the first column.`)) return;
    apply(await api(`/leads/stages/${stage.id}`, { method: 'DELETE' }));
  }
  async function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
    apply(await api('/leads/stages/reorder', { method: 'PATCH', body: { order: next.map((s) => s.id) } }));
  }
  async function setAuto(id, body) { apply(await api(`/leads/stages/${id}`, { method: 'PATCH', body })); }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header"><strong>Pipeline stages</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16 }}>
          <p className="muted" style={{ marginBottom: 12 }}>Rename, reorder, add or remove the columns on your Leads board. New leads land in the first column. Automations run when a lead enters a stage.</p>
          <div className="stage-list">
            {items.map((s, i) => (
              <div className="stage-block" key={s.id}>
                <div className="stage-row">
                  <span className="dot" style={{ background: STAGE_COLORS[i % STAGE_COLORS.length] }} />
                  <input className="auth-input stage-name" defaultValue={s.label}
                    onBlur={(e) => rename(s.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
                  <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="icon-btn" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="icon-btn" title="Delete column" disabled={items.length <= 1} onClick={() => del(s)}>✕</button>
                </div>
                <div className="stage-auto">
                  <label className="stage-auto-opt">
                    <input type="checkbox" checked={!!s.auto_task} onChange={(e) => setAuto(s.id, { auto_task: e.target.checked })} />
                    Create a follow-up task
                  </label>
                  <label className="stage-auto-opt">
                    <input type="checkbox" checked={s.auto_reminder_days != null}
                      onChange={(e) => setAuto(s.id, { auto_reminder_days: e.target.checked ? 2 : null })} />
                    Remind after
                    <input className="auth-input stage-days" type="number" min="0" max="365"
                      key={`days-${s.id}-${s.auto_reminder_days == null ? 'off' : 'on'}`}
                      defaultValue={s.auto_reminder_days ?? ''} disabled={s.auto_reminder_days == null}
                      onBlur={(e) => setAuto(s.id, { auto_reminder_days: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
                    days
                  </label>
                  <label className="stage-auto-opt">
                    Counts as
                    <select className="auth-input stage-outcome" value={s.outcome || 'open'} onChange={(e) => setAuto(s.id, { outcome: e.target.value })}>
                      <option value="open">Open</option>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={addStage} className="stage-add">
            <input className="auth-input" placeholder="New stage name" value={adding} onChange={(e) => setAdding(e.target.value)} />
            <button className="btn btn-primary" disabled={!adding.trim() || busy}>Add</button>
          </form>
        </div>
      </div>
    </div>
  );
}

function LeadSetup({ onClose }) {
  const [s, setS] = useState(null);
  const [copied, setCopied] = useState(null);
  const load = useCallback(() => { api('/leads/settings').then(setS).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  if (!s) return null;
  const url = `${window.location.origin}${s.intake_path}?key=${s.key}`;
  const php = `<?php
$data = array(
  'name'    => $_POST['name'],
  'email'   => $_POST['email'],
  'phone'   => $_POST['phone'],
  'message' => $_POST['message'],
);
$ch = curl_init(${JSON.stringify(url)});
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($data));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_exec($ch);
curl_close($ch);
?>`;
  const copy = (text, which) => { navigator.clipboard?.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 1500); };
  async function rotate() {
    if (!window.confirm('Rotate the key? Your website will stop sending leads until you update it with the new URL.')) return;
    await api('/leads/settings/key', { method: 'POST' }); load();
  }
  async function setWorkflow(id) {
    await api('/leads/settings', { method: 'PATCH', body: { task_workflow_id: id ? Number(id) : null } });
    setS({ ...s, task_workflow_id: id ? Number(id) : null });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="modal-header"><strong>Website lead setup</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16 }}>
          <p className="muted">Send your website's enquiry form to this URL and every submission lands on the Leads board. Keep the key secret.</p>

          <label className="lead-field-label">Webhook URL</label>
          <div className="lead-copyrow">
            <code className="lead-code">{url}</code>
            <button className="btn btn-sm" onClick={() => copy(url, 'url')}>{copied === 'url' ? 'Copied ✓' : 'Copy'}</button>
          </div>

          <label className="lead-field-label">Auto-create a follow-up task in</label>
          <select className="auth-input" value={s.task_workflow_id || ''} onChange={(e) => setWorkflow(e.target.value)}>
            <option value="">Don't create a task</option>
            {s.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>

          <label className="lead-field-label">PHP snippet (add to your form handler)</label>
          <div className="lead-copyrow">
            <pre className="lead-snippet">{php}</pre>
          </div>
          <button className="btn btn-sm" onClick={() => copy(php, 'php')}>{copied === 'php' ? 'Copied ✓' : 'Copy snippet'}</button>

          <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <button className="btn btn-sm btn-danger" onClick={rotate}>Rotate key</button>
            <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>Use if the key is exposed. You'll need to update the URL on your site.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
