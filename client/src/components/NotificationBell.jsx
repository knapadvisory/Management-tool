import React, { useState, useRef, useEffect } from 'react';
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

export default function NotificationBell({ notifications, unreadCount, onSelect, onMarkAllRead }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="bell-wrap" ref={ref}>
      <button className="icon-btn bell-btn" title="Notifications" onClick={() => setOpen((o) => !o)}>
        🔔{unreadCount > 0 && <span className="bell-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <strong>Notifications</strong>
            {unreadCount > 0 && <button className="btn-link" onClick={onMarkAllRead}>Mark all read</button>}
          </div>
          <div className="notif-list">
            {notifications.length === 0 && <div className="empty-hint">You're all caught up 🎉</div>}
            {notifications.map((n) => (
              <button
                key={n.id}
                className={`notif-item ${n.is_read ? '' : 'unread'}`}
                onClick={() => { onSelect(n); setOpen(false); }}
              >
                <span className="notif-icon">{ICON[n.type] || '🔔'}</span>
                <span className="notif-body">
                  <span className="notif-text">{n.text}</span>
                  <span className="notif-time">{timeAgo(n.created_at)}</span>
                </span>
                {!n.is_read && <span className="notif-dot" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
