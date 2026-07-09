import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';

// Compact popup to allot a task to a specific teammate, straight from the
// Team directory — no full task window, just the essentials.
export default function AssignTaskModal({ assignee, onClose }) {
  const [workflows, setWorkflows] = useState([]);
  const [form, setForm] = useState({ title: '', workflow_id: '', priority: 'medium', due_date: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api('/workflows').then((d) => {
      setWorkflows(d.workflows);
      setForm((f) => ({ ...f, workflow_id: d.workflows[0]?.id || '' }));
    }).catch(() => {});
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.workflow_id) return;
    setBusy(true); setError(null);
    try {
      await api('/tasks', {
        method: 'POST',
        body: {
          title: form.title.trim(),
          workflow_id: Number(form.workflow_id),
          assignee_id: assignee.id,
          priority: form.priority,
          due_date: form.due_date || null,
        },
      });
      setDone(true);
      setTimeout(onClose, 800);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal assign-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-header">
          <strong>Assign a task</strong>
          <button type="button" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="assign-to">
          <Avatar user={assignee} size={26} />
          <span>To <strong>{assignee.name}</strong></span>
        </div>
        <input className="assign-input" autoFocus placeholder="What needs doing?" value={form.title} onChange={set('title')} required />
        <div className="assign-row">
          <select value={form.workflow_id} onChange={set('workflow_id')} title="Board">
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select value={form.priority} onChange={set('priority')} title="Priority">
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
          <input type="date" value={form.due_date} onChange={set('due_date')} title="Due date" />
        </div>
        {error && <div className="form-error">{error}</div>}
        {done && <div className="auth-notice">Task assigned to {assignee.name} ✓</div>}
        <div className="editor-actions">
          <button className="btn btn-primary" disabled={busy || done || !form.title.trim()}>{busy ? 'Assigning…' : 'Assign task'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
