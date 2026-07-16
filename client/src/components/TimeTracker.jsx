import React, { useEffect, useState, useRef } from 'react';
import { api } from '../api.js';
import { elapsedClock, emitTimeChanged, onTimeChanged } from '../time.js';

// Always-visible timer (like ERPCA's TIME TRACKER). Shows the running entry,
// ticks every second, and starts/stops. Kept in the sidebar so it's global.
export default function TimeTracker() {
  const [running, setRunning] = useState(null);
  const [, tick] = useState(0);
  const busy = useRef(false);

  const refresh = () => api('/time/running').then((d) => setRunning(d.running)).catch(() => {});
  useEffect(() => { refresh(); return onTimeChanged(refresh); }, []);
  // Tick every second while a timer runs.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  async function toggle() {
    if (busy.current) return;
    busy.current = true;
    try {
      if (running) { await api('/time/stop', { method: 'POST' }); setRunning(null); }
      else { const d = await api('/time/start', { method: 'POST', body: {} }); setRunning(d.running); }
      emitTimeChanged();
    } catch { /* ignore */ } finally { busy.current = false; }
  }

  return (
    <button className={`time-tracker ${running ? 'on' : ''}`} onClick={toggle}
      title={running ? (running.task ? `Timing: ${running.task.title}` : 'Timer running — click to stop') : 'Start a timer'}>
      <span className="tt-dot" />
      <span className="tt-clock">{running ? elapsedClock(running.started_at) : '00:00'}</span>
      <span className="tt-label">{running ? (running.task ? running.task.title : 'Timing…') : 'Start timer'}</span>
      <span className="tt-action">{running ? '⏹' : '▶'}</span>
    </button>
  );
}
