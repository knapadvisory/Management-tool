import React, { useState } from 'react';
import { api } from '../api.js';

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

  function forgot() {
    setNotice('To reset your password, ask your workspace admin — they can set a new one for you from the Admin panel.');
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

      <main className="auth-main">
        {mode === 'home' ? (
          <div className="landing">
            <h1 className="landing-title">One place for your team's chat, tasks &amp; files</h1>
            <p className="landing-sub">TeamHub gives your company its own private workspace — messaging, task boards, a shared drive, and calls, all in one tool.</p>
            <div className="landing-actions">
              <button className="landing-primary" onClick={() => go('create')}>Register your company</button>
              <button className="landing-secondary" onClick={() => go('login')}>Sign in</button>
            </div>
            <p className="landing-note muted">New companies need a registration code from KNAP. Employees join their company with a link from their admin.</p>
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
