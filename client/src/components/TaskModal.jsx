import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, uploadFiles, fileUrl } from '../api.js';
import { formatBytes } from '../format.js';
import Avatar from './Avatar.jsx';
import TaskChat from './TaskChat.jsx';
import RemindersEditor from './RemindersEditor.jsx';
import StatusControl from './StatusControl.jsx';
import AssigneePicker from './AssigneePicker.jsx';

export default function TaskModal({ taskId, user, users, workflows = [], projects = [], clients = [], onClose, inline = false }) {
  const [tab, setTab] = useState('chat');
  const [task, setTask] = useState(null);
  const [comments, setComments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [watchers, setWatchers] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [comment, setComment] = useState('');
  const [description, setDescription] = useState('');
  const [newItem, setNewItem] = useState('');
  const [newTag, setNewTag] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    let d;
    try {
      d = await api(`/tasks/${taskId}`);
    } catch {
      onClose(); // task was deleted, or we no longer have access
      return;
    }
    setTask(d.task);
    setComments(d.comments);
    setActivity(d.activity);
    setChecklist(d.checklist);
    setWatchers(d.watchers);
    setAttachments(d.attachments);
    setReminders(d.reminders || []);
    setDescription(d.task.description || '');
  }, [taskId, onClose]);

  useEffect(() => { load(); }, [load]);

  async function update(patch) {
    await api(`/tasks/${taskId}`, { method: 'PATCH', body: patch });
    load();
  }

  async function addComment(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    await api(`/tasks/${taskId}/comments`, { method: 'POST', body: { content: comment } });
    setComment('');
    load();
  }

  async function addChecklistItem(e) {
    e.preventDefault();
    if (!newItem.trim()) return;
    const items = await api(`/tasks/${taskId}/checklist`, { method: 'POST', body: { text: newItem } });
    setChecklist(items);
    setNewItem('');
  }
  async function toggleItem(item) {
    setChecklist(await api(`/tasks/${taskId}/checklist/${item.id}`, { method: 'PATCH', body: { is_done: !item.is_done } }));
  }
  async function deleteItem(item) {
    setChecklist(await api(`/tasks/${taskId}/checklist/${item.id}`, { method: 'DELETE' }));
  }

  async function addTag(e) {
    e.preventDefault();
    const tag = newTag.trim();
    if (!tag) return;
    setTask(await api(`/tasks/${taskId}/tags`, { method: 'POST', body: { tag } }));
    setNewTag('');
  }
  async function removeTag(tag) {
    setTask(await api(`/tasks/${taskId}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }));
  }

  async function toggleWatch() {
    const watching = watchers.some((w) => w.id === user.id);
    await api(`/tasks/${taskId}/watch`, { method: watching ? 'DELETE' : 'POST' });
    load();
  }

  async function onFiles(e) {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(files);
      setAttachments(await api(`/tasks/${taskId}/attachments`, { method: 'POST', body: { attachment_ids: uploaded.map((a) => a.id) } }));
    } catch (err) { alert(err.message); }
    setUploading(false);
  }
  async function removeAttachment(att) {
    setAttachments(await api(`/tasks/${taskId}/attachments/${att.id}`, { method: 'DELETE' }));
  }

  async function addReminder(iso) {
    setReminders(await api(`/tasks/${taskId}/reminders`, { method: 'POST', body: { remind_at: iso } }));
  }
  async function removeReminder(rem) {
    setReminders(await api(`/tasks/${taskId}/reminders/${rem.id}`, { method: 'DELETE' }));
  }

  async function remove() {
    if (!confirm('Delete this task?')) return;
    await api(`/tasks/${taskId}`, { method: 'DELETE' });
    onClose();
  }

  async function archive() {
    await api(`/tasks/${taskId}/archive`, { method: 'POST' });
    onClose();
  }
  async function unarchive() {
    await api(`/tasks/${taskId}/unarchive`, { method: 'POST' });
    onClose();
  }

  if (!task) return null;
  const workflow = workflows.find((w) => w.id === task.workflow_id) || workflows[0];
  const watching = watchers.some((w) => w.id === user.id);
  const canArchive = user.role === 'admin' || task.creator?.id === user.id || (task.assignees || []).some((a) => a.id === user.id);
  const doneCount = checklist.filter((i) => i.is_done).length;
  const progress = checklist.length ? Math.round((doneCount / checklist.length) * 100) : 0;

  const inner = (
    <div className={inline ? 'task-modal inline' : 'modal task-modal'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <input
            className="task-title-input"
            defaultValue={task.title}
            onBlur={(e) => e.target.value.trim() && e.target.value !== task.title && update({ title: e.target.value })}
          />
          <button className={`btn btn-sm ${watching ? 'watching' : ''}`} onClick={toggleWatch}>
            {watching ? '👁 Watching' : '👁 Watch'}
          </button>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <StatusControl task={task} onUpdate={update} />

        <div className="task-fields">
          <label>Stage
            <select value={task.stage_id} onChange={(e) => update({ stage_id: Number(e.target.value) })}>
              {(workflow?.stages || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Assignees
            <AssigneePicker users={users} value={(task.assignees || []).map((a) => a.id)}
              onChange={(ids) => update({ assignee_ids: ids })} />
          </label>
          <label>Project
            <select value={task.project?.id ?? ''} onChange={(e) => update({ project_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {clients.length > 0 && (
            <label>Client
              <select value={task.client?.id ?? ''} onChange={(e) => update({ client_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">No client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label>Priority
            <select value={task.priority} onChange={(e) => update({ priority: e.target.value })}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
            </select>
          </label>
          <label>Due date
            <input type="date" value={task.due_date || ''} onChange={(e) => update({ due_date: e.target.value || null })} />
          </label>
          <label>Repeat
            <select value={task.recurrence || 'none'} onChange={(e) => update({ recurrence: e.target.value })}>
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
        </div>

        <div className="tags-row">
          {task.tags?.map((t) => (
            <span key={t} className="task-tag removable">{t}<button onClick={() => removeTag(t)}>✕</button></span>
          ))}
          <form className="tag-add" onSubmit={addTag}>
            <input placeholder="+ tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
          </form>
        </div>

        <label className="task-desc-label">Description
          <textarea rows={2} placeholder="Add more detail…" value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== (task.description || '') && update({ description })} />
        </label>

        <div className="checklist-section">
          <div className="checklist-head">
            <h4>Checklist</h4>
            {checklist.length > 0 && <span className="muted">{doneCount}/{checklist.length}</span>}
          </div>
          {checklist.length > 0 && (
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
          )}
          {checklist.map((item) => (
            <div key={item.id} className={`checklist-item ${item.is_done ? 'done' : ''}`}>
              <input type="checkbox" checked={!!item.is_done} onChange={() => toggleItem(item)} />
              <span>{item.text}</span>
              <button className="icon-btn" onClick={() => deleteItem(item)}>✕</button>
            </div>
          ))}
          <form className="checklist-add" onSubmit={addChecklistItem}>
            <input placeholder="+ add a subtask" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
          </form>
        </div>

        <div className="attachments-section">
          <div className="checklist-head">
            <h4>Attachments</h4>
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : '📎 Attach'}
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={onFiles} />
          </div>
          {attachments.map((a) => (
            <div key={a.id} className="task-attachment">
              <a href={fileUrl(a.id)} target="_blank" rel="noopener noreferrer">📄 {a.original_name}</a>
              <span className="muted">{formatBytes(a.size)}</span>
              <button className="icon-btn" onClick={() => removeAttachment(a)}>✕</button>
            </div>
          ))}
          {attachments.length === 0 && <div className="empty-hint">No files attached.</div>}
        </div>

        <div className="reminders-section">
          <div className="checklist-head">
            <h4>Reminders</h4>
            {task.recurrence && task.recurrence !== 'none' && <span className="repeat-badge">🔁 repeats {task.recurrence}</span>}
          </div>
          <RemindersEditor items={reminders} dueDate={task.due_date} onAdd={addReminder} onRemove={removeReminder} />
        </div>

        <div className="watchers-row">
          <span className="muted">Watchers:</span>
          {watchers.map((w) => <Avatar key={w.id} user={w} size={24} />)}
          {watchers.length === 0 && <span className="muted">none</span>}
        </div>

        <div className="task-tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>💬 Chat</button>
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>📝 Notes{comments.length > 0 ? ` (${comments.length})` : ''}</button>
          <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>🕑 Activity</button>
        </div>

        {tab === 'chat' && <TaskChat taskId={taskId} user={user} />}

        {tab === 'notes' && (
          <section className="notes-section">
            <p className="muted notes-hint">Notes are a lasting record for this task. For back-and-forth, use Chat.</p>
            <div className="comment-list">
              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <Avatar user={{ name: c.user_name, avatar_color: c.avatar_color }} size={26} />
                  <div><strong>{c.user_name}</strong><div>{c.content}</div></div>
                </div>
              ))}
              {comments.length === 0 && <div className="empty-hint">No notes yet.</div>}
            </div>
            <form onSubmit={addComment} className="comment-form">
              <input placeholder="Add a note…" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn btn-primary" disabled={!comment.trim()}>Add note</button>
            </form>
          </section>
        )}

        {tab === 'activity' && (
          <section>
            <ul className="activity-list">
              {activity.map((a) => <li key={a.id}><strong>{a.user_name}</strong> {a.action}</li>)}
              {activity.length === 0 && <div className="empty-hint">No activity yet.</div>}
            </ul>
          </section>
        )}

        <div className="modal-footer">
          <span className="muted">Created by {task.creator?.name}</span>
          <div className="footer-actions">
            {canArchive && (task.archived_at
              ? <button className="btn btn-sm" onClick={unarchive}>♻ Restore</button>
              : !!task.completed_at && <button className="btn btn-sm" onClick={archive} title="Move this completed task to the archive">🗄 Archive</button>)}
            {user.role === 'admin'
              ? <button className="btn btn-danger" onClick={remove}>Delete task</button>
              : <span className="muted">Only an admin can delete a task</span>}
          </div>
        </div>
    </div>
  );

  return inline ? inner : <div className="modal-overlay" onClick={onClose}>{inner}</div>;
}
