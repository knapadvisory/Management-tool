import React, { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body: form });
      onAuth(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>TeamHub</h1>
        <p className="login-sub">Chat, calls, tasks and workflows for your team</p>
        {mode === 'register' && (
          <input placeholder="Full name" value={form.name} onChange={set('name')} required />
        )}
        <input type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
        <input type="password" placeholder="Password" value={form.password} onChange={set('password')} required minLength={6} />
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          className="btn-link"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
        >
          {mode === 'login' ? "New here? Create an account" : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
