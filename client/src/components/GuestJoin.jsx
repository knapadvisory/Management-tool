import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// Landing page for an external guest who opened a collab invite link
// (/invite/:token). Shows the collab they're being invited to, then collects
// a display name + password and creates a scoped guest account.
export default function GuestJoin({ token, onAuth }) {
  const [state, setState] = useState({ loading: true, collab: null, error: null });
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState(null);

  useEffect(() => {
    api(`/invite/${token}`)
      .then((d) => setState({ loading: false, collab: d, error: null }))
      .catch((e) => setState({ loading: false, collab: null, error: e.message }));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setJoinError(null); setBusy(true);
    try {
      const data = await api(`/invite/${token}/join`, { method: 'POST', body: form });
      // Drop the invite path so a refresh lands in the app, not back here.
      window.history.replaceState({}, '', '/');
      onAuth(data);
    } catch (err) {
      setJoinError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div>
      </header>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          {state.loading ? (
            <p className="muted">Checking your invite…</p>
          ) : state.error ? (
            <>
              <h1 className="auth-title">Invite unavailable</h1>
              <div className="form-error">{state.error}</div>
              <p className="auth-foot muted">Ask whoever shared the link to send you a fresh one.</p>
            </>
          ) : (
            <>
              <h1 className="auth-title">Join the conversation</h1>
              <p className="guest-join-collab">You've been invited to <strong>👥 {state.collab.collab_name}</strong></p>
              {state.collab.description && <p className="muted guest-join-desc">{state.collab.description}</p>}
              <p className="muted guest-join-note">You'll join as a guest and see only this conversation.</p>

              <input className="auth-input" placeholder="Your name" value={form.name} onChange={set('name')} required />
              <input className="auth-input" type="password" placeholder="Choose a password (6+ characters)" value={form.password} onChange={set('password')} required minLength={6} />
              <p className="muted guest-join-hint">Keep this password — you'll use your name and it to return to the chat.</p>

              {joinError && <div className="form-error">{joinError}</div>}
              <button className="auth-primary" disabled={busy}>{busy ? 'Joining…' : 'Join chat'}</button>
            </>
          )}
        </form>
      </main>
    </div>
  );
}
