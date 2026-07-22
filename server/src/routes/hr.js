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

const router = Router();

const SSO_SECRET = (process.env.TEAMHUB_SSO_SECRET || '').trim();
const API_TOKEN = (process.env.TEAMHUB_API_TOKEN || '').trim();
// Public URL the browser is redirected to for SSO.
const HR_PUBLIC_URL = (process.env.HR_URL || '').replace(/\/$/, '');
// Internal URL for server-to-server calls (defaults to the sibling container on
// the shared Docker network, so summary calls never leave the box).
const HR_INTERNAL_URL = (process.env.HR_INTERNAL_URL || 'http://teamhub-hr:8080').replace(/\/$/, '');

const ssoConfigured = () => !!(SSO_SECRET && HR_PUBLIC_URL);

// Does the client have HR available? Drives whether the nav item + widget show.
router.get('/config', (req, res) => {
  res.json({ enabled: ssoConfigured() });
});

// Mint the signed handoff token and return the HR SSO URL to open.
// Format must match SsoController in KNAP-HRMS:
//   base64url(json({email,name,exp})) "." base64url(hmac_sha256(body, secret))
router.get('/sso', (req, res) => {
  if (!ssoConfigured()) return res.status(503).json({ error: 'HR is not configured.' });
  const exp = Math.floor(Date.now() / 1000) + 120; // 2-minute window
  const body = Buffer.from(JSON.stringify({ email: req.user.email, name: req.user.name, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SSO_SECRET).update(body).digest('base64url');
  res.json({ url: `${HR_PUBLIC_URL}/sso?token=${body}.${sig}` });
});

// Proxy HR's aggregate summary for the dashboard widget. Aggregate counts only
// (headcount, on-leave, pending approvals) — never any individual's pay data.
router.get('/summary', async (req, res) => {
  if (!API_TOKEN) return res.status(503).json({ error: 'HR is not configured.' });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${HR_INTERNAL_URL}/api/summary`, {
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
