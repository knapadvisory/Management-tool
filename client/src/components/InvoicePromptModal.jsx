import React, { useState } from 'react';
import { api } from '../api.js';

// Shown right after a task is completed when Billing & Payment automation is on.
// "Yes" raises an invoice task on the configured board (assigned to the
// responsible teammate, High priority); the completer stays in the loop.
export default function InvoicePromptModal({ task, onClose, onRaised }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // the created invoice task

  async function raise() {
    setBusy(true); setError(null);
    try {
      const res = await api(`/tasks/${task.id}/raise-invoice`, { method: 'POST' });
      setDone(res.task);
      onRaised?.(res.task);
    } catch (e) {
      setError(e.message || 'Could not raise the invoice task.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal invoice-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>🧾 Raise an invoice?</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {!done ? (
          <>
            <p className="muted" style={{ margin: '4px 0 14px' }}>
              You completed <b>“{task.title}”</b>. Do you need to raise an invoice for this work?
              A billing task will be created for the responsible teammate, and you'll be kept in the loop.
            </p>
            {error && <div className="form-error">{error}</div>}
            <div className="editor-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" disabled={busy} onClick={onClose}>No</button>
              <button className="btn btn-primary" disabled={busy} onClick={raise}>{busy ? 'Creating…' : 'Yes, raise invoice'}</button>
            </div>
          </>
        ) : (
          <>
            <p className="auth-notice" style={{ margin: '4px 0 14px' }}>
              Invoice task created on <b>{done.workflow?.name || 'Billing & Payment'}</b>
              {done.assignee ? <> for <b>{done.assignee.name}</b></> : ''} ✓
            </p>
            <div className="editor-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
