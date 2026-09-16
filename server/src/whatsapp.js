// WhatsApp Business Cloud API task bot. Linked teammates message the business
// number to create, list, complete and comment on tasks by chat; the bot replies.
// Outbound goes through the Graph API (dry-run in tests via WA_DRY_RUN).
import db from './db.js';
import { createNotification } from './notifications.js';

const GRAPH = process.env.WA_GRAPH_URL || 'https://graph.facebook.com/v21.0';
export const OUTBOX = []; // populated only under WA_DRY_RUN, for tests

export const digits = (s) => String(s || '').replace(/\D/g, '');

export async function waSend(workspace, to, text) {
  if (process.env.WA_DRY_RUN) { OUTBOX.push({ workspace_id: workspace.id, to: digits(to), text }); return; }
  if (!workspace.wa_phone_number_id || !workspace.wa_access_token) return;
  try {
    await fetch(`${GRAPH}/${workspace.wa_phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workspace.wa_access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text.slice(0, 4000) } }),
    });
  } catch { /* best-effort */ }
}

// Proactive nudge to a user's WhatsApp, if their workspace has the bot on and
// they've linked a number. Meta only allows free-form text within 24h of their
// last message; outside that it silently no-ops (needs a template).
export function waNotify(workspaceId, userId, text) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws || !ws.wa_enabled) return;
  const u = db.prepare('SELECT whatsapp_number FROM users WHERE id = ?').get(userId);
  if (u?.whatsapp_number) waSend(ws, u.whatsapp_number, text);
}

// ---- Command parsing ----
const HELP = [
  '🤖 *TeamHub bot* — try:',
  '• *task* Call Sharma about GST tomorrow @ravi',
  '• *my tasks* — your open tasks',
  '• *today* — due today / overdue',
  '• *done 142* — complete a task',
  '• *note 142* client sent the docs',
].join('\n');

function parseDue(text) {
  const t = text.toLowerCase();
  const today = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d); };
  let due = null; let clean = text;
  const on = t.match(/\bon (\d{4}-\d{2}-\d{2})\b/);
  if (on) { due = on[1]; clean = clean.replace(new RegExp(`on ${on[1]}`, 'i'), ''); }
  else if (/\btomorrow\b/.test(t)) { due = plus(1); clean = clean.replace(/\btomorrow\b/i, ''); }
  else if (/\btoday\b/.test(t)) { due = plus(0); clean = clean.replace(/\btoday\b/i, ''); }
  else if (/\bnext week\b/.test(t)) { due = plus(7); clean = clean.replace(/\bnext week\b/i, ''); }
  else {
    const inN = t.match(/\bin (\d{1,3}) days?\b/);
    if (inN) { due = plus(parseInt(inN[1], 10)); clean = clean.replace(inN[0], ''); }
  }
  return { due, clean };
}

function resolveAssignee(workspaceId, text, fallbackId) {
  const m = text.match(/@([a-z0-9._-]+)/i);
  let clean = text; let assignee = fallbackId;
  if (m) {
    const q = m[1].toLowerCase();
    const u = db.prepare(`SELECT id FROM users WHERE workspace_id = ? AND deleted = 0 AND role != 'guest' AND LOWER(REPLACE(name,' ','')) LIKE ? ORDER BY id LIMIT 1`).get(workspaceId, q + '%')
      || db.prepare(`SELECT id FROM users WHERE workspace_id = ? AND deleted = 0 AND role != 'guest' AND LOWER(name) LIKE ? ORDER BY id LIMIT 1`).get(workspaceId, '%' + q + '%');
    if (u) assignee = u.id;
    clean = clean.replace(m[0], '');
  }
  return { assignee, clean };
}

function firstStage(workspaceId, workspace) {
  const wfId = workspace.wa_task_workflow_id || workspace.leads_task_workflow_id
    || db.prepare('SELECT id FROM workflows WHERE workspace_id = ? ORDER BY id LIMIT 1').get(workspaceId)?.id;
  if (!wfId) return null;
  const stage = db.prepare('SELECT id FROM workflow_stages WHERE workflow_id = ? ORDER BY position LIMIT 1').get(wfId);
  return stage ? { wfId, stageId: stage.id } : null;
}

function createBotTask(io, workspace, creator, { title, assigneeId, due, priority }) {
  const sg = firstStage(workspace.id, workspace);
  if (!sg) return { error: 'No task board is set up yet. Ask an admin to create one.' };
  const info = db.prepare(`
    INSERT INTO tasks (title, description, workflow_id, stage_id, assignee_id, creator_id, assignor_id, priority, due_date, workspace_id)
    VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, sg.wfId, sg.stageId, assigneeId || null, creator.id, creator.id, priority || 'medium', due || null, workspace.id);
  const id = info.lastInsertRowid;
  if (assigneeId) {
    db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, assigneeId);
    db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(id, assigneeId);
  }
  db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(id, creator.id);
  db.prepare('INSERT INTO task_activity (task_id, user_id, action) VALUES (?, ?, ?)').run(id, creator.id, 'created this task via WhatsApp');
  if (assigneeId && assigneeId !== creator.id) {
    createNotification(io, { user_id: assigneeId, type: 'task_assigned', actor_id: creator.id, task_id: id, text: `${creator.name} assigned you “${title}”` });
    waNotify(workspace.id, assigneeId, `📌 New task assigned by ${creator.name}: “${title}”${due ? ` (due ${due})` : ''} — reply *done ${id}* when finished.`);
  }
  io?.to(`workspace:${workspace.id}`).emit('tasks:changed');
  return { id, assigneeId, due };
}

function listMyTasks(workspace, user, onlyToday) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT DISTINCT t.id, t.title, t.due_date, t.priority
    FROM tasks t LEFT JOIN task_assignees ta ON ta.task_id = t.id
    WHERE t.workspace_id = ? AND (t.assignee_id = ? OR ta.user_id = ?)
      AND t.status NOT IN ('completed','cancelled')
      ${onlyToday ? "AND t.due_date IS NOT NULL AND t.due_date <= ?" : ''}
    ORDER BY t.due_date IS NULL, t.due_date LIMIT 15
  `).all(...(onlyToday ? [workspace.id, user.id, user.id, today] : [workspace.id, user.id, user.id]));
  if (!rows.length) return onlyToday ? '✅ Nothing due today. Nice.' : '✅ You have no open tasks.';
  const line = (t) => `• *${t.id}* ${t.title}${t.due_date ? ` — ${t.due_date <= today ? '⚠️ ' : ''}${t.due_date}` : ''}`;
  return `${onlyToday ? '📅 Due today / overdue' : '🗂 Your open tasks'} (${rows.length}):\n` + rows.map(line).join('\n');
}

function loadOwnTask(workspace, user, id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(id, workspace.id);
  if (!t) return null;
  const mine = t.assignee_id === user.id || t.creator_id === user.id
    || db.prepare('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?').get(t.id, user.id);
  return mine ? t : 'forbidden';
}

// Turn one inbound text into a reply. Returns a string to send back.
export function handleCommand(io, workspace, user, textRaw) {
  const text = String(textRaw || '').trim();
  const lower = text.toLowerCase();

  if (/^(hi|hello|hey|help|menu|start)\b/.test(lower) || !text) return HELP;

  if (/^(task|add|new)\b/i.test(text)) {
    let body = text.replace(/^(task|add|new)\b[:\s]*/i, '');
    const a = resolveAssignee(workspace.id, body, user.id); body = a.clean;
    const d = parseDue(body); body = d.clean;
    let priority = 'medium';
    if (/\b(urgent|asap)\b/i.test(body)) { priority = 'urgent'; body = body.replace(/\b(urgent|asap)\b/i, ''); }
    else if (/\bhigh\b/i.test(body)) { priority = 'high'; body = body.replace(/\bhigh\b/i, ''); }
    const title = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) return 'What is the task? e.g. *task Call Sharma tomorrow @ravi*';
    const res = createBotTask(io, workspace, user, { title, assigneeId: a.assignee, due: d.due, priority });
    if (res.error) return res.error;
    const who = res.assigneeId && res.assigneeId !== user.id ? db.prepare('SELECT name FROM users WHERE id = ?').get(res.assigneeId)?.name : 'you';
    return `✅ Task *${res.id}* created — “${title}”\nAssigned to ${who}${res.due ? `, due ${res.due}` : ''}.`;
  }

  if (/^(my tasks|tasks|list|pending)\b/i.test(lower)) return listMyTasks(workspace, user, false);
  if (/^(today|due)\b/i.test(lower)) return listMyTasks(workspace, user, true);

  const done = lower.match(/^(done|complete|finish)\s+#?(\d+)/);
  if (done) {
    const t = loadOwnTask(workspace, user, Number(done[2]));
    if (!t) return `Couldn't find task ${done[2]}.`;
    if (t === 'forbidden') return `Task ${done[2]} isn't assigned to you.`;
    db.prepare("UPDATE tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(t.id);
    db.prepare('INSERT INTO task_activity (task_id, user_id, action) VALUES (?, ?, ?)').run(t.id, user.id, 'completed this task via WhatsApp');
    io?.to(`workspace:${workspace.id}`).emit('tasks:changed');
    if (t.creator_id && t.creator_id !== user.id) waNotify(workspace.id, t.creator_id, `✅ ${user.name} completed task ${t.id}: “${t.title}”`);
    return `✅ Marked task *${t.id}* done — “${t.title}”. Great work!`;
  }

  const note = text.match(/^(note|comment)\s+#?(\d+)\s+([\s\S]+)/i);
  if (note) {
    const t = loadOwnTask(workspace, user, Number(note[2]));
    if (!t) return `Couldn't find task ${note[2]}.`;
    if (t === 'forbidden') return `Task ${note[2]} isn't one of yours.`;
    db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)').run(t.id, user.id, note[3].trim().slice(0, 4000));
    db.prepare('INSERT INTO task_activity (task_id, user_id, action) VALUES (?, ?, ?)').run(t.id, user.id, 'commented via WhatsApp');
    io?.to(`workspace:${workspace.id}`).emit('tasks:changed');
    return `📝 Added your note to task *${t.id}*.`;
  }

  return `I didn't catch that.\n\n${HELP}`;
}

// ---- Webhook payload handling ----
// Find the workspace whose business number received this event.
export function workspaceForPhoneNumberId(pnid) {
  return pnid ? db.prepare('SELECT * FROM workspaces WHERE wa_phone_number_id = ? AND wa_enabled = 1').get(String(pnid)) : null;
}

export async function processInbound(io, body) {
  const entries = body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const pnid = value.metadata?.phone_number_id;
      const workspace = workspaceForPhoneNumberId(pnid);
      if (!workspace) continue;
      for (const msg of value.messages || []) {
        if (msg.type !== 'text') continue;
        if (db.prepare('SELECT 1 FROM wa_seen WHERE message_id = ?').get(msg.id)) continue;
        db.prepare('INSERT OR IGNORE INTO wa_seen (message_id) VALUES (?)').run(msg.id);
        const from = digits(msg.from);
        const user = db.prepare("SELECT * FROM users WHERE workspace_id = ? AND deleted = 0 AND whatsapp_number IS NOT NULL AND REPLACE(REPLACE(whatsapp_number,'+',''),' ','') = ?").get(workspace.id, from);
        if (!user) {
          await waSend(workspace, from, 'This number isn’t linked to a TeamHub account. Ask your admin to add it to your profile.');
          continue;
        }
        const reply = handleCommand(io, workspace, user, msg.text?.body || '');
        await waSend(workspace, from, reply);
      }
    }
  }
}
