import React, { useState } from 'react';
import { api } from '../api.js';

const COLORS = ['#4f46e5', '#e01e5a', '#2eb67d', '#ecb22e', '#0ea5e9', '#f97316', '#7c3aed', '#db2777'];

export default function ProjectsModal({ projects, onClose, onChanged }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [error, setError] = useState(null);

  async function create(e) {
    e.preventDefault();
    setError(null);
    try {
      await api('/projects', { method: 'POST', body: { name, color } });
      setName('');
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function remove(p) {
    if (!confirm(`Delete project "${p.name}"? Its tasks stay but lose the project label.`)) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    onChanged();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal projects-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Projects</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <p className="muted">Group tasks by client or initiative. Filter the board by project from the Tasks toolbar.</p>

        <form className="project-create" onSubmit={create}>
          <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="color-picker">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-swatch ${color === c ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <button className="btn btn-primary">Add</button>
        </form>
        {error && <div className="form-error">{error}</div>}

        <div className="project-list">
          {projects.map((p) => (
            <div key={p.id} className="project-row">
              <span className="project-dot" style={{ background: p.color }} />
              <span className="project-name">{p.name}</span>
              <span className="muted">{p.open_count} open / {p.task_count} total</span>
              <button className="icon-btn" title="Delete" onClick={() => remove(p)}>🗑</button>
            </div>
          ))}
          {projects.length === 0 && <div className="empty-hint">No projects yet.</div>}
        </div>
      </div>
    </div>
  );
}
