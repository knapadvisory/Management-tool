// Lead creation + the two automations the team asked for: auto-create a
// follow-up task, and notify admins. Shared by the public intake endpoint and
// the authenticated "add lead" action.
import db from './db.js';
import { createNotification } from './notifications.js';
import { firstStageKey } from './leadStages.js';

export function createLead(workspaceId, data = {}) {
  const { name = '', email = '', phone = '', message = '', source = 'manual', owner_id = null, ip = '',
    page_url = '', referrer = '', utm_source = '', utm_medium = '', utm_campaign = '' } = data;
  const status = firstStageKey(workspaceId);
  const s = (v, n = 300) => String(v || '').slice(0, n);
  const info = db.prepare(`
    INSERT INTO leads (workspace_id, name, email, phone, message, source, status, owner_id, ip,
      page_url, referrer, utm_source, utm_medium, utm_campaign)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, name.trim(), email.trim(), phone.trim(), message.trim(), source, status, owner_id, s(ip, 60),
    s(page_url, 500), s(referrer, 500), s(utm_source, 100), s(utm_medium, 100), s(utm_campaign, 150));
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid);
}

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/**
 * Auto-create a task when a lead enters a stage, following that stage's designed
 * rule (title, description, board, assignee, priority, due date). Falls back to a
 * generic "<stage>: <lead>" follow-up on the workspace's default leads board when
 * a rule field is left blank. `pipelineStage` is the lead_stages row (optional —
 * absent for the intake follow-up, which uses the defaults). `io` lets us notify.
 */
export function autoCreateFollowupTask(workspace, lead, { titlePrefix = 'Follow up', pipelineStage = null, io = null } = {}) {
  // Which board the task lands on: the stage's chosen board, else the workspace default.
  const wfId = (pipelineStage && pipelineStage.auto_task_workflow_id) || workspace.leads_task_workflow_id;
  if (!wfId) return null;
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND workspace_id = ?').get(wfId, workspace.id);
  if (!wf) return null;
  const stage = db.prepare('SELECT id FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wfId);
  if (!stage) return null;
  const creator = db.prepare("SELECT id FROM users WHERE workspace_id = ? AND role = 'admin' AND deleted = 0 ORDER BY id LIMIT 1").get(workspace.id);
  if (!creator) return null;

  const who = lead.name || lead.email || lead.phone || 'new enquiry';
  const configuredTitle = (pipelineStage && pipelineStage.auto_task_title || '').trim();
  const title = (configuredTitle ? `${configuredTitle} — ${who}` : `${titlePrefix}: ${who}`).slice(0, 200);
  const desc = [
    (pipelineStage && pipelineStage.auto_task_desc || '').trim() || null,
    lead.email && `Email: ${lead.email}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.message && `\n${lead.message}`,
  ].filter(Boolean).join('\n');
  // Assignee: the stage's named person (if still in the workspace), else the lead owner.
  let assigneeId = pipelineStage && pipelineStage.auto_task_assignee_id;
  if (assigneeId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND deleted = 0').get(assigneeId, workspace.id)) assigneeId = null;
  if (!assigneeId) assigneeId = lead.owner_id || null;
  const priority = PRIORITIES.includes(pipelineStage && pipelineStage.auto_task_priority) ? pipelineStage.auto_task_priority : 'high';
  const dueDays = pipelineStage && Number.isInteger(pipelineStage.auto_task_due_days) ? pipelineStage.auto_task_due_days : 2;
  const due = new Date(Date.now() + Math.max(0, dueDays) * 86400000).toISOString().slice(0, 10);

  const info = db.prepare(
    'INSERT INTO tasks (title, description, workflow_id, stage_id, assignee_id, creator_id, assignor_id, priority, due_date, lead_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(title, desc, wfId, stage.id, assigneeId, creator.id, creator.id, priority, due, lead.id, workspace.id);
  const taskId = info.lastInsertRowid;
  // Make the assignee a real assignee + watcher so the task shows on their board.
  if (assigneeId) {
    db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(taskId, assigneeId);
    db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, assigneeId);
    if (io) createNotification(io, { user_id: assigneeId, type: 'task_assigned', actor_id: creator.id, task_id: taskId, text: `New task from the lead funnel: "${title}"` });
  }
  // Point the lead at its most recent auto-task (every task it spawned is still
  // findable via the lead's task list); keeps the board's "open task" fresh.
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
    fired.taskId = autoCreateFollowupTask(workspace, lead, { titlePrefix: `${stage.label}`, pipelineStage: stage, io });
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
