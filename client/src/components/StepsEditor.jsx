import React, { useState } from 'react';

/**
 * Editable ordered list of step texts, reused by the template editor and
 * the new-task dialog. Steps are plain strings; parent owns the array.
 */
export default function StepsEditor({ steps, onChange, placeholder = '+ add a step' }) {
  const [draft, setDraft] = useState('');

  function add() {
    const text = draft.trim();
    if (!text) return;
    onChange([...steps, text]);
    setDraft('');
  }
  function update(i, text) {
    onChange(steps.map((s, j) => (j === i ? text : s)));
  }
  function remove(i) {
    onChange(steps.filter((_, j) => j !== i));
  }
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const copy = [...steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  }

  return (
    <div className="steps-editor">
      {steps.map((s, i) => (
        <div key={i} className="step-row">
          <span className="step-num">{i + 1}.</span>
          <input value={s} onChange={(e) => update(i, e.target.value)} />
          <button type="button" className="icon-btn" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
          <button type="button" className="icon-btn" title="Move down" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
          <button type="button" className="icon-btn" title="Remove" onClick={() => remove(i)}>✕</button>
        </div>
      ))}
      <div className="step-add">
        <input
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  );
}
