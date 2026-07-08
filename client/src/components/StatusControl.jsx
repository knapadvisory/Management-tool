import React, { useState } from 'react';
import { TASK_STATUSES, statusMeta, needsReason } from '../status.js';

// Status picker for a task. In Progress / Completed apply immediately;
// On Hold / Cancelled reveal a required reason before saving.
export default function StatusControl({ task, onUpdate }) {
  const [pending, setPending] = useState(null); // a hold/cancelled awaiting its reason
  const [reason, setReason] = useState('');
  const current = statusMeta(task.status);

  function choose(value) {
    if (value === task.status) { setPending(null); return; }
    if (needsReason(value)) {
      setPending(value);
      setReason(task.status_reason || '');
    } else {
      setPending(null);
      onUpdate({ status: value });
    }
  }

  function save() {
    if (!reason.trim()) return;
    onUpdate({ status: pending, status_reason: reason.trim() });
    setPending(null);
  }

  return (
    <div className="status-control">
      <div className="status-row">
        <span className="status-badge" style={{ background: current.color }}>{current.label}</span>
        <select value={pending || task.status} onChange={(e) => choose(e.target.value)}>
          {TASK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {!pending && needsReason(task.status) && task.status_reason && (
        <div className="status-reason-shown">📄 Reason: {task.status_reason}</div>
      )}
      {pending && (
        <div className="status-reason-edit">
          <textarea rows={2} autoFocus placeholder={`Reason for "${statusMeta(pending).label}" (required)`}
            value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="status-reason-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={!reason.trim()} onClick={save}>Save status</button>
            <button type="button" className="btn btn-sm" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
