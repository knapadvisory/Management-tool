import React, { useMemo } from 'react';

// A lightweight Gantt: one row per dated task, a bar from its start date (or due
// date when no start is set) to its due date, a "today" marker, and a blocked
// flag for tasks waiting on an unfinished blocker. Horizontal-scrolls for long
// ranges; the task-name gutter stays fixed.

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => new Date(s + 'T00:00:00');
const DAY_W = 40;

// Initials of the person a task is assigned to (the primary assignee), e.g.
// "Anuj Singh Negi" → "AS". Blank when unassigned.
const initials = (name) => (name || '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

const PRIO_CLASS = { urgent: 'gantt-urgent', high: 'gantt-high', medium: 'gantt-medium', low: 'gantt-low' };

export default function TaskTimelineView({ tasks, onOpen }) {
  const dated = useMemo(() => tasks.filter((t) => t.due_date), [tasks]);
  const undated = tasks.filter((t) => !t.due_date);

  const model = useMemo(() => {
    if (dated.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const t of dated) {
      const s = t.start_date && t.start_date <= t.due_date ? t.start_date : t.due_date;
      min = Math.min(min, parse(s).getTime());
      max = Math.max(max, parse(t.due_date).getTime());
    }
    const start = new Date(min - 2 * DAY);
    const end = new Date(max + 2 * DAY);
    const days = [];
    for (let d = start.getTime(); d <= end.getTime(); d += DAY) days.push(new Date(d));
    const idxOf = (dateStr) => Math.round((parse(dateStr).getTime() - start.getTime()) / DAY);
    return { days, start, idxOf };
  }, [dated]);

  const rows = useMemo(() => {
    return [...dated].sort((a, b) => {
      const sa = a.start_date && a.start_date <= a.due_date ? a.start_date : a.due_date;
      const sb = b.start_date && b.start_date <= b.due_date ? b.start_date : b.due_date;
      return sa.localeCompare(sb) || a.due_date.localeCompare(b.due_date);
    });
  }, [dated]);

  if (!model) {
    return <div className="gantt-empty muted">No tasks with a due date yet. Give tasks a due date (and optionally a start date) to see them here.</div>;
  }

  const { days, idxOf } = model;
  const width = days.length * DAY_W;
  const todayStr = ymd(new Date());
  const todayIdx = days.some((d) => ymd(d) === todayStr) ? idxOf(todayStr) : -1;

  return (
    <div className="gantt">
      <div className="gantt-scroll">
        <div className="gantt-inner" style={{ width: width + 220 }}>
          {/* Header: month labels + day ticks */}
          <div className="gantt-head">
            <div className="gantt-gutter gantt-head-gutter">Task</div>
            <div className="gantt-track gantt-head-track" style={{ width }}>
              {days.map((d, i) => (
                <div key={i} className={`gantt-tick ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''} ${ymd(d) === todayStr ? 'today' : ''}`} style={{ width: DAY_W }}>
                  {d.getDate() === 1 || i === 0 ? <span className="gantt-month">{MONTHS[d.getMonth()]}</span> : null}
                  <span className="gantt-day">{d.getDate()}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Rows */}
          <div className="gantt-body">
            {todayIdx >= 0 && <div className="gantt-today-line" style={{ left: 220 + todayIdx * DAY_W + DAY_W / 2 }} />}
            {rows.map((t) => {
              const s = t.start_date && t.start_date <= t.due_date ? t.start_date : t.due_date;
              const left = idxOf(s) * DAY_W;
              const span = Math.max(1, idxOf(t.due_date) - idxOf(s) + 1);
              const done = t.status === 'completed' || t.status === 'cancelled';
              const cls = done ? 'gantt-done' : (t.is_blocked ? 'gantt-blocked' : (PRIO_CLASS[t.priority] || 'gantt-medium'));
              return (
                <div key={t.id} className="gantt-row">
                  <div className="gantt-gutter" title={t.title}>
                    {t.is_blocked && <span className="gantt-lock" title="Blocked by an unfinished task">🔒</span>}
                    <button className="gantt-name" onClick={() => onOpen(t.id)}>{t.title}</button>
                  </div>
                  <div className="gantt-track" style={{ width }}>
                    <button
                      className={`gantt-bar ${cls}`}
                      style={{ left, width: span * DAY_W - 4 }}
                      onClick={() => onOpen(t.id)}
                      title={`${t.title}\n${s === t.due_date ? `Due ${t.due_date}` : `${s} → ${t.due_date}`}${t.assignee ? `\nAssigned to ${t.assignee.name}` : '\nUnassigned'}${t.is_blocked ? '\n🔒 Blocked' : ''}`}
                    >
                      <span className="gantt-bar-label">{t.assignee ? initials(t.assignee.name) : '·'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {undated.length > 0 && (
        <div className="gantt-undated">
          <span className="muted">No due date:</span>
          {undated.map((t) => <button key={t.id} className="gantt-chip" onClick={() => onOpen(t.id)}>{t.title}</button>)}
        </div>
      )}
    </div>
  );
}
