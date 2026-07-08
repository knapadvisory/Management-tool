import React, { useState } from 'react';
import { api } from '../api.js';
import StepsEditor from './StepsEditor.jsx';

const BLANK = { name: '', description: '', default_priority: 'medium', default_workflow_id: '', tags: [], steps: [] };

export default function TemplatesModal({ templates, workflows, onClose, onChanged }) {
  const [editingId, setEditingId] = useState(null); // null = not editing, 'new' = creating
  const [form, setForm] = useState(BLANK);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState(null);

  function startNew() {
    setForm({ ...BLANK, default_workflow_id: workflows[0]?.id || '' });
    setTagInput('');
    setEditingId('new');
    setError(null);
  }

  function startEdit(t) {
    setForm({
      name: t.name,
      description: t.description || '',
      default_priority: t.default_priority,
      default_workflow_id: t.default_workflow_id || '',
      tags: t.tags || [],
      steps: (t.steps || []).map((s) => s.text),
    });
    setTagInput('');
    setEditingId(t.id);
    setError(null);
  }

  function addTag() {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !form.tags.includes(tag)) setForm((f) => ({ ...f, tags: [...f.tags, tag] }));
    setTagInput('');
  }

  async function save(e) {
    e.preventDefault();
    setError(null);
    const body = {
      name: form.name,
      description: form.description,
      default_priority: form.default_priority,
      default_workflow_id: form.default_workflow_id ? Number(form.default_workflow_id) : null,
      tags: form.tags,
      steps: form.steps,
    };
    try {
      if (editingId === 'new') await api('/templates', { method: 'POST', body });
      else await api(`/templates/${editingId}`, { method: 'PATCH', body });
      setEditingId(null);
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function remove(t) {
    if (!confirm(`Delete template "${t.name}"? Tasks already created from it are unaffected.`)) return;
    await api(`/templates/${t.id}`, { method: 'DELETE' });
    if (editingId === t.id) setEditingId(null);
    onChanged();
  }

  const editing = editingId !== null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal templates-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Task templates</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <p className="muted">Prepare a repeatable process once (e.g. Company Registration) with its standard steps. When you create a task you can start from a template and tweak it for that client.</p>

        <div className="templates-body">
          <div className="templates-list">
            <button className="btn btn-primary btn-block" onClick={startNew}>＋ New template</button>
            {templates.map((t) => (
              <div key={t.id} className={`template-item ${editingId === t.id ? 'active' : ''}`} onClick={() => startEdit(t)}>
                <div className="template-item-main">
                  <strong>{t.name}</strong>
                  <span className="muted">{t.steps.length} step{t.steps.length === 1 ? '' : 's'}</span>
                </div>
                <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); remove(t); }}>🗑</button>
              </div>
            ))}
            {templates.length === 0 && <div className="empty-hint">No templates yet.</div>}
          </div>

          <div className="templates-editor">
            {!editing && <div className="empty-hint">Select a template to edit, or create a new one.</div>}
            {editing && (
              <form onSubmit={save}>
                <label className="field">Name
                  <input autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Company Registration" required />
                </label>
                <label className="field">Description
                  <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Optional" />
                </label>
                <div className="field-row">
                  <label className="field">Default priority
                    <select value={form.default_priority} onChange={(e) => setForm((f) => ({ ...f, default_priority: e.target.value }))}>
                      <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                    </select>
                  </label>
                  <label className="field">Default board
                    <select value={form.default_workflow_id} onChange={(e) => setForm((f) => ({ ...f, default_workflow_id: e.target.value }))}>
                      <option value="">(choose at creation)</option>
                      {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="field">
                  <span>Default tags</span>
                  <div className="tags-row">
                    {form.tags.map((t) => (
                      <span key={t} className="task-tag removable">{t}<button type="button" onClick={() => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }))}>✕</button></span>
                    ))}
                    <input className="tag-inline" placeholder="+ tag" value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
                  </div>
                </div>
                <div className="field">
                  <span>Steps</span>
                  <StepsEditor steps={form.steps} onChange={(steps) => setForm((f) => ({ ...f, steps }))} />
                </div>
                {error && <div className="form-error">{error}</div>}
                <div className="editor-actions">
                  <button className="btn btn-primary" disabled={!form.name.trim()}>{editingId === 'new' ? 'Create template' : 'Save changes'}</button>
                  <button type="button" className="btn" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
