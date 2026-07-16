import React from 'react';
import Avatar from './Avatar.jsx';

// Multi-select assignee control: chips for the chosen people plus a dropdown
// to add more. `value` is an array of user ids; `onChange` gets the next array.
export default function AssigneePicker({ users = [], value = [], onChange }) {
  const selected = users.filter((u) => value.includes(u.id));
  const available = users.filter((u) => !value.includes(u.id));
  return (
    <div className="assignee-picker">
      <div className="assignee-chips">
        {selected.length === 0 && <span className="muted">Unassigned</span>}
        {selected.map((u) => (
          <span key={u.id} className="assignee-chip">
            <Avatar user={u} size={18} /> {u.name}
            <button type="button" title="Remove" onClick={() => onChange(value.filter((id) => id !== u.id))}>✕</button>
          </span>
        ))}
      </div>
      {available.length > 0 && (
        <select value="" onChange={(e) => { if (e.target.value) onChange([...value, Number(e.target.value)]); }}>
          <option value="">＋ Add assignee…</option>
          {available.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      )}
    </div>
  );
}
