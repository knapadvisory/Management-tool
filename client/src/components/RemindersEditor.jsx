import React, { useState } from 'react';
import { formatDateTime } from '../format.js';

// Presentational reminders editor. `items` are objects with a `remind_at`
// field (and optionally id/sent). onAdd receives an ISO UTC string; onRemove
// receives the item that was clicked. `dueDate` (YYYY-MM-DD) drives presets.
export default function RemindersEditor({ items = [], dueDate, onAdd, onRemove }) {
  const [when, setWhen] = useState('');

  function addCustom() {
    if (!when) return;
    const iso = new Date(when).toISOString();
    if (!Number.isNaN(new Date(iso).getTime())) onAdd(iso);
    setWhen('');
  }

  // Build a local "YYYY-MM-DDTHH:MM" at 09:00, `offsetDays` before the due date.
  function presetIso(offsetDays) {
    const d = new Date(dueDate + 'T09:00');
    d.setDate(d.getDate() - offsetDays);
    return d.toISOString();
  }

  const presets = dueDate
    ? [
        { label: 'On due date, 9 AM', days: 0 },
        { label: '1 day before', days: 1 },
        { label: '1 week before', days: 7 },
      ]
    : [];

  return (
    <div className="reminders-editor">
      {presets.length > 0 && (
        <div className="reminder-presets">
          {presets.map((p) => (
            <button type="button" key={p.label} className="btn btn-sm" onClick={() => onAdd(presetIso(p.days))}>
              🔔 {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="reminder-add">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={addCustom} disabled={!when}>Add reminder</button>
      </div>
      {items.length > 0 && (
        <ul className="reminder-list">
          {items.map((r, i) => (
            <li key={r.id ?? i} className={r.sent ? 'sent' : ''}>
              🔔 {formatDateTime(r.remind_at)}{r.sent ? ' · sent' : ''}
              <button type="button" className="icon-btn" onClick={() => onRemove(r)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
