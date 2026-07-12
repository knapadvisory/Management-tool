import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import ArchiveManager from './ArchiveManager.jsx';

// Super-admin control room: manage the whole team — create, promote/demote,
// deactivate/reactivate, reset passwords — and share the sign-up link.
export default function AdminPanel({ user, signupCodeRequired }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [archived, setArchived] = useState([]);
  const [showArchive, setShowArchive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/admin/users');
      setMembers(data.users);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadArchived = useCallback(async () => {
    try { const d = await api('/admin/files/archived'); setArchived(d.files); } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { refresh(); loadArchived(); }, [refresh, loadArchived]);

  async function act(fn) {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  const inviteLink = `${window.location.origin}/`;
  function copyInvite() {
    navigator.clipboard?.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  if (loading) return <div className="admin-panel"><div className="admin-head"><h2>Team administration</h2></div><p className="muted">Loading…</p></div>;

  const active = members.filter((m) => m.active);
  const inactive = members.filter((m) => !m.active);

  return (
    <div className="admin-panel">
      <div className="admin-head">
        <div>
          <h2>Team administration</h2>
          <p className="muted">Create teammates, set roles, and manage access. As super admin you can see every task and profile in the workspace.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>＋ Add user</button>
      </div>

      <div className="admin-invite">
        <div>
          <strong>Invite link</strong>
          <p className="muted">
            Share this link so teammates create their own login.
            {signupCodeRequired ? ' They will also need the sign-up access code you set at deploy time.' : ' Sign-up is currently open (no access code required).'}
          </p>
        </div>
        <div className="admin-invite-row">
          <input readOnly value={inviteLink} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={copyInvite}>{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>
      </div>

      <SignupPolicy />

      {error && <div className="form-error">{error}</div>}

      <div className="admin-list">
        <div className="admin-list-title">Active members · {active.length}</div>
        {active.map((m) => (
          <MemberRow key={m.id} m={m} me={user} act={act} />
        ))}

        {inactive.length > 0 && (
          <>
            <div className="admin-list-title">Deactivated · {inactive.length}</div>
            {inactive.map((m) => (
              <MemberRow key={m.id} m={m} me={user} act={act} />
            ))}
          </>
        )}
      </div>

      <div className="admin-archive">
        <button className="admin-archive-toggle" onClick={() => setShowArchive((s) => !s)}>
          🗄 Archive — deleted files · {archived.length} <span>{showArchive ? '▲' : '▼'}</span>
        </button>
        <p className="muted admin-archive-note">Files teammates deleted from their chats are hidden for everyone but kept here. Search, select multiple, then restore or delete them permanently.</p>
        {showArchive && <ArchiveManager files={archived} onReload={loadArchived} />}
      </div>

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
    </div>
  );
}

// Controls who may self-register as a full member vs. only join as a guest.
function SignupPolicy() {
  const [domains, setDomains] = useState('');
  const [guestCount, setGuestCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api('/admin/settings').then((d) => {
      setDomains(d.allowed_signup_domains || '');
      setGuestCount(d.guest_count || 0);
      setLoaded(true);
    }).catch((e) => { setErr(e.message); setLoaded(true); });
  }, []);

  async function save() {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const d = await api('/admin/settings', { method: 'PATCH', body: { allowed_signup_domains: domains } });
      setDomains(d.allowed_signup_domains || '');
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  if (!loaded) return null;
  const restricted = domains.trim().length > 0;

  return (
    <div className="admin-policy">
      <div className="admin-policy-head">
        <strong>Who can create an account</strong>
        <span className={`policy-pill ${restricted ? 'on' : 'off'}`}>{restricted ? 'Work email only' : 'Open signup'}</span>
      </div>
      <p className="muted">
        List the work-email domains allowed to self-register (comma separated). Anyone with a matching email can sign up as a member;
        everyone else must be invited into a collab as a <strong>guest</strong>, or created here by you. Leave empty to allow any email.
      </p>
      <div className="admin-policy-row">
        <input placeholder="knapadvisory.com, partner.com" value={domains} onChange={(e) => setDomains(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</button>
      </div>
      <p className="muted admin-policy-guests">👤 External guests currently in the workspace: <strong>{guestCount}</strong></p>
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}

function MemberRow({ m, me, act }) {
  const isSelf = m.id === me.id;
  return (
    <div className={`admin-row ${m.active ? '' : 'inactive'}`}>
      <Avatar user={m} size={34} />
      <div className="admin-row-main">
        <div className="admin-row-name">
          {m.name}
          {m.role === 'admin' && <span className="role-badge admin">Admin</span>}
          {isSelf && <span className="role-badge you">You</span>}
          {!m.active && <span className="role-badge off">Deactivated</span>}
        </div>
        <div className="muted admin-row-email">{m.email}{m.title ? ` · ${m.title}` : ''}</div>
      </div>

      <div className="admin-row-actions">
        {m.active && !isSelf && (
          <>
            {m.role === 'member' ? (
              <button className="btn btn-sm" title="Give full admin access"
                onClick={() => act(() => api(`/admin/users/${m.id}`, { method: 'PATCH', body: { role: 'admin' } }))}>
                Make admin
              </button>
            ) : (
              <button className="btn btn-sm" title="Remove admin access"
                onClick={() => act(() => api(`/admin/users/${m.id}`, { method: 'PATCH', body: { role: 'member' } }))}>
                Make member
              </button>
            )}
            <button className="btn btn-sm" title="Set a new password for this user"
              onClick={() => {
                const pw = prompt(`Set a new password for ${m.name} (6+ characters):`);
                if (pw) act(() => api(`/admin/users/${m.id}/reset-password`, { method: 'POST', body: { password: pw } }));
              }}>
              Reset password
            </button>
            <button className="btn btn-sm btn-danger" title="Revoke access (reversible — keeps their data)"
              onClick={() => {
                if (confirm(`Deactivate ${m.name}? They lose access immediately, but all their tasks and messages are kept. You can reactivate them anytime.`))
                  act(() => api(`/admin/users/${m.id}/deactivate`, { method: 'POST' }));
              }}>
              Deactivate
            </button>
          </>
        )}
        {!m.active && (
          <button className="btn btn-sm" title="Restore access"
            onClick={() => act(() => api(`/admin/users/${m.id}/reactivate`, { method: 'POST' }))}>
            Reactivate
          </button>
        )}
      </div>
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', title: '', role: 'member' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/admin/users', { method: 'POST', body: form });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Add a team member</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <p className="muted">Create an account directly — share the email and password with them, or set a password they change later.</p>
        <form className="admin-create-form" onSubmit={submit}>
          <input placeholder="Full name" value={form.name} onChange={set('name')} required autoFocus />
          <input type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
          <input placeholder="Title (optional)" value={form.title} onChange={set('title')} />
          <input type="password" placeholder="Temporary password (6+ chars)" value={form.password} onChange={set('password')} required minLength={6} />
          <select value={form.role} onChange={set('role')}>
            <option value="member">Member</option>
            <option value="admin">Admin (full access)</option>
          </select>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
        </form>
      </div>
    </div>
  );
}
