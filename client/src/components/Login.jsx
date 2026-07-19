import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// Highlights shown on the public landing page.
const FEATURES = [
  { icon: '🗂️', title: 'Tasks & boards', desc: 'Assign work, set deadlines and priorities, and track everything from To-Do to Done.' },
  { icon: '💬', title: 'Team chat', desc: 'Channels and direct messages keep conversations organised, searchable and in one place.' },
  { icon: '🏢', title: 'Clients & compliance', desc: 'A 360° view of every client, with filings and due-dates tracked so nothing slips.' },
  { icon: '📁', title: 'Shared drive', desc: 'Upload, preview and share files with your team — no more email attachments.' },
  { icon: '📞', title: 'Audio & video calls', desc: 'Start a one-to-one or group call with your team right inside the workspace.' },
  { icon: '📊', title: 'Live dashboard', desc: 'Open work, overdue tasks and what closed this month — all at a glance.' },
];

// Public entry point / homepage. Three views:
//  - home:   a simple landing with "Register your company" and "Sign in".
//  - create: register a new company (needs a code from KNAP) → become its admin.
//  - login:  sign in with email + password (derives the workspace).
export default function Login({ onAuth }) {
  const [mode, setMode] = useState('home'); // 'home' | 'login' | 'create'
  const [form, setForm] = useState({ workspace_name: '', name: '', email: '', password: '', code: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);

  useEffect(() => { api('/config').then((c) => setEmailEnabled(!!c.email_enabled)).catch(() => {}); }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      const data = mode === 'login'
        ? await api('/auth/login', { method: 'POST', body: { email: form.email, password: form.password } })
        : await api('/workspaces', { method: 'POST', body: form });
      onAuth(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function forgot() {
    setError(null); setNotice(null);
    if (!emailEnabled) {
      setNotice('To reset your password, ask your workspace admin — they can set a new one for you from the Admin panel.');
      return;
    }
    if (!form.email.trim()) { setError('Enter your email above, then click “Forgot Password”.'); return; }
    try {
      await api('/auth/forgot', { method: 'POST', body: { email: form.email } });
      setNotice('If that email is registered, we’ve sent a reset link. Check your inbox (and spam).');
    } catch { setNotice('If that email is registered, we’ve sent a reset link.'); }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const go = (m) => { setMode(m); setError(null); setNotice(null); };

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div>
        <div className="auth-topbar-right">
          {mode === 'home' ? (
            <button className="auth-topbtn" onClick={() => go('login')}>Sign In</button>
          ) : (
            <button className="auth-topbtn" onClick={() => go('home')}>← Home</button>
          )}
        </div>
      </header>

      <main className={`auth-main ${mode === 'home' ? 'is-landing' : ''}`}>
        {mode === 'home' ? (
          <div className="landing">
            <section className="landing-hero">
              <span className="landing-eyebrow">KNAP Advisory · Team workspace</span>
              <h1 className="landing-title">Your firm's work, chat &amp; clients — in one place</h1>
              <p className="landing-sub">
                TeamHub gives your company a private workspace: assign and track tasks, message your
                team, manage clients and compliance, share files, and jump on calls — without juggling
                five different apps.
              </p>
              <div className="landing-actions">
                <button className="landing-primary" onClick={() => go('create')}>Register your company</button>
                <button className="landing-secondary" onClick={() => go('login')}>Sign in</button>
              </div>
              <p className="landing-note muted">New companies need a registration code from KNAP. Employees join with a link from their admin.</p>
            </section>

            <section className="landing-features">
              {FEATURES.map((f) => (
                <div key={f.title} className="landing-feature">
                  <div className="landing-feature-icon" aria-hidden>{f.icon}</div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              ))}
            </section>

            <footer className="landing-footer">
              © {new Date().getFullYear()} KNAP Advisory · TeamHub — internal team &amp; practice management
            </footer>
          </div>
        ) : (
          <form className="auth-card" onSubmit={submit}>
            <h1 className="auth-title">{mode === 'login' ? 'Sign In' : 'Register your company'}</h1>
            {mode === 'create' && <p className="muted auth-sub">Create your company's workspace. You'll be its admin and can invite your team.</p>}

            {mode === 'create' && (
              <input className="auth-input" placeholder="Company / workspace name" value={form.workspace_name} onChange={set('workspace_name')} required />
            )}
            {mode === 'create' && (
              <input className="auth-input" placeholder="Your name" value={form.name} onChange={set('name')} required />
            )}
            <input className="auth-input" type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
            <input className="auth-input" type="password" placeholder="Password" value={form.password} onChange={set('password')} required minLength={6} />
            {mode === 'create' && (
              <input className="auth-input" placeholder="Company registration code (from KNAP)" value={form.code} onChange={set('code')} required />
            )}

            {error && <div className="form-error">{error}</div>}
            {notice && <div className="auth-notice">{notice}</div>}

            <button className="auth-primary" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Create workspace'}
            </button>

            {mode === 'login' && <button type="button" className="auth-forgot" onClick={forgot}>Forgot Password</button>}

            <p className="auth-foot">
              {mode === 'login'
                ? <>New company? <button type="button" className="auth-foot-link" onClick={() => go('create')}>Register</button></>
                : <>Already have an account? <button type="button" className="auth-foot-link" onClick={() => go('login')}>Sign In</button></>}
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
