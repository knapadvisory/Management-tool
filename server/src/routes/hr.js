// Bridge to the KNAP-HRMS app (a separate Laravel service on hr.<domain>).
//
// Two jobs:
//  • /sso     — mint a short-lived signed token so a logged-in TeamHub user is
//               handed straight into HR without a second login.
//  • /summary — proxy HR's read-only aggregate numbers for the dashboard widget
//               (server-to-server, using a shared API token).
//
// HR is optional: if the shared secrets/URL aren't configured, /config reports
// disabled and the client hides the HR nav + widget.
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { requireAdmin } from '../auth.js';

const router = Router();

const SSO_SECRET = (process.env.TEAMHUB_SSO_SECRET || '').trim();
const API_TOKEN = (process.env.TEAMHUB_API_TOKEN || '').trim();
// Public URL the browser is redirected to for SSO.
const HR_PUBLIC_URL = (process.env.HR_URL || '').replace(/\/$/, '');
// Internal URL for server-to-server calls (defaults to the sibling container on
// the shared Docker network, so summary calls never leave the box).
const HR_INTERNAL_URL = (process.env.HR_INTERNAL_URL || 'http://teamhub-hr:8080').replace(/\/$/, '');

const ssoConfigured = () => !!(SSO_SECRET && HR_PUBLIC_URL);

// Push a workspace's active roster to HR so every member exists as an HR
// employee in that workspace's home company (and leavers get reconciled). Runs
// server-to-server with the shared API token; safe to call fire-and-forget —
// it never throws and returns a boolean so callers can log if they care.
// Only ACTIVE, approved, non-guest members are sent; HR marks anyone missing
// from the list as exited, so deactivating or removing a member syncs too.
export async function pushRoster(workspaceId) {
  if (!API_TOKEN) return false; // HR not wired up on this server
  try {
    const ws = db.prepare('SELECT slug, name FROM workspaces WHERE id = ?').get(workspaceId);
    if (!ws) return false;
    const members = db.prepare(
      `SELECT id, name, email, created_at FROM users
       WHERE workspace_id = ? AND role != 'guest' AND approved = 1 AND active = 1 AND deleted = 0`,
    ).all(workspaceId);
    const employees = members.map((m) => ({
      teamhub_user_id: m.id,
      name: m.name,
      email: m.email,
      joined_at: m.created_at,
      active: true,
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${HR_INTERNAL_URL}/api/roster`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ws: ws.slug || String(workspaceId), wsname: ws.name || '', employees }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return r.ok;
  } catch {
    return false; // HR down / not reachable — never block the caller
  }
}

// Does the client have HR available? Drives whether the nav item + widget show.
router.get('/config', (req, res) => {
  res.json({ enabled: ssoConfigured() });
});

// Mint the signed handoff token and return the HR SSO URL to open.
// Format must match SsoController in KNAP-HRMS:
//   base64url(json({email,name,exp,ws,wsname,role})) "." base64url(hmac_sha256(body, secret))
// ws/wsname identify the caller's workspace so HR isolates each workspace into
// its own tenant (a KNAP admin only sees KNAP; a Pravaah admin only sees Pravaah).
router.get('/sso', (req, res) => {
  if (!ssoConfigured()) return res.status(503).json({ error: 'HR is not configured.' });
  const ws = db.prepare('SELECT slug, name FROM workspaces WHERE id = ?').get(req.user.workspace_id) || {};
  const exp = Math.floor(Date.now() / 1000) + 120; // 2-minute window
  const claims = {
    email: req.user.email, name: req.user.name, exp,
    ws: ws.slug || String(req.user.workspace_id), wsname: ws.name || '', role: req.user.role || 'admin',
    uid: req.user.id, // lets HR link the person to their own employee record
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', SSO_SECRET).update(body).digest('base64url');
  // Bring HR's roster up to date before the admin lands there (auto-provisions
  // the workspace's members on first open, keeps it current afterwards).
  pushRoster(req.user.workspace_id);
  res.json({ url: `${HR_PUBLIC_URL}/sso?token=${body}.${sig}` });
});

// Proxy HR's aggregate summary for the dashboard widget. Aggregate counts only
// (headcount, on-leave, pending approvals) — never any individual's pay data.
// Admin-only: the firm-wide widget is for admins; members see their own portal.
router.get('/summary', requireAdmin, async (req, res) => {
  if (!API_TOKEN) return res.status(503).json({ error: 'HR is not configured.' });
  try {
    const ws = db.prepare('SELECT slug FROM workspaces WHERE id = ?').get(req.user.workspace_id)?.slug || String(req.user.workspace_id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${HR_INTERNAL_URL}/api/summary?ws=${encodeURIComponent(ws)}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return res.status(502).json({ error: 'HR is unavailable right now.' });
    res.json(await r.json());
  } catch {
    res.status(502).json({ error: 'HR is unavailable right now.' });
  }
});

export default router;
