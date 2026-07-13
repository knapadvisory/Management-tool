import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// Landing page for a password-reset link (/reset/<token>). Validates the token,
// then lets the user set a new password.
export default function ResetPassword({ token }) {
  const [state, setState] = useState({ loading: true, valid: false, email: null, error: null });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api(`/auth/reset/${token}`)
      .then((d) => setState({ loading: false, valid: true, email: d.email, error: null }))
      .catch((e) => setState({ loading: false, valid: false, email: null, error: e.message }));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (password.length < 6) { setErr('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setErr('Passwords don’t match.'); return; }
    setBusy(true);
    try {
      await api(`/auth/reset/${token}`, { method: 'POST', body: { password } });
      setDone(true);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }

  return (
    <div className="auth-page">
      <header className="auth-topbar"><div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div></header>
      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          {state.loading ? (
            <p className="muted">Checking your link…</p>
          ) : done ? (
            <>
              <h1 className="auth-title">Password updated</h1>
              <p className="muted auth-sub">You can now sign in with your new password.</p>
              <button type="button" className="auth-primary" onClick={() => { window.history.replaceState({}, '', '/'); window.location.reload(); }}>Go to sign in</button>
            </>
          ) : !state.valid ? (
            <>
              <h1 className="auth-title">Link expired</h1>
              <div className="form-error">{state.error}</div>
              <p className="auth-foot muted">Reset links are valid for 1 hour. Request a new one from the sign-in page.</p>
            </>
          ) : (
            <>
              <h1 className="auth-title">Set a new password</h1>
              {state.email && <p className="muted auth-sub">for {state.email}</p>}
              <input className="auth-input" type="password" placeholder="New password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoFocus />
              <input className="auth-input" type="password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              {err && <div className="form-error">{err}</div>}
              <button className="auth-primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
            </>
          )}
        </form>
      </main>
    </div>
  );
}
