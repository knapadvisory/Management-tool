import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', code: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codeRequired, setCodeRequired] = useState(false);
  const [domains, setDomains] = useState([]);

  useEffect(() => {
    api('/config').then((c) => {
      setCodeRequired(!!c.signup_code_required);
      setDomains(c.allowed_signup_domains || []);
    }).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body: form });
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
  const toggle = () => { setMode(isLogin ? 'register' : 'login'); setError(null); setNotice(null); };

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div>
        <div className="auth-topbar-right">
          <span className="muted">{isLogin ? "Don't have an account?" : 'Already have an account?'}</span>
          <button className="auth-topbtn" onClick={toggle}>{isLogin ? 'Sign Up' : 'Sign In'}</button>
        </div>
      </header>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <h1 className="auth-title">{isLogin ? 'Sign In' : 'Create your account'}</h1>

          {!isLogin && (
            <input className="auth-input" placeholder="Full name" value={form.name} onChange={set('name')} required />
          )}
          <input className="auth-input" type="email" placeholder={!isLogin && domains.length ? `Work email (${domains.map((d) => '@' + d).join(' / ')})` : 'Email'} value={form.email} onChange={set('email')} required />
          {!isLogin && domains.length > 0 && (
            <p className="auth-hint">Use your work email. External collaborators join via a collab invite link instead.</p>
          )}
          <input className="auth-input" type="password" placeholder="Password" value={form.password} onChange={set('password')} required minLength={6} />
          {!isLogin && codeRequired && (
            <input className="auth-input" placeholder="Access code (from your admin)" value={form.code} onChange={set('code')} required />
          )}

          {error && <div className="form-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}

          <button className="auth-primary" disabled={busy}>
            {busy ? 'Please wait…' : isLogin ? 'Sign In' : 'Create account'}
          </button>

          {isLogin && (
            <button type="button" className="auth-forgot" onClick={forgot}>Forgot Password</button>
          )}
        </form>

        <p className="auth-foot">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button type="button" className="auth-foot-link" onClick={toggle}>{isLogin ? 'Sign Up' : 'Sign In'}</button>
        </p>
      </main>
    </div>
  );
}
