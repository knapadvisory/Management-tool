import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import TaskModal from './TaskModal.jsx';
import TaskCard from './TaskCard.jsx';
import TaskListView from './TaskListView.jsx';
import TaskCalendarView from './TaskCalendarView.jsx';
import ProjectsModal from './ProjectsModal.jsx';
import TemplatesModal from './TemplatesModal.jsx';
import NewTaskModal from './NewTaskModal.jsx';
import { TASK_STATUSES } from '../status.js';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const localYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function TasksBoard({ user, users, openTaskRequest, onTaskOpened }) {
  const [workflows, setWorkflows] = useState([]);
  const [workflowId, setWorkflowId] = useState(null);
  const [projects, setProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [tags, setTags] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [view, setView] = useState('board'); // board | list | calendar
  const [filters, setFilters] = useState({ project_id: '', tag: '', mine: false, due: '', watching: false, status: '' });
  const [openTaskId, setOpenTaskId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [dragTaskId, setDragTaskId] = useState(null);
  const [archivedView, setArchivedView] = useState(false);

  const allBoards = workflowId === 'all';
  const workflow = workflows.find((w) => w.id === workflowId);

  const loadTasks = useCallback(async (wfId, archived = false) => {
    if (!wfId) return;
    const qs = new URLSearchParams();
    if (wfId !== 'all') qs.set('workflow_id', wfId);
    if (archived) qs.set('archived', '1');
    const d = await api(`/tasks${qs.toString() ? `?${qs}` : ''}`);
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

  const loadTemplates = useCallback(async () => {
    const d = await api('/templates');
    setTemplates(d.templates);
  }, []);

  useEffect(() => {
    api('/workflows').then((d) => {
      setWorkflows(d.workflows);
      if (d.workflows.length) setWorkflowId((id) => id ?? d.workflows[0].id);
    });
    loadProjects();
    loadTags();
    loadTemplates();
  }, [loadProjects, loadTags, loadTemplates]);

  useEffect(() => { loadTasks(workflowId, archivedView); }, [workflowId, archivedView, loadTasks]);

  // The Archived list is workflow-agnostic and read-only, so use List view.
  useEffect(() => {
    if (archivedView && view === 'board') setView('list');
  }, [archivedView, view]);

  // Open a specific task when navigated from a notification.
  useEffect(() => {
    if (openTaskRequest) { setOpenTaskId(openTaskRequest); onTaskOpened?.(); }
  }, [openTaskRequest, onTaskOpened]);

  // The Kanban board needs one workflow's columns, so "All tasks" uses List/Calendar.
  useEffect(() => {
    if (allBoards && view === 'board') setView('list');
  }, [allBoards, view]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onChanged = ({ task }) => {
      if (workflowId !== 'all' && task.workflow_id !== workflowId) return;
      // Keep each list to its side of the archive line: an archived task
      // leaves the active board, and a restored one leaves the archive view.
      const belongs = archivedView ? !!task.archived_at : !task.archived_at;
      setTasks((ts) => {
        const idx = ts.findIndex((t) => t.id === task.id);
        if (!belongs) return idx === -1 ? ts : ts.filter((t) => t.id !== task.id);
        if (idx === -1) return [task, ...ts];
        const copy = [...ts]; copy[idx] = task; return copy;
      });
      loadTags();
    };
    const onDeleted = ({ task_id }) => setTasks((ts) => ts.filter((t) => t.id !== task_id));
    const onProjects = () => loadProjects();
    const onTemplates = () => loadTemplates();
    socket.on('task:changed', onChanged);
    socket.on('task:deleted', onDeleted);
    socket.on('projects:changed', onProjects);
    socket.on('templates:changed', onTemplates);
    return () => {
      socket.off('task:changed', onChanged);
      socket.off('task:deleted', onDeleted);
      socket.off('projects:changed', onProjects);
      socket.off('templates:changed', onTemplates);
    };
  }, [workflowId, archivedView, loadProjects, loadTags, loadTemplates]);

  async function archiveAllDone() {
    const done = visibleTasks.filter((t) => t.completed_at);
    if (!done.length) return;
    if (!window.confirm(`Archive ${done.length} completed task${done.length > 1 ? 's' : ''}? You can restore them from the Archived view.`)) return;
    await api('/tasks/archive/done', { method: 'POST' });
    loadTasks(workflowId, archivedView);
  }

  async function moveTask(taskId, stageId) {
    await api(`/tasks/${taskId}`, { method: 'PATCH', body: { stage_id: stageId } });
  }

  // Smart-date boundaries (local), for the "Today / Next 7 days / Upcoming" scopes.
  const todayYMD = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return localYMD(d); })();
  const in7YMD = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 7); return localYMD(d); })();

  // Client-side filtering keeps the board responsive to live updates.
  const visibleTasks = tasks.filter((t) => {
    if (filters.mine && t.assignee?.id !== user.id) return false;
    if (filters.project_id && t.project?.id !== Number(filters.project_id)) return false;
    if (filters.tag && !t.tags?.includes(filters.tag)) return false;
    if (filters.watching && !t.watcher_ids?.includes(user.id)) return false;
    if (filters.status && (t.status || 'in_progress') !== filters.status) return false;
    switch (filters.due) {
      case 'overdue': if (!t.due_date || t.due_date >= todayYMD) return false; break;
      case 'today': if (t.due_date !== todayYMD) return false; break;
      case 'next7': if (!t.due_date || t.due_date < todayYMD || t.due_date > in7YMD) return false; break;
      case 'upcoming': if (!t.due_date || t.due_date < todayYMD) return false; break;
      case 'nodate': if (t.due_date) return false; break;
      default: break;
    }
    return true;
  });

  if (!workflows.length) return <div className="boot">Loading board…</div>;

  return (
    <div className="board-page">
      <header className="board-header">
        <h2>Tasks</h2>
        <label className="board-select">Board:
          <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All tasks</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>

        <div className="view-switch">
          {(allBoards || archivedView ? ['list', 'calendar'] : ['board', 'list', 'calendar']).map((v) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        <button className={`btn btn-sm ${archivedView ? 'active' : ''}`} onClick={() => setArchivedView((v) => !v)}
          title="Tasks auto-archive 7 days after they're done">
          {archivedView ? '← Active tasks' : '🗄 Archived'}
        </button>
        {!archivedView && <button className="btn btn-primary" onClick={() => setCreating(true)}>＋ New task</button>}
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
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} title="Filter by status">
          <option value="">All statuses</option>
          {TASK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filters.due} onChange={(e) => setFilters((f) => ({ ...f, due: e.target.value }))} title="Filter by due date">
          <option value="">Any date</option>
          <option value="today">📌 Today</option>
          <option value="next7">🗓 Next 7 days</option>
          <option value="upcoming">⏭ Upcoming</option>
          <option value="overdue">⚠ Overdue</option>
          <option value="nodate">No due date</option>
        </select>
        <label className="checkbox"><input type="checkbox" checked={filters.mine} onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked }))} /> Mine</label>
        <label className="checkbox"><input type="checkbox" checked={filters.watching} onChange={(e) => setFilters((f) => ({ ...f, watching: e.target.checked }))} /> Watching</label>
        <button className="btn btn-sm" onClick={() => setShowProjects(true)}>⚙ Projects</button>
        <button className="btn btn-sm" onClick={() => setShowTemplates(true)}>⧉ Templates</button>
        {!archivedView && visibleTasks.some((t) => t.completed_at) && (
          <button className="btn btn-sm" onClick={archiveAllDone} title="Move all completed tasks to the archive">🗄 Archive done</button>
        )}
      </div>

      {view === 'board' && !allBoards && workflow && (
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
          workflows={workflows}
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
      {showTemplates && (
        <TemplatesModal
          templates={templates}
          workflows={workflows}
          onClose={() => setShowTemplates(false)}
          onChanged={loadTemplates}
        />
      )}
      {creating && (
        <NewTaskModal
          workflows={workflows}
          projects={projects}
          users={users}
          templates={templates}
          defaultWorkflowId={allBoards ? (workflows[0]?.id) : workflowId}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); loadTasks(workflowId); loadTags(); }}
        />
      )}
    </div>
  );
}
