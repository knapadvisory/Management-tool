import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function WorkflowsView() {
  const [workflows, setWorkflows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stages, setStages] = useState(['To Do', 'In Progress', 'Done']);
  const [error, setError] = useState(null);
  const [newStageFor, setNewStageFor] = useState({});

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
      setCreating(false);
      setName('');
      setDescription('');
      setStages(['To Do', 'In Progress', 'Done']);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addStage(wfId) {
    const stageName = (newStageFor[wfId] || '').trim();
    if (!stageName) return;
    try {
      await api(`/workflows/${wfId}/stages`, { method: 'POST', body: { name: stageName } });
      setNewStageFor((s) => ({ ...s, [wfId]: '' }));
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteStage(wfId, stageId) {
    try {
      await api(`/workflows/${wfId}/stages/${stageId}`, { method: 'DELETE' });
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteWorkflow(wf) {
    if (!confirm(`Delete workflow "${wf.name}"?`)) return;
    try {
      await api(`/workflows/${wf.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="workflows-page">
      <header className="board-header">
        <h2>Workflows</h2>
        <button className="btn btn-primary" onClick={() => setCreating((c) => !c)}>＋ New workflow</button>
      </header>
      <p className="muted">
        A workflow defines the stages a task moves through. Each workflow gets its own board under Tasks.
      </p>

      {creating && (
        <form className="workflow-form" onSubmit={createWorkflow}>
          <input placeholder="Workflow name (e.g. Client Onboarding)" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="stage-editor">
            <span className="muted">Stages (in order):</span>
            {stages.map((s, i) => (
              <span key={i} className="stage-chip">
                <input
                  value={s}
                  onChange={(e) => setStages((st) => st.map((x, j) => (j === i ? e.target.value : x)))}
                />
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
              <div>
                <strong>{wf.name}</strong>
                {wf.description && <span className="muted"> — {wf.description}</span>}
              </div>
              <div>
                <span className="muted">{wf.task_count} task{wf.task_count === 1 ? '' : 's'}</span>
                <button className="icon-btn" title="Delete workflow" onClick={() => deleteWorkflow(wf)}>🗑</button>
              </div>
            </div>
            <div className="workflow-stages">
              {wf.stages.map((s, i) => (
                <React.Fragment key={s.id}>
                  {i > 0 && <span className="stage-arrow">→</span>}
                  <span className={`stage-pill ${s.is_done ? 'done' : ''}`}>
                    {s.name}
                    <button className="stage-x" title="Delete stage" onClick={() => deleteStage(wf.id, s.id)}>✕</button>
                  </span>
                </React.Fragment>
              ))}
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
