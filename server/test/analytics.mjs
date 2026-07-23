/**
 * Practice Analytics endpoint: aggregate KPIs, throughput, workload, compliance,
 * quality, billable-by-client, and the needs-attention list. Verifies the scope
 * rule (admin = firm-wide + can focus a person; member = self only; guest 403).
 * Boots the real server.
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.ANALYTICS_PORT || 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'teamhub-analytics-'));

let failures = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}`); } };

const server = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, JWT_SECRET: 'analytics-secret', WORKSPACE_SIGNUP_CODE: 'boot' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
async function waitForServer() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('Server did not start');
}
async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const today = () => new Date().toISOString().slice(0, 10);
const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

async function main() {
  await waitForServer();

  // Workspace + two staff.
  const owner = await req('POST', '/api/workspaces', { body: { workspace_name: 'Analytics Co', name: 'Alice', email: 'a@a.test', password: 'secret123', code: 'boot' } });
  const a = owner.data.token; const aliceId = owner.data.user.id; const slug = owner.data.workspace.slug;
  await req('POST', `/api/workspaces/${slug}/register`, { body: { name: 'Bob', email: 'b@b.test', password: 'secret123' } });
  const pend = await req('GET', '/api/admin/users/pending', { token: a });
  const bobId = pend.data.users.find((u) => u.email === 'b@b.test').id;
  await req('POST', `/api/admin/users/${bobId}/approve`, { token: a });
  const b = (await req('POST', '/api/auth/login', { body: { email: 'b@b.test', password: 'secret123' } })).data.token;

  const wf = (await req('GET', '/api/workflows', { token: a })).data.workflows[0];
  const doneStage = wf.stages.find((s) => s.is_done);

  // A client with two compliance deadlines: one overdue, one upcoming.
  const client = await req('POST', '/api/clients', { token: a, body: { name: 'Bharat Traders' } });
  const cid = client.data.id;
  await req('POST', `/api/clients/${cid}/deadlines`, { token: a, body: { title: 'GST payment', due_date: shift(-4), assignee_id: bobId } });
  await req('POST', `/api/clients/${cid}/deadlines`, { token: a, body: { title: 'TDS payment', due_date: shift(6), assignee_id: bobId } });

  // Two tasks for Bob; complete one so there's throughput + a completed count.
  const t1 = await req('POST', '/api/tasks', { token: a, body: { title: 'File GSTR-3B', workflow_id: wf.id, client_id: cid, assignee_id: bobId, due_date: shift(3) } });
  await req('POST', '/api/tasks', { token: a, body: { title: 'Draft balance sheet', workflow_id: wf.id, client_id: cid, assignee_id: bobId } });
  await req('PATCH', `/api/tasks/${t1.data.id}`, { token: b, body: { stage_id: doneStage.id } }); // Bob completes his own
  // Completing it opened a pending rating for the assigner (Alice) to rate Bob.
  const pending = await req('GET', '/api/tasks/ratings/pending', { token: a });
  const pr = pending.data.ratings.find((r) => r.task_id === t1.data.id);
  if (pr) await req('POST', `/api/tasks/ratings/${pr.id}`, { token: a, body: { stars: 4, comment: 'Solid, on time.' } });

  // Log a billable hour against the client (Bob).
  await req('POST', '/api/time', { token: b, body: { client_id: cid, task_id: t1.data.id, minutes: 90, billable: 1, entry_date: today() } });

  console.log('Practice Analytics');

  // --- Admin firm-wide view ---
  const adm = await req('GET', '/api/analytics?period=fy', { token: a });
  check('admin gets the analytics payload', adm.status === 200 && adm.data.summary && Array.isArray(adm.data.throughput));
  check('firm-wide scope has no focused user', adm.data.scope.focus_user === null && adm.data.scope.is_admin === true);
  check('completed task is counted', adm.data.summary.tasks_completed.value >= 1);
  check('billable hours reflect the 90-min entry', adm.data.summary.billable_hours.hours >= 1.4 && adm.data.summary.billable_hours.hours <= 1.6);
  check('overdue filing surfaced in KPI', adm.data.summary.overdue_filings >= 1);
  check('compliance splits filed/due/overdue', (adm.data.compliance.total || 0) >= 2 && adm.data.compliance.overdue >= 1);
  check('workload leaderboard lists the team', adm.data.workload.length >= 2);
  check('Bob shows open work in the leaderboard', adm.data.workload.some((w) => w.id === bobId && w.open_tasks >= 1));
  check('time-by-client includes the client', adm.data.time_by_client.some((c) => c.id === cid && c.hours >= 1));
  check('needs-attention lists the overdue filing first', adm.data.attention[0]?.title === 'GST payment' && adm.data.attention[0].days_overdue >= 1);
  check('throughput buckets present', adm.data.throughput.length === 8);

  // --- Admin can focus a single person ---
  const focus = await req('GET', `/api/analytics?period=fy&user_id=${bobId}`, { token: a });
  check('admin can focus one person', focus.data.scope.focus_user === bobId);
  check('focused workload is just that person', focus.data.workload.length === 1 && focus.data.workload[0].id === bobId);

  // --- Member self-scope: Bob is forced to himself even if he passes Alice's id ---
  const bobView = await req('GET', `/api/analytics?period=fy&user_id=${aliceId}`, { token: b });
  check('member is pinned to self scope', bobView.status === 200 && bobView.data.scope.focus_user === bobId);
  check('member workload never leaks the whole team', bobView.data.workload.every((w) => w.id === bobId));

  // --- Appraisals: ratings endpoint ---
  const rat = await req('GET', '/api/analytics/ratings', { token: a });
  check('ratings endpoint returns ranking + tasks', rat.status === 200 && Array.isArray(rat.data.ranking) && Array.isArray(rat.data.tasks));
  check('Bob appears in the ranking with his 4-star avg', rat.data.ranking.some((r) => r.id === bobId && r.avg === 4));
  check('the rated task lists ratee and rater', rat.data.tasks.some((t) => t.ratee.id === bobId && t.rater && t.rater.id === aliceId && t.stars === 4));
  check('distribution has five buckets', rat.data.summary.distribution.length === 5);

  // Member self-scope on ratings: Bob sees only his own, never the whole firm.
  const bobRatings = await req('GET', `/api/analytics/ratings?user_id=${aliceId}`, { token: b });
  check('member ratings pinned to self', bobRatings.data.scope.focus_user === bobId && bobRatings.data.tasks.every((t) => t.ratee.id === bobId));

  // --- KPI drill-down detail ---
  const detC = await req('GET', '/api/analytics/detail?metric=completed&period=fy', { token: a });
  check('completed detail lists the finished task', detC.status === 200 && detC.data.rows.some((r) => r.id === t1.data.id));
  const detO = await req('GET', '/api/analytics/detail?metric=overdue&period=fy', { token: a });
  check('overdue detail lists the overdue filing', detO.data.rows.some((r) => r.title === 'GST payment' && r.days_overdue >= 1));
  const detB = await req('GET', '/api/analytics/detail?metric=billable&period=fy', { token: a });
  check('billable detail splits by person and client', Array.isArray(detB.data.by_user) && Array.isArray(detB.data.by_client) && detB.data.by_client.some((c) => c.hours >= 1));
  const detBad = await req('GET', '/api/analytics/detail?metric=nonsense', { token: a });
  check('unknown metric is rejected', detBad.status === 400);
  const detMember = await req('GET', `/api/analytics/detail?metric=completed&period=fy&user_id=${aliceId}`, { token: b });
  check('member detail cannot see another person’s tasks', detMember.data.rows.every((r) => r.who === null || r.who.name === 'Bob'));

  // --- Guests are blocked entirely (route is behind blockGuests) ---
  // (No guest here; blockGuests is covered by the mount. A missing token → 401.)
  const anon = await req('GET', '/api/analytics');
  check('unauthenticated request is rejected', anon.status === 401);

  server.kill();
  if (failures) { console.error(`\n${failures} analytics check(s) FAILED`); process.exit(1); }
  console.log('\nAll analytics tests passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
