import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// Auth entry point. Two paths: sign in to an existing account (email +
// password derives the workspace), or create a brand-new workspace and become
// its admin. Employees join an existing workspace via a /join/<slug> link.
export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login'); // 'login' | 'create'
  const [form, setForm] = useState({ workspace_name: '', name: '', email: '', password: '', code: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codeRequired, setCodeRequired] = useState(false);

  useEffect(() => {
    api('/config').then((c) => setCodeRequired(!!c.workspace_signup_code_required)).catch(() => {});
  }, []);

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
  const isLogin = mode === 'login';
  const toggle = () => { setMode(isLogin ? 'create' : 'login'); setError(null); setNotice(null); };

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div>
        <div className="auth-topbar-right">
          <span className="muted">{isLogin ? 'New to TeamHub?' : 'Already have an account?'}</span>
          <button className="auth-topbtn" onClick={toggle}>{isLogin ? 'Create workspace' : 'Sign In'}</button>
        </div>
      </header>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <h1 className="auth-title">{isLogin ? 'Sign In' : 'Create your workspace'}</h1>
          {!isLogin && <p className="muted auth-sub">Start a fresh TeamHub for your company. You'll be its admin and can invite your team.</p>}

          {!isLogin && (
            <input className="auth-input" placeholder="Workspace name (e.g. Acme Corp)" value={form.workspace_name} onChange={set('workspace_name')} required />
          )}
          {!isLogin && (
            <input className="auth-input" placeholder="Your name" value={form.name} onChange={set('name')} required />
          )}
          <input className="auth-input" type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
          <input className="auth-input" type="password" placeholder="Password" value={form.password} onChange={set('password')} required minLength={6} />
          {!isLogin && codeRequired && (
            <input className="auth-input" placeholder="Workspace creation code" value={form.code} onChange={set('code')} required />
          )}

          {error && <div className="form-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}

          <button className="auth-primary" disabled={busy}>
            {busy ? 'Please wait…' : isLogin ? 'Sign In' : 'Create workspace'}
          </button>

          {isLogin && (
            <button type="button" className="auth-forgot" onClick={forgot}>Forgot Password</button>
          )}
        </form>

        <p className="auth-foot">
          {isLogin ? 'Joining your team? ' : 'Already have an account? '}
          {isLogin
            ? <span className="muted">Use the invite link your admin shared.</span>
            : <button type="button" className="auth-foot-link" onClick={toggle}>Sign In</button>}
        </p>
      </main>
    </div>
  );
}
