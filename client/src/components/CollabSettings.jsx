import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import CollabPermissions from './CollabPermissions.jsx';

// Access-permissions editor for an existing collab: name, description,
// owner, moderators, member management and the permission settings.
export default function CollabSettings({ collab, user, users, onClose, onChanged }) {
  const [name, setName] = useState(collab.name);
  const [description, setDescription] = useState(collab.description || '');
  const [perms, setPerms] = useState({
    historyVisible: !!collab.history_visible, whoInvite: collab.who_can_invite, whoPost: collab.who_can_post,
  });
  const [ownerId, setOwnerId] = useState(collab.owner_id);
  const [moderatorIds, setModeratorIds] = useState(collab.members.filter((m) => m.channel_role === 'moderator').map((m) => m.id));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const members = collab.members;
  const memberIds = new Set(members.map((m) => m.id));
  const addable = users.filter((u) => !memberIds.has(u.id));
  const isOwner = user.role === 'admin' || collab.owner_id === user.id;

  function toggleMod(id) {
    if (id === ownerId) return;
    setModeratorIds((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  }
  async function addMember(id) {
    try { await api(`/collabs/${collab.id}/members`, { method: 'POST', body: { user_ids: [id] } }); onChanged?.(); }
    catch (e) { setError(e.message); }
  }
  async function removeMember(id) {
    if (id === collab.owner_id) return;
    try { await api(`/collabs/${collab.id}/members/${id}`, { method: 'DELETE' }); onChanged?.(); }
    catch (e) { setError(e.message); }
  }
  async function save() {
    setBusy(true); setError(null);
    try {
      await api(`/collabs/${collab.id}`, {
        method: 'PATCH',
        body: {
          name, description, owner_id: ownerId, moderator_ids: moderatorIds,
          history_visible: perms.historyVisible, who_can_invite: perms.whoInvite, who_can_post: perms.whoPost,
        },
      });
      onChanged?.();
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const roleLabel = (m) => (m.id === ownerId ? 'Owner' : moderatorIds.includes(m.id) ? 'Moderator' : 'Member');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal collab-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Access permissions</strong><button className="icon-btn" onClick={onClose}>✕</button></div>

        <label className="field">Collab name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Description<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>

        <div className="perm-panel">
          <div className="perm-owner-row">
            <span>Owner</span>
            {isOwner ? (
              <select value={ownerId} onChange={(e) => setOwnerId(Number(e.target.value))}>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === user.id ? ' (you)' : ''}</option>)}
              </select>
            ) : <strong>{members.find((m) => m.id === collab.owner_id)?.name}</strong>}
          </div>
          <CollabPermissions {...perms} onChange={(p) => setPerms((prev) => ({ ...prev, ...p }))} />
        </div>

        <div className="collab-members-manage">
          <span className="field-label">Members ({members.length})</span>
          {members.map((m) => (
            <div key={m.id} className="member-row">
              <Avatar user={m} size={26} />
              <span className="member-name">{m.name}</span>
              <span className="member-role">{roleLabel(m)}</span>
              {m.id !== ownerId && (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => toggleMod(m.id)}>
                    {moderatorIds.includes(m.id) ? 'Demote' : 'Make mod'}
                  </button>
                  <button type="button" className="icon-btn" title="Remove from collab" onClick={() => removeMember(m.id)}>✕</button>
                </>
              )}
            </div>
          ))}
        </div>

        {addable.length > 0 && (
          <div className="collab-add-member">
            <span className="field-label">Add member</span>
            <div className="member-checklist">
              {addable.map((u) => (
                <button type="button" key={u.id} className="add-chip" onClick={() => addMember(u.id)}>
                  <Avatar user={u} size={22} /> {u.name} <span className="plus">＋</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
        <div className="editor-actions">
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
