import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function WorkflowsView() {
  const [workflows, setWorkflows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stages, setStages] = useState(['To Do', 'In Progress', 'Done']);
  const [error, setError] = useState(null);
  const [newStageFor, setNewStageFor] = useState({});
  const [edit, setEdit] = useState(null);       // { stageId, value } — inline rename
  const [insert, setInsert] = useState(null);    // { wfId, index, value } — insert between
  const drag = useRef(null);                      // { wfId, index } — drag source

  async function load() {
    const d = await api('/workflows');
    setWorkflows(d.workflows);
  }
  useEffect(() => { load(); }, []);

  async function createWorkflow(e) {
    e.preventDefault();
    setError(null);
    try {
      await api('/workflows', { method: 'POST', body: { name, description, stages } });
      setCreating(false); setName(''); setDescription(''); setStages(['To Do', 'In Progress', 'Done']);
      load();
    } catch (err) { setError(err.message); }
  }

  async function addStage(wfId) {
    const stageName = (newStageFor[wfId] || '').trim();
    if (!stageName) return;
    try {
      await api(`/workflows/${wfId}/stages`, { method: 'POST', body: { name: stageName } });
      setNewStageFor((s) => ({ ...s, [wfId]: '' }));
      load();
    } catch (err) { alert(err.message); }
  }

  async function insertStage(wfId, index) {
    const stageName = (insert?.value || '').trim();
    if (!stageName) { setInsert(null); return; }
    try {
      await api(`/workflows/${wfId}/stages`, { method: 'POST', body: { name: stageName, position: index } });
      setInsert(null);
      load();
    } catch (err) { alert(err.message); }
  }

  async function renameStage(wfId, stage) {
    const nm = (edit?.value || '').trim();
    setEdit(null);
    if (!nm || nm === stage.name) return;
    try { await api(`/workflows/${wfId}/stages/${stage.id}`, { method: 'PATCH', body: { name: nm } }); load(); }
    catch (err) { alert(err.message); }
  }

  async function toggleDone(wfId, stage) {
    try { await api(`/workflows/${wfId}/stages/${stage.id}`, { method: 'PATCH', body: { is_done: !stage.is_done } }); load(); }
    catch (err) { alert(err.message); }
  }

  async function reorder(wf, ids) {
    // Optimistic: re-render the new order immediately, then persist.
    setWorkflows((ws) => ws.map((w) => (w.id === wf.id ? { ...w, stages: ids.map((id) => w.stages.find((s) => s.id === id)) } : w)));
    try { await api(`/workflows/${wf.id}/stages-order`, { method: 'PATCH', body: { order: ids } }); load(); }
    catch (err) { alert(err.message); load(); }
  }

  function moveStage(wf, from, to) {
    if (to < 0 || to >= wf.stages.length || from === to) return;
    const ids = wf.stages.map((s) => s.id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    reorder(wf, ids);
  }

  function onDrop(wf, to) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.wfId !== wf.id) return;
    if (d.index === to) return;
    const ids = wf.stages.map((s) => s.id);
    const [m] = ids.splice(d.index, 1);
    ids.splice(to > d.index ? to - 1 : to, 0, m); // drop-before-target semantics
    reorder(wf, ids);
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

  // A small "+" between stages to insert a column there.
  const InsertGap = ({ wf, index }) => (
    insert && insert.wfId === wf.id && insert.index === index ? (
      <input
        className="stage-insert-input" autoFocus placeholder="New stage…"
        value={insert.value}
        onChange={(e) => setInsert((s) => ({ ...s, value: e.target.value }))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); insertStage(wf.id, index); } if (e.key === 'Escape') setInsert(null); }}
        onBlur={() => insertStage(wf.id, index)}
      />
    ) : (
      <button className="stage-insert" title="Insert a stage here" onClick={() => setInsert({ wfId: wf.id, index, value: '' })}>＋</button>
    )
  );

  return (
    <div className="workflows-page">
      <header className="board-header">
        <h2>Workflows</h2>
        <button className="btn btn-primary" onClick={() => setCreating((c) => !c)}>＋ New workflow</button>
      </header>
      <p className="muted">
        A workflow defines the stages a task moves through. Each workflow gets its own board under Tasks.
        Rename a stage by clicking it, drag to reorder, use ＋ between stages to insert, and ✓ marks the column that completes a task.
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
                {stages.length > 2 && (
                  <button type="button" onClick={() => setStages((st) => st.filter((_, j) => j !== i))}>✕</button>
                )}
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
        {workflows.map((wf) => (
          <div key={wf.id} className="workflow-card">
            <div className="workflow-card-header">
              <div className="wf-title">
                <span className="wf-name">{wf.name}</span>
                {wf.description && <span className="wf-desc">{wf.description}</span>}
              </div>
              <div className="wf-actions">
                <span className="wf-count">{wf.task_count} task{wf.task_count === 1 ? '' : 's'}</span>
                <span className="wf-count muted-count">{wf.stages.length} stage{wf.stages.length === 1 ? '' : 's'}</span>
                <button className="icon-btn wf-del" title="Delete workflow" onClick={() => deleteWorkflow(wf)}>🗑</button>
              </div>
            </div>

            <div className="workflow-stages" onDragOver={(e) => e.preventDefault()}>
              {wf.stages.map((s, i) => (
                <React.Fragment key={s.id}>
                  <span className="stage-conn"><InsertGap wf={wf} index={i} /></span>
                  <div
                    className={`stage-step ${s.is_done ? 'done' : ''} ${drag.current?.wfId === wf.id && drag.current?.index === i ? 'dragging' : ''}`}
                    draggable={edit?.stageId !== s.id}
                    onDragStart={() => { drag.current = { wfId: wf.id, index: i }; }}
                    onDragEnd={() => { drag.current = null; }}
                    onDrop={(e) => { e.preventDefault(); onDrop(wf, i); }}
                  >
                    <span className="stage-num" title="Drag to reorder">{String(i + 1).padStart(2, '0')}</span>
                    {edit?.stageId === s.id ? (
                      <input
                        className="stage-rename-input" autoFocus value={edit.value}
                        onChange={(e) => setEdit((x) => ({ ...x, value: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); renameStage(wf.id, s); } if (e.key === 'Escape') setEdit(null); }}
                        onBlur={() => renameStage(wf.id, s)}
                      />
                    ) : (
                      <span className="stage-name" title="Click to rename" onClick={() => setEdit({ stageId: s.id, value: s.name })}>{s.name}</span>
                    )}
                    {s.is_done && <span className="stage-flag" title="This column completes a task">🏁</span>}
                    <span className="stage-tools">
                      <button className="stage-move" title="Move left" disabled={i === 0} onClick={() => moveStage(wf, i, i - 1)}>‹</button>
                      <button className={`stage-done-toggle ${s.is_done ? 'on' : ''}`} title={s.is_done ? 'Completes tasks (click to unset)' : 'Mark as the column that completes a task'} onClick={() => toggleDone(wf.id, s)}>✓</button>
                      <button className="stage-move" title="Move right" disabled={i === wf.stages.length - 1} onClick={() => moveStage(wf, i, i + 1)}>›</button>
                      <button className="stage-x" title="Delete stage" onClick={() => deleteStage(wf.id, s.id)}>✕</button>
                    </span>
                  </div>
                </React.Fragment>
              ))}
              <span className="stage-conn"><InsertGap wf={wf} index={wf.stages.length} /></span>
              <span className="add-stage">
                <input
                  placeholder="＋ add stage"
                  value={newStageFor[wf.id] || ''}
                  onChange={(e) => setNewStageFor((s) => ({ ...s, [wf.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addStage(wf.id))}
                />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
