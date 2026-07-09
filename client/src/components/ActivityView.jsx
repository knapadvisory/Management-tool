import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import ChatView from './ChatView.jsx';
import TaskModal from './TaskModal.jsx';

const ICON = {
  dm: '✉️', channel_msg: '#️⃣', mention: '💬', task_assigned: '📌', task_chat: '💬', task_note: '📝', task_moved: '➡️', task_update: '🔔',
  task_reminder: '⏰', task_recurred: '🔁', task_deleted: '🗑️', task_status: '🚦', drive_share: '🏷️',
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
  { key: 'chats', label: 'Chat messages' },
  { key: 'dms', label: 'DMs' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'tasks', label: 'Tasks' },
];

// Activity feed with an inline detail pane: click an item to see the
// conversation or the task on the right, Slack-style.
export default function ActivityView({
  user, users = [], onlineIds = [], channels = [], collabs = [],
  notifications = [], unreadCount = 0, onMarkAllRead, onMarkRead,
}) {
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    api('/workflows').then((d) => setWorkflows(d.workflows)).catch(() => {});
    api('/projects').then((d) => setProjects(d.projects)).catch(() => {});
  }, []);

  const shown = notifications.filter((n) => {
    if (filter === 'unread') return !n.is_read;
    if (filter === 'chats') return n.type === 'channel_msg' || n.type === 'mention';
    if (filter === 'dms') return n.type === 'dm';
    if (filter === 'mentions') return n.type === 'mention';
    if (filter === 'tasks') return n.type.startsWith('task');
    return true;
  });

  function open(n) {
    setSelected(n);
    if (!n.is_read) onMarkRead?.(n);
  }

  const selectedChannel = selected?.channel_id
    ? [...channels, ...collabs].find((c) => c.id === selected.channel_id)
    : null;

  return (
    <div className="messenger">
      <div className="msgr-list activity-list-pane">
        <div className="activity-list-head">
          <div className="activity-title-row">
            <strong>Activity</strong>
            {unreadCount > 0 && <button className="btn-link" onClick={onMarkAllRead}>Mark all read</button>}
          </div>
          <div className="activity-filters">
            {FILTERS.map((f) => (
              <button key={f.key} className={`activity-filter ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
                {f.label}{f.key === 'unread' && unreadCount > 0 ? ` (${unreadCount})` : ''}
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 && <div className="empty-hint" style={{ padding: 16 }}>You're all caught up 🎉</div>}
        {shown.map((n) => (
          <button key={n.id} className={`activity-item ${n.is_read ? '' : 'unread'} ${selected?.id === n.id ? 'active' : ''}`} onClick={() => open(n)}>
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

      <div className="msgr-pane">
        {!selected ? (
          <div className="msgr-empty">
            <div className="msgr-empty-art">🔔</div>
            <p className="msgr-empty-title">Select an activity to see it here</p>
            <p className="muted">Messages open the conversation; task activity opens the task — right on this screen.</p>
          </div>
        ) : selected.task_id ? (
          <div className="activity-detail">
            <TaskModal key={selected.task_id} taskId={selected.task_id} user={user} users={users} workflows={workflows} projects={projects} inline onClose={() => setSelected(null)} />
          </div>
        ) : selectedChannel ? (
          <ChatView key={selectedChannel.id} channel={selectedChannel} user={user} users={selectedChannel.is_collab ? selectedChannel.members : users} onlineIds={onlineIds} />
        ) : (
          <div className="msgr-empty">
            <div className="msgr-empty-art">💬</div>
            <p className="msgr-empty-title">Conversation unavailable</p>
            <p className="muted">This chat isn't loaded here — open it from the DMs or Channels list.</p>
          </div>
        )}
      </div>
    </div>
  );
}
