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
  const [providers, setProviders] = useState({});

  useEffect(() => { api('/config').then((c) => setEmailEnabled(!!c.email_enabled)).catch(() => {}); }, []);
  useEffect(() => { api('/auth/oauth/providers').then(setProviders).catch(() => {}); }, []);
  // Surface an SSO failure that the callback stashed before redirecting here.
  useEffect(() => {
    try {
      const msg = sessionStorage.getItem('oauth_error');
      if (msg) { setError(msg); setMode('login'); sessionStorage.removeItem('oauth_error'); }
    } catch { /* ignore */ }
  }, []);
  const anySso = providers.google || providers.microsoft;

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
            {mode === 'login' && anySso && (
              <div className="sso-block">
                {providers.google && (
                  <a className="sso-btn" href="/api/auth/oauth/google/start">
                    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7C43.8 38 46.5 31.8 46.5 24.5z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.5l-7.3-5.7c-2 1.4-4.7 2.3-8 2.3-6.3 0-11.7-3.7-13.6-9l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
                    Continue with Google
                  </a>
                )}
                {providers.microsoft && (
                  <a className="sso-btn" href="/api/auth/oauth/microsoft/start">
                    <svg viewBox="0 0 23 23" width="17" height="17" aria-hidden><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>
                    Continue with Microsoft
                  </a>
                )}
                <div className="sso-or"><span>or sign in with email</span></div>
              </div>
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
