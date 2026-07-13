import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';
import ArchiveManager from './ArchiveManager.jsx';

// Super-admin control room: manage the whole team — create, promote/demote,
// deactivate/reactivate, reset passwords — and share the sign-up link.
export default function AdminPanel({ user }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleted, setDeleted] = useState([]);
  const [archived, setArchived] = useState([]);
  const [showArchive, setShowArchive] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [d, del] = await Promise.all([api('/admin/users'), api('/admin/users/deleted').catch(() => ({ users: [] }))]);
      setMembers(d.users);
      setDeleted(del.users);
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

      <PendingApprovals onChanged={refresh} />

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

      {deleted.length > 0 && (
        <div className="admin-deleted">
          <button className="admin-archive-toggle" onClick={() => setShowDeleted((s) => !s)}>
            🗑 Deleted accounts · {deleted.length} <span>{showDeleted ? '▲' : '▼'}</span>
          </button>
          <p className="muted admin-archive-note">These logins are gone for good, but the people's records and their tasks, messages and files are kept here for your reference.</p>
          {showDeleted && deleted.map((m) => (
            <div key={m.id} className="admin-row inactive">
              <Avatar user={m} size={34} />
              <div className="admin-row-main">
                <div className="admin-row-name">{m.name}<span className="role-badge off">Deleted</span></div>
                <div className="muted admin-row-email">{m.email}{m.title ? ` · ${m.title}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}

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

// Employees who self-registered via the join link and need admin approval
// before they can sign in.
function PendingApprovals({ onChanged }) {
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api('/admin/users/pending').then((d) => setPending(d.users)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const socket = getSocket();
    socket?.on('approvals:changed', load);
    return () => socket?.off('approvals:changed', load);
  }, [load]);

  async function act(id, action) {
    setBusy(id);
    try {
      await api(`/admin/users/${id}/${action}`, { method: 'POST' });
      setPending((p) => p.filter((u) => u.id !== id));
      if (action === 'approve') onChanged?.();
    } catch { /* surfaced on next load */ }
    setBusy(null);
  }

  if (!pending.length) return null;

  return (
    <div className="admin-approvals">
      <div className="admin-approvals-head">
        <strong>⏳ Pending approvals</strong>
        <span className="approvals-count">{pending.length}</span>
      </div>
      <p className="muted">These people asked to join. They can't sign in until you approve them.</p>
      {pending.map((u) => (
        <div key={u.id} className="approval-row">
          <Avatar user={u} size={32} />
          <div className="approval-meta">
            <span className="approval-name">{u.name}</span>
            <span className="muted approval-email">{u.email}</span>
          </div>
          <button className="btn btn-sm btn-primary" disabled={busy === u.id} onClick={() => act(u.id, 'approve')}>Approve</button>
          <button className="btn btn-sm btn-danger" disabled={busy === u.id} onClick={() => act(u.id, 'reject')}>Reject</button>
        </div>
      ))}
    </div>
  );
}

// Workspace identity + who may join, plus the shareable employee join link.
function SignupPolicy() {
  const [domains, setDomains] = useState('');
  const [guestCount, setGuestCount] = useState(0);
  const [ws, setWs] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api('/admin/settings').then((d) => {
      setDomains(d.allowed_signup_domains || '');
      setGuestCount(d.guest_count || 0);
      setWs(d.workspace || null);
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
  const joinLink = ws ? `${window.location.origin}/join/${ws.slug}` : '';
  function copyJoin() {
    navigator.clipboard?.writeText(joinLink).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  }

  return (
    <div className="admin-policy">
      {ws && (
        <div className="admin-policy-invite">
          <div className="admin-policy-head"><strong>Invite your team to {ws.name}</strong></div>
          <p className="muted">Share this link so employees create their own account in this workspace.</p>
          <div className="admin-policy-row">
            <input readOnly value={joinLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-sm" onClick={copyJoin}>{copied ? 'Copied ✓' : 'Copy'}</button>
          </div>
        </div>
      )}

      <div className="admin-policy-head">
        <strong>Who can join</strong>
        <span className={`policy-pill ${restricted ? 'on' : 'off'}`}>{restricted ? 'Work email only' : 'Open'}</span>
      </div>
      <p className="muted">
        List the work-email domains allowed to join (comma separated). Anyone with a matching email can register as a member;
        everyone else must be invited into a collab as a <strong>guest</strong>, or created here by you. Leave empty to allow any email.
      </p>
      <div className="admin-policy-row">
        <input placeholder="acme.com, partner.com" value={domains} onChange={(e) => setDomains(e.target.value)} />
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
        {!!m.active && !isSelf && (
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
        {!m.active && !isSelf && (
          <>
            <button className="btn btn-sm" title="Restore access"
              onClick={() => act(() => api(`/admin/users/${m.id}/reactivate`, { method: 'POST' }))}>
              Reactivate
            </button>
            <DeleteButton m={m} act={act} />
          </>
        )}
      </div>
    </div>
  );
}

// Permanent-delete control: locked until the account has been deactivated for
// the full grace period; shows a countdown until then.
function DeleteButton({ m, act }) {
  const grace = m.delete_grace_days || 7;
  const since = m.deactivated_at ? Math.floor((Date.now() - new Date(m.deactivated_at.replace(' ', 'T') + 'Z').getTime()) / 86400000) : 0;
  const remaining = Math.max(0, grace - since);
  const ready = remaining === 0;
  if (!ready) {
    return <button className="btn btn-sm" disabled title={`Deletable in ${remaining} day(s) — a ${grace}-day safety window after deactivation`}>Delete in {remaining}d</button>;
  }
  return (
    <button className="btn btn-sm btn-danger" title="Permanently delete this account"
      onClick={() => {
        if (confirm(`Permanently delete ${m.name}?\n\nTheir login is removed for good and they leave every conversation. Their tasks, messages and files are KEPT for your records under "Deleted accounts". This cannot be undone.`))
          act(() => api(`/admin/users/${m.id}/delete`, { method: 'POST' }));
      }}>
      Delete permanently
    </button>
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
