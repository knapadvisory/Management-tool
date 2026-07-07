import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';

export default function TaskModal({ taskId, users, workflow, onClose }) {
  const [task, setTask] = useState(null);
  const [comments, setComments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [comment, setComment] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    const d = await api(`/tasks/${taskId}`);
    setTask(d.task);
    setComments(d.comments);
    setActivity(d.activity);
    setDescription(d.task.description || '');
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  async function update(patch) {
    const updated = await api(`/tasks/${taskId}`, { method: 'PATCH', body: patch });
    setTask(updated);
    load();
  }

  async function addComment(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    await api(`/tasks/${taskId}/comments`, { method: 'POST', body: { content: comment } });
    setComment('');
    load();
  }

  async function remove() {
    if (!confirm('Delete this task?')) return;
    await api(`/tasks/${taskId}`, { method: 'DELETE' });
    onClose();
  }

  if (!task) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <input
            className="task-title-input"
            defaultValue={task.title}
            onBlur={(e) => e.target.value.trim() !== task.title && update({ title: e.target.value })}
          />
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="task-fields">
          <label>
            Stage
            <select value={task.stage_id} onChange={(e) => update({ stage_id: Number(e.target.value) })}>
              {workflow.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            Assignee
            <select
              value={task.assignee?.id ?? ''}
              onChange={(e) => update({ assignee_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label>
            Priority
            <select value={task.priority} onChange={(e) => update({ priority: e.target.value })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label>
            Due date
            <input
              type="date"
              value={task.due_date || ''}
              onChange={(e) => update({ due_date: e.target.value || null })}
            />
          </label>
        </div>

        <label className="task-desc-label">
          Description
          <textarea
            rows={3}
            placeholder="Add more detail…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== (task.description || '') && update({ description })}
          />
        </label>

        <div className="task-columns">
          <section>
            <h4>Comments</h4>
            <div className="comment-list">
              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <Avatar user={{ name: c.user_name, avatar_color: c.avatar_color }} size={26} />
                  <div>
                    <strong>{c.user_name}</strong>
                    <div>{c.content}</div>
                  </div>
                </div>
              ))}
              {comments.length === 0 && <div className="empty-hint">No comments yet.</div>}
            </div>
            <form onSubmit={addComment} className="comment-form">
              <input placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn btn-primary" disabled={!comment.trim()}>Post</button>
            </form>
          </section>
          <section>
            <h4>Activity</h4>
            <ul className="activity-list">
              {activity.map((a) => (
                <li key={a.id}><strong>{a.user_name}</strong> {a.action}</li>
              ))}
            </ul>
          </section>
        </div>

        <div className="modal-footer">
          <span className="muted">Created by {task.creator?.name}</span>
          <button className="btn btn-danger" onClick={remove}>Delete task</button>
        </div>
      </div>
    </div>
  );
}
