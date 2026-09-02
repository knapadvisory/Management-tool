// Lead creation + the two automations the team asked for: auto-create a
// follow-up task, and notify admins. Shared by the public intake endpoint and
// the authenticated "add lead" action.
import db from './db.js';
import { createNotification } from './notifications.js';
import { firstStageKey } from './leadStages.js';

export function createLead(workspaceId, { name = '', email = '', phone = '', message = '', source = 'manual', owner_id = null }) {
  const status = firstStageKey(workspaceId);
  const info = db.prepare(
    'INSERT INTO leads (workspace_id, name, email, phone, message, source, status, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(workspaceId, name.trim(), email.trim(), phone.trim(), message.trim(), source, status, owner_id);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid);
}

/** Auto-create a follow-up task in the workspace's configured leads workflow. */
export function autoCreateFollowupTask(workspace, lead, { titlePrefix = 'Follow up' } = {}) {
  const wfId = workspace.leads_task_workflow_id;
  if (!wfId) return null;
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND workspace_id = ?').get(wfId, workspace.id);
  if (!wf) return null;
  const stage = db.prepare('SELECT id FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wfId);
  if (!stage) return null;
  const creator = db.prepare("SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND deleted = 0 ORDER BY id LIMIT 1").get(workspace.id);
  if (!creator) return null;

  const who = lead.name || lead.email || lead.phone || 'new enquiry';
  const desc = [
    lead.email && `Email: ${lead.email}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.message && `\n${lead.message}`,
  ].filter(Boolean).join('\n');
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

  const info = db.prepare(
    "INSERT INTO tasks (title, description, workflow_id, stage_id, assignee_id, creator_id, priority, due_date, lead_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, 'high', ?, ?, ?)",
  ).run(`${titlePrefix}: ${who}`, desc, wfId, stage.id, lead.owner_id || null, creator.id, due, lead.id, workspace.id);
  const taskId = info.lastInsertRowid;
  db.prepare('UPDATE leads SET task_id = ? WHERE id = ?').run(taskId, lead.id);
  return taskId;
}

/**
 * Run a stage's automations when a lead enters it: optionally create a follow-up
 * task and/or schedule a reminder N days out. `actorId` is who moved the lead
 * (they and the owner get the reminder). Returns what fired.
 */
export function runStageAutomations(io, workspace, lead, stage, actorId = null) {
  const fired = { taskId: null, reminderId: null };
  if (!stage) return fired;

  if (stage.auto_task) {
    fired.taskId = autoCreateFollowupTask(workspace, lead, { titlePrefix: `${stage.label}` });
  }
  if (stage.auto_reminder_days != null) {
    const at = new Date(Date.now() + Number(stage.auto_reminder_days) * 86400000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const uid = lead.owner_id || actorId || null;
    const info = db.prepare(
      'INSERT INTO lead_reminders (workspace_id, lead_id, user_id, remind_at, note) VALUES (?, ?, ?, ?, ?)',
    ).run(workspace.id, lead.id, uid, at, `Follow up — ${stage.label}`);
    fired.reminderId = info.lastInsertRowid;
  }
  if (fired.taskId || fired.reminderId) io?.to(`workspace:${workspace.id}`).emit('leads:changed');
  return fired;
}

export function notifyNewLead(io, workspace, lead, taskId = null) {
  // Admins and Sales both work the whole pipeline, so both hear about new leads.
  const recipients = db.prepare(
    "SELECT id FROM users WHERE workspace_id = ? AND role IN ('admin', 'sales') AND deleted = 0 AND active = 1",
  ).all(workspace.id);
  // The assigned owner should also know, even if they are a plain member.
  if (lead.owner_id && !recipients.some((r) => r.id === lead.owner_id)) recipients.push({ id: lead.owner_id });
  const who = lead.name || lead.email || 'enquiry';
  const text = `New lead: ${who}${lead.message ? ` — ${lead.message.slice(0, 90)}` : ''}`;
  for (const a of recipients) {
    createNotification(io, { user_id: a.id, type: 'lead', task_id: taskId, text });
    io?.to(`user:${a.id}`).emit('leads:changed');
  }
}

/** Full pipeline: create the lead, run both automations, return the lead + task id. */
export function intakeLead(io, workspace, data) {
  const lead = createLead(workspace.id, data);
  const taskId = autoCreateFollowupTask(workspace, lead);
  notifyNewLead(io, workspace, lead, taskId);
  return { lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id), taskId };
}
