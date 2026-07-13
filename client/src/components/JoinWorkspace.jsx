import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// Landing page for an employee joining their company's workspace via a
// /join/<slug> link. Shows the workspace, then collects name + work email +
// password. The server enforces the workspace's allowed email domains.
export default function JoinWorkspace({ slug, onAuth }) {
  const [state, setState] = useState({ loading: true, workspace: null, domains: [], requireCode: false, error: null });
  const [form, setForm] = useState({ name: '', email: '', password: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    api(`/workspaces/${slug}`)
      .then((d) => setState({ loading: false, workspace: d.workspace, domains: d.allowed_signup_domains || [], requireCode: !!d.require_invite_code, error: null }))
      .catch((e) => setState({ loading: false, workspace: null, domains: [], requireCode: false, error: e.message }));
  }, [slug]);

  async function submit(e) {
    e.preventDefault();
    setJoinError(null); setBusy(true);
    try {
      const data = await api(`/workspaces/${slug}/register`, { method: 'POST', body: form });
      // New members must be approved by an admin before they can sign in.
      if (data.pending) { setSubmitted(true); return; }
      window.history.replaceState({}, '', '/');
      onAuth(data);
    } catch (err) {
      setJoinError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const domainHint = state.domains.length ? 'Work email if you have one, otherwise personal' : 'Email';

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div>
      </header>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          {submitted ? (
            <>
              <div className="join-pending-icon">⏳</div>
              <h1 className="auth-title">Request sent</h1>
              <p className="muted auth-sub">Your request to join <strong>{state.workspace?.name}</strong> is waiting for an admin to approve it. You'll be able to sign in as soon as they do.</p>
              <button type="button" className="auth-primary" onClick={() => { window.history.replaceState({}, '', '/'); window.location.reload(); }}>Back to sign in</button>
            </>
          ) : state.loading ? (
            <p className="muted">Loading…</p>
          ) : state.error ? (
            <>
              <h1 className="auth-title">Workspace not found</h1>
              <div className="form-error">{state.error}</div>
              <p className="auth-foot muted">Double-check the invite link with your admin.</p>
            </>
          ) : (
            <>
              <h1 className="auth-title">Join {state.workspace.name}</h1>
              <p className="muted auth-sub">Create your account to join your team on TeamHub.</p>

              <input className="auth-input" placeholder="Your name" value={form.name} onChange={set('name')} required />
              <input className="auth-input" type="email" placeholder={domainHint} value={form.email} onChange={set('email')} required />
              <input className="auth-input" type="password" placeholder="Choose a password (6+ characters)" value={form.password} onChange={set('password')} required minLength={6} />
              {state.requireCode && (
                <input className="auth-input" placeholder="Invite code (from your admin)" value={form.code} onChange={set('code')} required />
              )}

              {joinError && <div className="form-error">{joinError}</div>}
              <button className="auth-primary" disabled={busy}>{busy ? 'Joining…' : `Join ${state.workspace.name}`}</button>
            </>
          )}
        </form>
      </main>
    </div>
  );
}
