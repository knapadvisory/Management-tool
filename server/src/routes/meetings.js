// Scheduled meetings: create, list, notes and invitees. The live call itself
// runs on the group call-room mesh (socket kind "meeting"); this is the plan.
import { Router } from 'express';
import db from '../db.js';
import { createNotification } from '../notifications.js';
import { publicUser } from '../auth.js';

const router = Router();
const toUTC = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' '); };

function invitees(meetingId) {
  return db.prepare(`
    SELECT u.* FROM meeting_invitees mi JOIN users u ON u.id = mi.user_id WHERE mi.meeting_id = ? ORDER BY u.name
  `).all(meetingId).map(publicUser);
}
function withPeople(m, userId) {
  return {
    ...m,
    host: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(m.host_id)),
    invitees: invitees(m.id),
    is_host: m.host_id === userId,
  };
}
// The caller must host or be invited to the meeting.
function participantMeeting(req, res) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!m) { res.status(404).json({ error: 'Meeting not found' }); return null; }
  const ok = m.host_id === req.user.id || db.prepare('SELECT 1 FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?').get(m.id, req.user.id);
  if (!ok) { res.status(403).json({ error: 'You are not on this meeting' }); return null; }
  return m;
}

// Meetings the user hosts or is invited to.
router.get('/', (req, res) => {
  const meetings = db.prepare(`
    SELECT DISTINCT m.* FROM meetings m
    LEFT JOIN meeting_invitees mi ON mi.meeting_id = m.id
    WHERE m.workspace_id = ? AND (m.host_id = ? OR mi.user_id = ?)
    ORDER BY m.scheduled_at
  `).all(req.workspaceId, req.user.id, req.user.id);
  res.json({ meetings: meetings.map((m) => withPeople(m, req.user.id)) });
});

router.get('/:id', (req, res) => {
  const m = participantMeeting(req, res);
  if (m) res.json({ meeting: withPeople(m, req.user.id) });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  const at = toUTC(b.scheduled_at);
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!at) return res.status(400).json({ error: 'A valid date and time is required' });
  const callType = b.call_type === 'audio' ? 'audio' : 'video';
  const duration = Math.max(5, Math.min(480, parseInt(b.duration_min, 10) || 30));
  const ids = Array.isArray(b.invitee_ids) ? [...new Set(b.invitee_ids.map(Number).filter(Boolean))] : [];
  const info = db.prepare(`
    INSERT INTO meetings (workspace_id, title, description, scheduled_at, duration_min, call_type, host_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.workspaceId, title, String(b.description || '').slice(0, 4000), at, duration, callType, req.user.id);
  const meetingId = info.lastInsertRowid;

  const io = req.app.get('io');
  const add = db.prepare('INSERT OR IGNORE INTO meeting_invitees (meeting_id, user_id) VALUES (?, ?)');
  for (const uid of ids) {
    if (uid === req.user.id) continue;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND deleted = 0').get(uid, req.workspaceId)) continue;
    add.run(meetingId, uid);
    createNotification(io, { user_id: uid, type: 'meeting_invite', actor_id: req.user.id, text: `Meeting invite: ${title}` });
  }
  io?.to(`workspace:${req.workspaceId}`).emit('meetings:changed');
  res.status(201).json({ meeting: withPeople(db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId), req.user.id) });
});

// Notes may be edited by any participant; the schedule only by the host.
router.patch('/:id', (req, res) => {
  const m = participantMeeting(req, res);
  if (!m) return;
  const b = req.body || {};
  const io = req.app.get('io');

  if (b.notes !== undefined) {
    db.prepare('UPDATE meetings SET notes = ? WHERE id = ?').run(String(b.notes).slice(0, 20000), m.id);
  }

  const hostOnly = ['title', 'description', 'scheduled_at', 'duration_min', 'call_type', 'status', 'invitee_ids'];
  if (hostOnly.some((k) => b[k] !== undefined)) {
    if (m.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host can change the schedule' });
    const sets = []; const vals = [];
    if (b.title !== undefined) { sets.push('title = ?'); vals.push(String(b.title).trim().slice(0, 200)); }
    if (b.description !== undefined) { sets.push('description = ?'); vals.push(String(b.description).slice(0, 4000)); }
    if (b.call_type !== undefined) { sets.push('call_type = ?'); vals.push(b.call_type === 'audio' ? 'audio' : 'video'); }
    if (b.duration_min !== undefined) { sets.push('duration_min = ?'); vals.push(Math.max(5, Math.min(480, parseInt(b.duration_min, 10) || 30))); }
    if (b.status !== undefined && ['scheduled', 'cancelled'].includes(b.status)) { sets.push('status = ?'); vals.push(b.status); }
    let rescheduled = false;
    if (b.scheduled_at !== undefined) {
      const at = toUTC(b.scheduled_at);
      if (!at) return res.status(400).json({ error: 'A valid date and time is required' });
      sets.push('scheduled_at = ?', 'reminded = 0'); vals.push(at); rescheduled = true;
    }
    if (sets.length) db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, m.id);

    if (Array.isArray(b.invitee_ids)) {
      const want = new Set(b.invitee_ids.map(Number).filter((id) => id && id !== m.host_id));
      const have = new Set(db.prepare('SELECT user_id FROM meeting_invitees WHERE meeting_id = ?').all(m.id).map((r) => r.user_id));
      for (const uid of want) if (!have.has(uid) && db.prepare('SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND deleted = 0').get(uid, req.workspaceId)) {
        db.prepare('INSERT OR IGNORE INTO meeting_invitees (meeting_id, user_id) VALUES (?, ?)').run(m.id, uid);
        createNotification(io, { user_id: uid, type: 'meeting_invite', actor_id: req.user.id, text: `Meeting invite: ${b.title || m.title}` });
      }
      for (const uid of have) if (!want.has(uid)) db.prepare('DELETE FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?').run(m.id, uid);
    }
    // Tell invitees about a reschedule or cancellation.
    if (rescheduled || b.status === 'cancelled') {
      const verb = b.status === 'cancelled' ? 'cancelled' : 'rescheduled';
      for (const u of invitees(m.id)) createNotification(io, { user_id: u.id, type: 'meeting_update', actor_id: req.user.id, text: `Meeting ${verb}: ${b.title || m.title}` });
    }
  }
  io?.to(`workspace:${req.workspaceId}`).emit('meetings:changed');
  res.json({ meeting: withPeople(db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id), req.user.id) });
});

router.delete('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!m) return res.json({ ok: true });
  if (m.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host can delete this meeting' });
  const io = req.app.get('io');
  for (const u of invitees(m.id)) createNotification(io, { user_id: u.id, type: 'meeting_update', actor_id: req.user.id, text: `Meeting cancelled: ${m.title}` });
  db.prepare('DELETE FROM meetings WHERE id = ?').run(m.id);
  io?.to(`workspace:${req.workspaceId}`).emit('meetings:changed');
  res.json({ ok: true });
});

export default router;
