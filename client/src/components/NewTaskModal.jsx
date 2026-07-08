import React, { useState } from 'react';
import { api } from '../api.js';
import StepsEditor from './StepsEditor.jsx';
import RemindersEditor from './RemindersEditor.jsx';
import { parseQuickAdd } from '../quickparse.js';

export default function NewTaskModal({ workflows, projects, users, templates, defaultWorkflowId, onClose, onCreated }) {
  const [form, setForm] = useState({
    title: '',
    workflow_id: defaultWorkflowId || workflows[0]?.id || '',
    project_id: '',
    assignee_id: '',
    priority: 'medium',
    due_date: '',
    recurrence: 'none',
  });
  const [tags, setTags] = useState([]);
  const [steps, setSteps] = useState([]);
  const [reminders, setReminders] = useState([]); // array of ISO strings
  const [tagInput, setTagInput] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Pull !priority, #tags and a due date out of the title into the form.
  function applyQuickParse() {
    const p = parseQuickAdd(form.title);
    if (p.title === form.title.trim() && !p.priority && !p.tags.length && !p.due_date) return;
    setForm((f) => ({
      ...f,
      title: p.title,
      priority: p.priority || f.priority,
      due_date: f.due_date || p.due_date || '',
    }));
    if (p.tags.length) setTags((t) => [...new Set([...t, ...p.tags])]);
  }

  // Applying a template pre-fills the form; everything stays editable.
  // Deselecting (back to blank) clears what the template added.
  function applyTemplate(id) {
    setTemplateId(id);
    if (!id) { setSteps([]); setTags([]); return; }
    const t = templates.find((x) => x.id === Number(id));
    if (!t) return;
    setForm((f) => ({
      ...f,
      title: f.title || t.name,
      priority: t.default_priority,
      workflow_id: t.default_workflow_id || f.workflow_id,
    }));
    setTags(t.tags || []);
    setSteps((t.steps || []).map((s) => s.text));
  }

  function addTag() {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag)) setTags([...tags, tag]);
    setTagInput('');
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setBusy(true);
    setError(null);
    // Re-parse on submit so quick-add tokens are honored even without a blur.
    const p = parseQuickAdd(form.title);
    try {
      await api('/tasks', {
        method: 'POST',
        body: {
          title: p.title || form.title,
          workflow_id: Number(form.workflow_id),
          project_id: form.project_id ? Number(form.project_id) : null,
          assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
          priority: p.priority || form.priority,
          due_date: form.due_date || p.due_date || null,
          recurrence: form.recurrence,
          tags: [...new Set([...tags, ...p.tags])],
          checklist: steps,
          reminders,
        },
      });
      onCreated();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal new-task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>New task</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={submit}>
          {templates.length > 0 && (
            <label className="field template-picker">Start from template
              <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">— none (blank task) —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}

          <label className="field">Title
            <input autoFocus value={form.title} onChange={set('title')} onBlur={applyQuickParse}
              placeholder="e.g. File GST return tomorrow !high #compliance" required />
            <span className="quick-hint">Quick add: type <code>tomorrow</code> / <code>next mon</code> / <code>jul 20</code> for a date, <code>!high</code> for priority, <code>#tag</code> for tags.</span>
          </label>

          <div className="field-row">
            <label className="field">Board
              <select value={form.workflow_id} onChange={set('workflow_id')}>
                {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="field">Project
              <select value={form.project_id} onChange={set('project_id')}>
                <option value="">No project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">Assignee
              <select value={form.assignee_id} onChange={set('assignee_id')}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label className="field">Priority
              <select value={form.priority} onChange={set('priority')}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="field">Due date
              <input type="date" value={form.due_date} onChange={set('due_date')} />
            </label>
            <label className="field">Repeat
              <select value={form.recurrence} onChange={set('recurrence')}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
          </div>

          <div className="field">
            <span>Reminders</span>
            <RemindersEditor
              items={reminders.map((iso) => ({ remind_at: iso }))}
              dueDate={form.due_date}
              onAdd={(iso) => setReminders((r) => (r.includes(iso) ? r : [...r, iso]))}
              onRemove={(item) => setReminders((r) => r.filter((iso) => iso !== item.remind_at))}
            />
          </div>

          <div className="field">
            <span>Tags</span>
            <div className="tags-row">
              {tags.map((t) => (
                <span key={t} className="task-tag removable">{t}<button type="button" onClick={() => setTags(tags.filter((x) => x !== t))}>✕</button></span>
              ))}
              <input className="tag-inline" placeholder="+ tag" value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
            </div>
          </div>

          <div className="field">
            <span>Steps / checklist{steps.length > 0 && <span className="muted"> — {steps.length} step{steps.length === 1 ? '' : 's'}</span>}</span>
            <StepsEditor steps={steps} onChange={setSteps} placeholder="+ add a step" />
          </div>

          {error && <div className="form-error">{error}</div>}
          <div className="editor-actions">
            <button className="btn btn-primary" disabled={busy || !form.title.trim()}>{busy ? 'Creating…' : 'Create task'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
