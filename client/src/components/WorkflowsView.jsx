import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';

const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');

// A stage's dot/bar colour: the completing column is green; the rest cycle a
// small palette by position so a long pipeline reads at a glance.
const DOTS = ['#9C978C', '#3E6FBF', '#C4841D', '#7C5CBF', '#C15B4A', '#2F6B74', '#B08900'];
const stageColor = (s, i) => (s.is_done ? '#2F8F5B' : DOTS[i % DOTS.length]);

const Grip = () => (
  <svg className="wf-grip" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="4" r="1.3" /><circle cx="11" cy="4" r="1.3" /><circle cx="5" cy="8" r="1.3" />
    <circle cx="11" cy="8" r="1.3" /><circle cx="5" cy="12" r="1.3" /><circle cx="11" cy="12" r="1.3" />
  </svg>
);
const XIcon = () => (<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>);
const Trash = () => (<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>);
const Circle = () => (<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" /></svg>);
const ListIcon = () => (<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M7 5h9M7 10h9M7 15h9M3.5 5h.01M3.5 10h.01M3.5 15h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>);
const PRIO = { urgent: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#94a3b8' };

export default function WorkflowsView({ onOpenTask }) {
  const [workflows, setWorkflows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stages, setStages] = useState(['To Do', 'In Progress', 'Done']);
  const [error, setError] = useState(null);
  const [focusStage, setFocusStage] = useState(null); // stage id to focus after adding
  const [draggingId, setDraggingId] = useState(null);
  const [openStage, setOpenStage] = useState(null);    // stage id whose task list is expanded
  const [wfTasks, setWfTasks] = useState({});          // wfId -> tasks[] (cache)
  const drag = useRef(null);       // { wfId, index }
  const wfRef = useRef([]);        // latest workflows, for drag-end persistence
  const nameRefs = useRef({});     // stageId -> contentEditable el
  wfRef.current = workflows;

  async function load() {
    const d = await api('/workflows');
    setWorkflows(d.workflows);
  }
  useEffect(() => { load(); }, []);

  // Focus + select a freshly-added stage's name for immediate rename.
  useEffect(() => {
    if (!focusStage) return;
    const el = nameRefs.current[focusStage];
    if (el) {
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      setFocusStage(null);
    }
  }, [focusStage, workflows]);

  async function createWorkflow(e) {
    e.preventDefault();
    setError(null);
    try {
      await api('/workflows', { method: 'POST', body: { name, description, stages } });
      setCreating(false); setName(''); setDescription(''); setStages(['To Do', 'In Progress', 'Done']);
      load();
    } catch (err) { setError(err.message); }
  }

  async function addStage(wf) {
    const before = new Set(wf.stages.map((s) => s.id));
    try {
      const r = await api(`/workflows/${wf.id}/stages`, { method: 'POST', body: { name: 'New stage' } });
      const created = r.stages.find((s) => !before.has(s.id));
      setWorkflows((ws) => ws.map((w) => (w.id === wf.id ? r : w)));
      if (created) setFocusStage(created.id);
    } catch (err) { alert(err.message); }
  }

  async function renameStage(wfId, stage, text) {
    const nm = (text || '').trim();
    if (!nm || nm === stage.name) { load(); return; } // revert empties/no-ops
    try { await api(`/workflows/${wfId}/stages/${stage.id}`, { method: 'PATCH', body: { name: nm } }); load(); }
    catch (err) { alert(err.message); load(); }
  }

  async function toggleDone(wfId, stage) {
    try { await api(`/workflows/${wfId}/stages/${stage.id}`, { method: 'PATCH', body: { is_done: !stage.is_done } }); load(); }
    catch (err) { alert(err.message); }
  }

  async function deleteStage(wfId, stageId) {
    try { await api(`/workflows/${wfId}/stages/${stageId}`, { method: 'DELETE' }); load(); }
    catch (err) { alert(err.message); }
  }

  async function deleteWorkflow(wf) {
    if (!confirm(`Delete workflow "${wf.name}"?`)) return;
    try { await api(`/workflows/${wf.id}`, { method: 'DELETE' }); load(); }
    catch (err) { alert(err.message); }
  }

  // Expand/collapse the list of tasks sitting in a stage (fetched once per
  // workflow, then filtered by stage on the client).
  async function toggleTasks(wf, stage) {
    if (openStage === stage.id) { setOpenStage(null); return; }
    setOpenStage(stage.id);
    if (!wfTasks[wf.id]) {
      try {
        const d = await api(`/tasks?workflow_id=${wf.id}`);
        setWfTasks((m) => ({ ...m, [wf.id]: d.tasks || [] }));
      } catch { setWfTasks((m) => ({ ...m, [wf.id]: [] })); }
    }
  }
  const tasksInStage = (wfId, stageId) => (wfTasks[wfId] || []).filter((t) => t.stage_id === stageId);

  // --- Drag to reorder (live preview, persisted on drop) ---
  function onDragStart(wf, i, stageId) { drag.current = { wfId: wf.id, index: i }; setDraggingId(stageId); }
  function onDragOverRow(wf, i) {
    const d = drag.current;
    if (!d || d.wfId !== wf.id || d.index === i) return;
    setWorkflows((ws) => ws.map((w) => {
      if (w.id !== wf.id) return w;
      const arr = [...w.stages];
      const [m] = arr.splice(d.index, 1);
      arr.splice(i, 0, m);
      return { ...w, stages: arr };
    }));
    drag.current = { wfId: wf.id, index: i };
  }
  async function onDragEnd(wf) {
    const d = drag.current; drag.current = null; setDraggingId(null);
    if (!d) return;
    const current = wfRef.current.find((w) => w.id === wf.id);
    if (!current) return;
    try { await api(`/workflows/${wf.id}/stages-order`, { method: 'PATCH', body: { order: current.stages.map((s) => s.id) } }); load(); }
    catch { load(); }
  }

  return (
    <div className="workflows-page">
      <header className="board-header">
        <h2>Workflows</h2>
        <button className="btn btn-primary" onClick={() => setCreating((c) => !c)}>＋ New workflow</button>
      </header>
      <p className="muted">
        A workflow is the ordered set of stages a task moves through. Drag a stage to reorder it, click a name to rename it, and mark the stage that completes a task.
      </p>

      {creating && (
        <form className="workflow-form" onSubmit={createWorkflow}>
          <input placeholder="Workflow name (e.g. Client Onboarding)" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="stage-editor">
            <span className="muted">Stages (in order):</span>
            {stages.map((s, i) => (
              <span key={i} className="stage-chip">
                <input value={s} onChange={(e) => setStages((st) => st.map((x, j) => (j === i ? e.target.value : x)))} />
                {stages.length > 2 && (<button type="button" onClick={() => setStages((st) => st.filter((_, j) => j !== i))}>✕</button>)}
              </span>
            ))}
            <button type="button" className="btn" onClick={() => setStages((st) => [...st, ''])}>＋ Stage</button>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div>
            <button className="btn btn-primary">Create workflow</button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="workflow-list">
        {workflows.map((wf) => {
          const total = wf.stages.reduce((n, s) => n + (s.task_count || 0), 0);
          return (
            <div key={wf.id} className="workflow-card">
              <div className="wf-head">
                <div className="wf-title-block">
                  <span className="wf-title">{wf.name}</span>
                  {wf.description && <span className="wf-desc">{wf.description}</span>}
                </div>
                <div className="wf-meta">
                  <span className="wf-count"><b>{wf.task_count}</b> task{wf.task_count === 1 ? '' : 's'}</span>
                  <button className="wf-icon-btn danger wf-tip" data-tip="Delete workflow" onClick={() => deleteWorkflow(wf)}><Trash /></button>
                </div>
              </div>

              <div className="stage-list">
                {wf.stages.map((s, i) => {
                  const color = stageColor(s, i);
                  const pct = total ? Math.round(((s.task_count || 0) / total) * 100) : 0;
                  return (
                    <React.Fragment key={s.id}>
                    <div
                      className={`wf-stage-row ${draggingId === s.id ? 'dragging' : ''}`}
                      onDragOver={(e) => { e.preventDefault(); onDragOverRow(wf, i); }}
                    >
                      <span
                        className="wf-grip-wrap" draggable
                        onDragStart={() => onDragStart(wf, i, s.id)}
                        onDragEnd={() => onDragEnd(wf)}
                        title="Drag to reorder"
                      ><Grip /></span>
                      <span className="wf-dot" style={{ background: color }} />
                      <span
                        className="wf-stage-name" contentEditable suppressContentEditableWarning spellCheck={false}
                        ref={(el) => { nameRefs.current[s.id] = el; }}
                        onBlur={(e) => renameStage(wf.id, s, e.currentTarget.textContent)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                          if (e.key === 'Escape') { e.currentTarget.textContent = s.name; e.currentTarget.blur(); }
                        }}
                      >{s.name}</span>
                      <div className="wf-bar-wrap">
                        <div className="wf-bar-track"><div className="wf-bar-fill" style={{ width: `${pct}%`, background: color }} /></div>
                        <span className="wf-stage-count">{s.task_count || 0}</span>
                      </div>
                      <button
                        className={`wf-view-tasks wf-tip ${openStage === s.id ? 'open' : ''}`}
                        data-tip={`View the ${s.task_count || 0} task${(s.task_count || 0) === 1 ? '' : 's'} in “${s.name}”`}
                        onClick={() => toggleTasks(wf, s)}
                      ><ListIcon /> Tasks</button>
                      <div className="wf-row-actions" style={s.is_done ? { opacity: 1 } : undefined}>
                        {s.is_done ? (
                          <button className="wf-complete-badge wf-tip" data-tip="This stage completes a task — click to unset" onClick={() => toggleDone(wf.id, s)}>COMPLETES TASK</button>
                        ) : (
                          <button className="wf-complete-toggle wf-tip" data-tip="Mark as the stage that completes a task" onClick={() => toggleDone(wf.id, s)}><Circle /></button>
                        )}
                        <button className="wf-icon-btn wf-tip" data-tip="Delete stage" onClick={() => deleteStage(wf.id, s.id)}><XIcon /></button>
                      </div>
                    </div>
                    {openStage === s.id && (
                      <div className="wf-task-panel">
                        {!wfTasks[wf.id] ? (
                          <div className="wf-task-empty">Loading…</div>
                        ) : tasksInStage(wf.id, s.id).length === 0 ? (
                          <div className="wf-task-empty">No tasks in this stage.</div>
                        ) : (
                          tasksInStage(wf.id, s.id).map((t) => (
                            <button key={t.id} className="wf-task-item" onClick={() => onOpenTask?.(t.id)}>
                              <span className="wf-task-prio" style={{ background: PRIO[t.priority] || PRIO.low }} title={t.priority} />
                              <span className="wf-task-title">{t.title}</span>
                              {t.due_date && <span className="wf-task-due">{fmtDate(t.due_date)}</span>}
                              {(t.assignees?.[0] || t.assignee) && <Avatar user={t.assignees?.[0] || t.assignee} size={20} />}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                    </React.Fragment>
                  );
                })}
                {wf.stages.length === 0 && <div className="wf-empty-note">No stages yet — add the first below.</div>}
              </div>
              <button className="wf-add-stage" onClick={() => addStage(wf)}>＋ Add stage</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
