import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Turn a chat message into a task, pre-filling the title from the message.
export default function TaskFromMessageModal({ message, onClose }) {
  const [workflows, setWorkflows] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({
    title: (message.content || '').slice(0, 120),
    workflow_id: '', assignee_id: '', priority: 'medium', due_date: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api('/workflows').then((d) => {
      setWorkflows(d.workflows);
      setForm((f) => ({ ...f, workflow_id: f.workflow_id || d.workflows[0]?.id || '' }));
    }).catch(() => {});
    api('/users').then((d) => setUsers(d.users)).catch(() => {});
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
          assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
          priority: form.priority,
          due_date: form.due_date || null,
          description: `From chat — ${message.user_name || 'a teammate'}: "${message.content}"`,
        },
      });
      setDone(true);
      setTimeout(onClose, 800);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-header"><strong>Create task from message</strong><button type="button" className="icon-btn" onClick={onClose}>✕</button></div>
        <label className="field">Title<input autoFocus value={form.title} onChange={set('title')} required /></label>
        <div className="field-row">
          <label className="field">Board
            <select value={form.workflow_id} onChange={set('workflow_id')}>
              {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="field">Assignee
            <select value={form.assignee_id} onChange={set('assignee_id')}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">Priority
            <select value={form.priority} onChange={set('priority')}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="field">Due date<input type="date" value={form.due_date} onChange={set('due_date')} /></label>
        </div>
        {error && <div className="form-error">{error}</div>}
        {done && <div className="auth-notice">Task created ✓</div>}
        <div className="editor-actions">
          <button className="btn btn-primary" disabled={busy || done}>{busy ? 'Creating…' : 'Create task'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
