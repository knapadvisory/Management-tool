import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import TaskModal from './TaskModal.jsx';
import TaskCard from './TaskCard.jsx';
import TaskListView from './TaskListView.jsx';
import TaskCalendarView from './TaskCalendarView.jsx';
import ProjectsModal from './ProjectsModal.jsx';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

export default function TasksBoard({ user, users }) {
  const [workflows, setWorkflows] = useState([]);
  const [workflowId, setWorkflowId] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tags, setTags] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [view, setView] = useState('board'); // board | list | calendar
  const [filters, setFilters] = useState({ project_id: '', tag: '', mine: false, overdue: false, watching: false });
  const [openTaskId, setOpenTaskId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [draft, setDraft] = useState({ title: '', assignee_id: '', priority: 'medium', due_date: '', project_id: '' });
  const [dragTaskId, setDragTaskId] = useState(null);

  const workflow = workflows.find((w) => w.id === workflowId);

  const loadTasks = useCallback(async (wfId) => {
    if (!wfId) return;
    const d = await api(`/tasks?workflow_id=${wfId}`);
    setTasks(d.tasks);
  }, []);

  const loadProjects = useCallback(async () => {
    const d = await api('/projects');
    setProjects(d.projects);
  }, []);

  const loadTags = useCallback(async () => {
    const d = await api('/tasks/meta/tags');
    setTags(d.tags);
  }, []);

  useEffect(() => {
    api('/workflows').then((d) => {
      setWorkflows(d.workflows);
      if (d.workflows.length) setWorkflowId((id) => id ?? d.workflows[0].id);
    });
    loadProjects();
    loadTags();
  }, [loadProjects, loadTags]);

  useEffect(() => { loadTasks(workflowId); }, [workflowId, loadTasks]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onChanged = ({ task }) => {
      if (task.workflow_id !== workflowId) return;
      setTasks((ts) => {
        const idx = ts.findIndex((t) => t.id === task.id);
        if (idx === -1) return [task, ...ts];
        const copy = [...ts]; copy[idx] = task; return copy;
      });
      loadTags();
    };
    const onDeleted = ({ task_id }) => setTasks((ts) => ts.filter((t) => t.id !== task_id));
    const onProjects = () => loadProjects();
    socket.on('task:changed', onChanged);
    socket.on('task:deleted', onDeleted);
    socket.on('projects:changed', onProjects);
    return () => {
      socket.off('task:changed', onChanged);
      socket.off('task:deleted', onDeleted);
      socket.off('projects:changed', onProjects);
    };
  }, [workflowId, loadProjects, loadTags]);

  async function createTask(e) {
    e.preventDefault();
    if (!draft.title.trim()) return;
    await api('/tasks', {
      method: 'POST',
      body: {
        title: draft.title,
        workflow_id: workflowId,
        assignee_id: draft.assignee_id ? Number(draft.assignee_id) : null,
        project_id: draft.project_id ? Number(draft.project_id) : null,
        priority: draft.priority,
        due_date: draft.due_date || null,
      },
    });
    setDraft({ title: '', assignee_id: '', priority: 'medium', due_date: '', project_id: '' });
    setCreating(false);
  }

  async function moveTask(taskId, stageId) {
    await api(`/tasks/${taskId}`, { method: 'PATCH', body: { stage_id: stageId } });
  }

  // Client-side filtering keeps the board responsive to live updates.
  const visibleTasks = tasks.filter((t) => {
    if (filters.mine && t.assignee?.id !== user.id) return false;
    if (filters.project_id && t.project?.id !== Number(filters.project_id)) return false;
    if (filters.tag && !t.tags?.includes(filters.tag)) return false;
    if (filters.watching && !t.watcher_ids?.includes(user.id)) return false;
    if (filters.overdue) {
      if (!t.due_date) return false;
      if (t.due_date >= new Date().toISOString().slice(0, 10)) return false;
    }
    return true;
  });

  if (!workflow) return <div className="boot">Loading board…</div>;

  return (
    <div className="board-page">
      <header className="board-header">
        <h2>Tasks</h2>
        <select value={workflowId} onChange={(e) => setWorkflowId(Number(e.target.value))} title="Workflow">
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>

        <div className="view-switch">
          {['board', 'list', 'calendar'].map((v) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        <button className="btn btn-primary" onClick={() => setCreating(true)}>＋ New task</button>
      </header>

      <div className="filter-bar">
        <select value={filters.project_id} onChange={(e) => setFilters((f) => ({ ...f, project_id: e.target.value }))}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))}>
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
        <label className="checkbox"><input type="checkbox" checked={filters.mine} onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked }))} /> Mine</label>
        <label className="checkbox"><input type="checkbox" checked={filters.watching} onChange={(e) => setFilters((f) => ({ ...f, watching: e.target.checked }))} /> Watching</label>
        <label className="checkbox"><input type="checkbox" checked={filters.overdue} onChange={(e) => setFilters((f) => ({ ...f, overdue: e.target.checked }))} /> Overdue</label>
        <button className="btn btn-sm" onClick={() => setShowProjects(true)}>⚙ Projects</button>
      </div>

      {creating && (
        <form className="new-task-form" onSubmit={createTask}>
          <input autoFocus placeholder="Task title" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
          <select value={draft.assignee_id} onChange={(e) => setDraft((d) => ({ ...d, assignee_id: e.target.value }))}>
            <option value="">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select value={draft.project_id} onChange={(e) => setDraft((d) => ({ ...d, project_id: e.target.value }))}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={draft.priority} onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
          <input type="date" value={draft.due_date} onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value }))} />
          <button className="btn btn-primary" disabled={!draft.title.trim()}>Create</button>
          <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
        </form>
      )}

      {view === 'board' && (
        <div className="board">
          {workflow.stages.map((stage) => {
            const stageTasks = visibleTasks
              .filter((t) => t.stage_id === stage.id)
              .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
            return (
              <div key={stage.id} className="board-column"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragTaskId) moveTask(dragTaskId, stage.id); setDragTaskId(null); }}>
                <div className="column-header"><span>{stage.name}</span><span className="count">{stageTasks.length}</span></div>
                {stageTasks.map((task) => (
                  <TaskCard key={task.id} task={task} onOpen={setOpenTaskId} currentUserId={user.id}
                    draggable onDragStart={() => setDragTaskId(task.id)} />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {view === 'list' && <TaskListView tasks={visibleTasks} onOpen={setOpenTaskId} />}
      {view === 'calendar' && <TaskCalendarView tasks={visibleTasks} onOpen={setOpenTaskId} />}

      {openTaskId && (
        <TaskModal
          taskId={openTaskId}
          user={user}
          users={users}
          workflow={workflow}
          projects={projects}
          onClose={() => setOpenTaskId(null)}
        />
      )}
      {showProjects && (
        <ProjectsModal
          projects={projects}
          onClose={() => setShowProjects(false)}
          onChanged={() => { loadProjects(); loadTasks(workflowId); }}
        />
      )}
    </div>
  );
}
