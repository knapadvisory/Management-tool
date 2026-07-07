import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';
import TaskModal from './TaskModal.jsx';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

export default function TasksBoard({ user, users }) {
  const [workflows, setWorkflows] = useState([]);
  const [workflowId, setWorkflowId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [onlyMine, setOnlyMine] = useState(false);
  const [openTaskId, setOpenTaskId] = useState(null);
  const [creatingIn, setCreatingIn] = useState(false);
  const [draft, setDraft] = useState({ title: '', assignee_id: '', priority: 'medium', due_date: '' });
  const [dragTaskId, setDragTaskId] = useState(null);

  const workflow = workflows.find((w) => w.id === workflowId);

  const loadTasks = useCallback(async (wfId) => {
    if (!wfId) return;
    const d = await api(`/tasks?workflow_id=${wfId}`);
    setTasks(d.tasks);
  }, []);

  useEffect(() => {
    api('/workflows').then((d) => {
      setWorkflows(d.workflows);
      if (d.workflows.length) setWorkflowId((id) => id ?? d.workflows[0].id);
    });
  }, []);

  useEffect(() => { loadTasks(workflowId); }, [workflowId, loadTasks]);

  // Live updates when anyone changes a task.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onChanged = ({ task }) => {
      if (task.workflow_id !== workflowId) return;
      setTasks((ts) => {
        const idx = ts.findIndex((t) => t.id === task.id);
        if (idx === -1) return [task, ...ts];
        const copy = [...ts];
        copy[idx] = task;
        return copy;
      });
    };
    const onDeleted = ({ task_id }) => setTasks((ts) => ts.filter((t) => t.id !== task_id));
    socket.on('task:changed', onChanged);
    socket.on('task:deleted', onDeleted);
    return () => {
      socket.off('task:changed', onChanged);
      socket.off('task:deleted', onDeleted);
    };
  }, [workflowId]);

  async function createTask(e) {
    e.preventDefault();
    if (!draft.title.trim()) return;
    await api('/tasks', {
      method: 'POST',
      body: {
        title: draft.title,
        workflow_id: workflowId,
        assignee_id: draft.assignee_id ? Number(draft.assignee_id) : null,
        priority: draft.priority,
        due_date: draft.due_date || null,
      },
    });
    setDraft({ title: '', assignee_id: '', priority: 'medium', due_date: '' });
    setCreatingIn(false);
    loadTasks(workflowId);
  }

  async function moveTask(taskId, stageId) {
    await api(`/tasks/${taskId}`, { method: 'PATCH', body: { stage_id: stageId } });
  }

  const visibleTasks = onlyMine ? tasks.filter((t) => t.assignee?.id === user.id) : tasks;

  if (!workflow) return <div className="boot">Loading board…</div>;

  return (
    <div className="board-page">
      <header className="board-header">
        <h2>Tasks</h2>
        <select value={workflowId} onChange={(e) => setWorkflowId(Number(e.target.value))}>
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          Assigned to me
        </label>
        <button className="btn btn-primary" onClick={() => setCreatingIn(true)}>＋ New task</button>
      </header>

      {creatingIn && (
        <form className="new-task-form" onSubmit={createTask}>
          <input
            autoFocus
            placeholder="Task title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          <select value={draft.assignee_id} onChange={(e) => setDraft((d) => ({ ...d, assignee_id: e.target.value }))}>
            <option value="">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select value={draft.priority} onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <input type="date" value={draft.due_date} onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value }))} />
          <button className="btn btn-primary" disabled={!draft.title.trim()}>Create</button>
          <button type="button" className="btn" onClick={() => setCreatingIn(false)}>Cancel</button>
        </form>
      )}

      <div className="board">
        {workflow.stages.map((stage) => {
          const stageTasks = visibleTasks
            .filter((t) => t.stage_id === stage.id)
            .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
          return (
            <div
              key={stage.id}
              className="board-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragTaskId) moveTask(dragTaskId, stage.id); setDragTaskId(null); }}
            >
              <div className="column-header">
                <span>{stage.name}</span>
                <span className="count">{stageTasks.length}</span>
              </div>
              {stageTasks.map((task) => (
                <div
                  key={task.id}
                  className="task-card"
                  draggable
                  onDragStart={() => setDragTaskId(task.id)}
                  onClick={() => setOpenTaskId(task.id)}
                >
                  <div className="task-title">{task.title}</div>
                  <div className="task-meta">
                    <span className={`priority priority-${task.priority}`}>{task.priority}</span>
                    {task.due_date && <span className="due">📅 {task.due_date}</span>}
                    {task.comment_count > 0 && <span className="comments">💬 {task.comment_count}</span>}
                    {task.assignee && <Avatar user={task.assignee} size={22} />}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {openTaskId && (
        <TaskModal
          taskId={openTaskId}
          users={users}
          workflow={workflow}
          onClose={() => { setOpenTaskId(null); loadTasks(workflowId); }}
        />
      )}
    </div>
  );
}
