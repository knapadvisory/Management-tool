import React, { useState } from 'react';
import { dueStatus } from './TaskCard.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function TaskCalendarView({ tasks, onOpen }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const today = ymd(new Date());

  const byDate = {};
  for (const t of tasks) {
    if (!t.due_date) continue;
    (byDate[t.due_date] ||= []).push(t);
  }

  const first = new Date(cursor.y, cursor.m, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(cursor.y, cursor.m, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const shift = (delta) => setCursor(({ y, m }) => {
    const nm = m + delta;
    return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
  });

  const undated = tasks.filter((t) => !t.due_date);

  return (
    <div className="calendar-view">
      <div className="cal-header">
        <button className="btn" onClick={() => shift(-1)}>‹</button>
        <strong>{MONTHS[cursor.m]} {cursor.y}</strong>
        <button className="btn" onClick={() => shift(1)}>›</button>
        <button className="btn" onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }}>Today</button>
      </div>
      <div className="cal-weekdays">
        {WEEKDAYS.map((w) => <div key={w} className="cal-weekday">{w}</div>)}
      </div>
      <div className="cal-grid" style={{ gridTemplateRows: `repeat(${cells.length / 7}, minmax(0, 1fr))` }}>
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="cal-cell empty" />;
          const key = ymd(date);
          const dayTasks = byDate[key] || [];
          return (
            <div key={i} className={`cal-cell ${key === today ? 'today' : ''}`}>
              <div className="cal-date">{date.getDate()}</div>
              <div className="cal-tasks">
                {dayTasks.slice(0, 4).map((t) => (
                  <button
                    key={t.id}
                    className={`cal-task ${dueStatus(t.due_date)}`}
                    style={t.project ? { borderLeftColor: t.project.color } : undefined}
                    onClick={() => onOpen(t.id)}
                    title={t.title}
                  >
                    {t.title}
                  </button>
                ))}
                {dayTasks.length > 4 && <span className="cal-more">+{dayTasks.length - 4} more</span>}
              </div>
            </div>
          );
        })}
      </div>
      {undated.length > 0 && (
        <div className="cal-undated">
          <span className="muted">No due date:</span>
          {undated.map((t) => (
            <button key={t.id} className="cal-task" onClick={() => onOpen(t.id)}>{t.title}</button>
          ))}
        </div>
      )}
    </div>
  );
}
