import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import CollabPermissions from './CollabPermissions.jsx';

// The "New collab" pane: name, description, members, and access permissions.
export default function CollabForm({ user, users, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState([]);
  const [moderatorIds, setModeratorIds] = useState([]);
  const [perms, setPerms] = useState({ historyVisible: true, whoInvite: 'all', whoPost: 'all' });
  const [showPerms, setShowPerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const others = users.filter((u) => u.id !== user.id);

  function toggleMember(id) {
    setMemberIds((m) => {
      if (m.includes(id)) { setModeratorIds((mm) => mm.filter((x) => x !== id)); return m.filter((x) => x !== id); }
      return [...m, id];
    });
  }
  function toggleMod(id) { setModeratorIds((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id])); }

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const collab = await api('/collabs', {
        method: 'POST',
        body: {
          name, description, member_ids: memberIds, moderator_ids: moderatorIds,
          history_visible: perms.historyVisible, who_can_invite: perms.whoInvite, who_can_post: perms.whoPost,
        },
      });
      onCreated(collab);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <form className="collab-form" onSubmit={submit}>
      <div className="collab-form-head">
        <div className="collab-form-avatar">👥</div>
        <input className="collab-name-input" placeholder="Collab name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>

      <div className="collab-info-banner">
        <strong>Collab</strong> is a co-working space for a focused group — chat, files and calls for a single engagement. You can invite more people once it's created.
      </div>

      <label className="field">Collab description
        <textarea rows={2} placeholder="Tell others what this collab is about." value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="collab-members-pick">
        <span className="field-label">Members</span>
        <div className="member-checklist">
          {others.map((u) => (
            <label key={u.id} className={`member-check ${memberIds.includes(u.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={memberIds.includes(u.id)} onChange={() => toggleMember(u.id)} />
              <Avatar user={u} size={24} />
              <span className="member-check-name">{u.name}</span>
              {memberIds.includes(u.id) && (
                <button type="button" className={`mod-toggle ${moderatorIds.includes(u.id) ? 'on' : ''}`}
                  onClick={(e) => { e.preventDefault(); toggleMod(u.id); }}>
                  {moderatorIds.includes(u.id) ? '★ Moderator' : 'Make moderator'}
                </button>
              )}
            </label>
          ))}
          {others.length === 0 && <div className="empty-hint">No teammates to add yet.</div>}
        </div>
      </div>

      <button type="button" className="perm-toggle" onClick={() => setShowPerms((s) => !s)}>
        <span>🔒 Access permissions</span><span>{showPerms ? '▲' : '▼'}</span>
      </button>
      {showPerms && (
        <div className="perm-panel">
          <div className="perm-owner-row"><span>Owner</span><strong>{user.name} (you)</strong></div>
          <CollabPermissions {...perms} onChange={(p) => setPerms((prev) => ({ ...prev, ...p }))} />
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
      <div className="collab-form-actions">
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create collab'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
