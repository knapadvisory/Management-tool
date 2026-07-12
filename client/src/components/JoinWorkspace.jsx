import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

// Landing page for an employee joining their company's workspace via a
// /join/<slug> link. Shows the workspace, then collects name + work email +
// password. The server enforces the workspace's allowed email domains.
export default function JoinWorkspace({ slug, onAuth }) {
  const [state, setState] = useState({ loading: true, workspace: null, domains: [], error: null });
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState(null);

  useEffect(() => {
    api(`/workspaces/${slug}`)
      .then((d) => setState({ loading: false, workspace: d.workspace, domains: d.allowed_signup_domains || [], error: null }))
      .catch((e) => setState({ loading: false, workspace: null, domains: [], error: e.message }));
  }, [slug]);

  async function submit(e) {
    e.preventDefault();
    setJoinError(null); setBusy(true);
    try {
      const data = await api(`/workspaces/${slug}/register`, { method: 'POST', body: form });
      window.history.replaceState({}, '', '/');
      onAuth(data);
    } catch (err) {
      setJoinError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const domainHint = state.domains.length ? `Use your work email (${state.domains.map((d) => '@' + d).join(' / ')})` : 'Email';

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-brand"><span className="auth-logo">✓</span> TeamHub</div>
      </header>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          {state.loading ? (
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

              {joinError && <div className="form-error">{joinError}</div>}
              <button className="auth-primary" disabled={busy}>{busy ? 'Joining…' : `Join ${state.workspace.name}`}</button>
            </>
          )}
        </form>
      </main>
    </div>
  );
}
