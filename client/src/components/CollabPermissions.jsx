import React from 'react';

// The three collab permission selects, shared by the create form and settings.
export default function CollabPermissions({ historyVisible, whoInvite, whoPost, onChange }) {
  return (
    <div className="perm-fields">
      <label className="perm-field">
        <span>Make chat history available to new members</span>
        <select value={historyVisible ? 'yes' : 'no'} onChange={(e) => onChange({ historyVisible: e.target.value === 'yes' })}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
      <label className="perm-field">
        <span>Users allowed to invite new members</span>
        <select value={whoInvite} onChange={(e) => onChange({ whoInvite: e.target.value })}>
          <option value="all">All members</option>
          <option value="mods">Owner and moderators</option>
        </select>
      </label>
      <label className="perm-field">
        <span>Users allowed to post messages</span>
        <select value={whoPost} onChange={(e) => onChange({ whoPost: e.target.value })}>
          <option value="all">All members</option>
          <option value="mods">Owner and moderators</option>
        </select>
      </label>
    </div>
  );
}
