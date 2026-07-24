/**
 * Unit test for repairRecurringDupes(): the one-time cleanup for the old
 * recurrence bug, where completing an overdue recurring task spawned a chain of
 * already-overdue clones, each raising its own rating request. The repair must
 * collapse the bug's same-day duplicate completions + duplicate rating requests
 * while leaving genuine day-by-day recurring history alone.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'teamhub-repair-'));
process.env.JWT_SECRET = 'repair-test';

const { default: db, repairRecurringDupes } = await import('../src/db.js');

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

// --- Seed ---
const ws = db.prepare('INSERT INTO workspaces (name, slug) VALUES (?, ?)').run('KNAP', 'knap').lastInsertRowid;
const kunal = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color, workspace_id, role) VALUES (?, ?, ?, ?, ?, ?)')
  .run('Kunal', 'k@x.com', 'x', '#111111', ws, 'admin').lastInsertRowid;
const anuj = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color, workspace_id, role) VALUES (?, ?, ?, ?, ?, ?)')
  .run('Anuj', 'a@x.com', 'x', '#222222', ws, 'member').lastInsertRowid;
const wf = db.prepare('INSERT INTO workflows (name, description, workspace_id) VALUES (?, ?, ?)').run('Default', '', ws).lastInsertRowid;
const todo = db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, 0)').run(wf, 'To Do', 0).lastInsertRowid;
const done = db.prepare('INSERT INTO workflow_stages (workflow_id, name, position, is_done) VALUES (?, ?, ?, 1)').run(wf, 'Done', 1).lastInsertRowid;

const insTask = db.prepare(`INSERT INTO tasks (title, workflow_id, stage_id, assignee_id, creator_id, priority, due_date, recurrence, workspace_id, status, completed_at)
  VALUES (?, ?, ?, ?, ?, 'high', ?, ?, ?, ?, ?)`);
const insRating = db.prepare(`INSERT INTO task_ratings (task_id, workspace_id, ratee_id, rater_id, role, status) VALUES (?, ?, ?, ?, 'assigner', 'pending')`);

// BUG artifacts: 5 clones of one daily series, each COMPLETED on a DIFFERENT
// day (the user hit each overdue clone on successive days) and each still
// AWAITING Kunal's rating. Plus one open future occurrence.
for (let i = 0; i < 5; i++) {
  const t = insTask.run('Tag ADT-01 GST Audit', wf, done, anuj, kunal, `2026-07-${17 + i}`, 'daily', ws, 'completed', `2026-07-2${i} 10:00:00`).lastInsertRowid;
  insRating.run(t, ws, anuj, kunal);
}
const openId = insTask.run('Tag ADT-01 GST Audit', wf, todo, anuj, kunal, '2026-07-25', 'daily', ws, 'in_progress', null).lastInsertRowid;

// GENUINE daily history: same recurring series, completed on THREE different
// days, but already RATED (status 'done') — must be preserved (not the bug).
const legit = [];
for (let d = 0; d < 3; d++) {
  const t = insTask.run('Daily standup', wf, done, anuj, kunal, `2026-07-2${d}`, 'daily', ws, 'completed', `2026-07-2${d} 09:00:00`).lastInsertRowid;
  db.prepare(`INSERT INTO task_ratings (task_id, workspace_id, ratee_id, rater_id, role, status, stars) VALUES (?, ?, ?, ?, 'assigner', 'done', 5)`).run(t, ws, anuj, kunal);
  legit.push(t);
}
const legitOpen = insTask.run('Daily standup', wf, todo, anuj, kunal, '2026-07-25', 'daily', ws, 'in_progress', null).lastInsertRowid;

// --- Run the repair ---
const r1 = repairRecurringDupes();

check('archived the 4 duplicate completions awaiting rating', r1.archived === 4);
check('collapsed 5 pending ratings down to 1', r1.dropped === 4);

const liveAdt = db.prepare(`SELECT id, status FROM tasks WHERE title = 'Tag ADT-01 GST Audit' AND archived_at IS NULL`).all();
check('one open + one completed occurrence remain for the buggy series', liveAdt.length === 2);
check('the open future occurrence is kept', liveAdt.some((t) => t.id === openId));
check('exactly one completed occurrence kept', liveAdt.filter((t) => t.status === 'completed').length === 1);

const adtRatings = db.prepare(`SELECT COUNT(*) AS n FROM task_ratings WHERE status = 'pending'`).get().n;
check('Kunal now has a single pending rating', adtRatings === 1);

// Genuine daily history untouched: all 3 completed days + the open one remain.
const liveStandup = db.prepare(`SELECT id FROM tasks WHERE title = 'Daily standup' AND archived_at IS NULL`).all();
check('genuine day-by-day recurring history is preserved', liveStandup.length === 4
  && legit.every((id) => liveStandup.some((t) => t.id === id))
  && liveStandup.some((t) => t.id === legitOpen));

// Idempotent: a second run changes nothing.
const r2 = repairRecurringDupes();
check('re-running the repair is a no-op', r2.archived === 0 && r2.dropped === 0);

rmSync(process.env.DATA_DIR, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nRepair test passed');
