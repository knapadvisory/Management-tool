import React, { useState } from 'react';
import Avatar from './Avatar.jsx';

const ICON = {
  mention: '💬', task_assigned: '📌', task_chat: '💬', task_note: '📝', task_moved: '➡️', task_update: '🔔',
  task_reminder: '⏰', task_recurred: '🔁', task_deleted: '🗑️', task_status: '🚦',
};

function timeAgo(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'tasks', label: 'Tasks' },
];

// Full-page activity feed — every notification the user has received, with
// filters and mark-all-read. Replaces the old bell dropdown.
export default function ActivityView({ notifications = [], unreadCount = 0, onSelect, onMarkAllRead }) {
  const [filter, setFilter] = useState('all');

  const shown = notifications.filter((n) => {
    if (filter === 'unread') return !n.is_read;
    if (filter === 'mentions') return n.type === 'mention';
    if (filter === 'tasks') return n.type.startsWith('task');
    return true;
  });

  return (
    <div className="activity-page">
      <header className="activity-head">
        <div>
          <h2>Activity</h2>
          <p className="muted">Mentions, task assignments, reminders and everything happening around you.</p>
        </div>
        {unreadCount > 0 && <button className="btn btn-sm" onClick={onMarkAllRead}>Mark all read</button>}
      </header>

      <div className="activity-filters">
        {FILTERS.map((f) => (
          <button key={f.key} className={`activity-filter ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}{f.key === 'unread' && unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
        ))}
      </div>

      <div className="activity-list">
        {shown.length === 0 && <div className="empty-hint" style={{ padding: 20 }}>You're all caught up 🎉</div>}
        {shown.map((n) => (
          <button key={n.id} className={`activity-item ${n.is_read ? '' : 'unread'}`} onClick={() => onSelect(n)}>
            <span className="activity-icon">{ICON[n.type] || '🔔'}</span>
            <span className="activity-body">
              <span className="activity-text">{n.text}</span>
              <span className="activity-time">{timeAgo(n.created_at)}</span>
            </span>
            {n.actor && <Avatar user={n.actor} size={22} />}
            {!n.is_read && <span className="activity-dot" />}
          </button>
        ))}
      </div>
    </div>
  );
}
