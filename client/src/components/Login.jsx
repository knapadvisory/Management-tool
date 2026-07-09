import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

const GoogleIcon = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.7 1.22 9.2 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);
const AppleIcon = () => (
  <svg viewBox="0 0 384 512" width="16" height="16" aria-hidden="true" fill="currentColor">
    <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
  </svg>
);

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', code: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState({ signup_code_required: false, google_auth: false, apple_auth: false });

  useEffect(() => {
    api('/config').then(setConfig).catch(() => {});
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

  function social(provider) {
    // Real OAuth is wired up server-side; until an admin configures the
    // provider's credentials, explain rather than fail silently.
    const enabled = provider === 'google' ? config.google_auth : config.apple_auth;
    if (!enabled) {
      setNotice(`${provider === 'google' ? 'Google' : 'Apple'} sign-in isn't set up yet. Your admin can enable it in the server configuration.`);
      return;
    }
    window.location.href = `/api/auth/${provider}/start`;
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
          <input className="auth-input" type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
          <input className="auth-input" type="password" placeholder="Password" value={form.password} onChange={set('password')} required minLength={6} />
          {!isLogin && config.signup_code_required && (
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

          <div className="auth-divider"><span>or</span></div>

          <button type="button" className="social-btn" onClick={() => social('google')}>
            <GoogleIcon /> Continue with Google
          </button>
          <button type="button" className="social-btn" onClick={() => social('apple')}>
            <AppleIcon /> Continue with Apple
          </button>
        </form>

        <p className="auth-foot">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button type="button" className="auth-foot-link" onClick={toggle}>{isLogin ? 'Sign Up' : 'Sign In'}</button>
        </p>
      </main>
    </div>
  );
}
