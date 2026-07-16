import React from 'react';

// Small stack of dismissible pop-ups shown in the corner when a new message or
// task arrives — so you notice it from the home page (or anywhere) without
// opening the Activity feed. Click to jump to it, ✕ to dismiss.
const ICON = {
  dm: '💬', channel_msg: '#️⃣', mention: '📣', task_assigned: '📌',
  task_update: '✏️', task_moved: '↕️', task_status: '🔁', task_note: '🗒️',
  task_chat: '💬', task_reminder: '🔔', task_recurred: '🔁', task_deleted: '🗑️',
};

export default function NotificationPopups({ popups = [], onOpen, onClose }) {
  if (!popups.length) return null;
  return (
    <div className="notif-popups">
      {popups.map(({ id, notification }) => (
        <div key={id} className="notif-popup" role="alert">
          <button className="notif-popup-body" onClick={() => onOpen(notification)}>
            <span className="notif-popup-icon">{ICON[notification.type] || '🔔'}</span>
            <span className="notif-popup-text">{notification.text}</span>
          </button>
          <button className="notif-popup-close" title="Dismiss" onClick={() => onClose(id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
