import nodemailer from 'nodemailer';

// Email is optional. Configure SMTP via env to turn it on:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
//   SMTP_SECURE (true for port 465), SMTP_FROM ("TeamHub <no-reply@you.com>")
// Without SMTP_HOST the app runs normally, just without outbound email.
// EMAIL_TEST_MODE captures messages instead of sending (used by tests).
let transporter = null;
let mode = 'disabled';

if (process.env.SMTP_HOST) {
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  mode = 'smtp';
  console.log(`[email] SMTP configured (${process.env.SMTP_HOST}:${port})`);
} else if (process.env.EMAIL_TEST_MODE) {
  transporter = nodemailer.createTransport({ jsonTransport: true });
  mode = 'test';
} else {
  console.log('[email] disabled (set SMTP_HOST to enable outbound email)');
}

export function emailEnabled() { return mode !== 'disabled'; }
export function emailFrom() { return process.env.SMTP_FROM || process.env.SMTP_USER || 'TeamHub <no-reply@teamhub.local>'; }

// Best-effort send. Never throws — a mail failure must not break the request.
export async function sendMail({ to, subject, html, text }) {
  if (!transporter || !to) return false;
  try {
    await transporter.sendMail({ from: emailFrom(), to, subject, html, text: text || stripHtml(html) });
    return true;
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return false;
  }
}

function stripHtml(html = '') {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// A simple, consistent HTML wrapper for all TeamHub emails.
export function layout(title, bodyHtml) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1d1c1d">
    <div style="font-weight:800;font-size:20px;padding:8px 0 16px">✓ TeamHub</div>
    <div style="background:#fff;border:1px solid #e4e6ec;border-radius:12px;padding:24px">
      <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>
      ${bodyHtml}
    </div>
    <p style="color:#8a8f98;font-size:12px;margin-top:16px">Sent by TeamHub. If you didn't expect this email, you can ignore it.</p>
  </div>`;
}

export function button(url, label) {
  return `<p style="margin:18px 0"><a href="${url}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${label}</a></p>
  <p style="color:#8a8f98;font-size:12px;word-break:break-all">Or paste this link: ${url}</p>`;
}
