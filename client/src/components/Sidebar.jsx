import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import NotificationBell from './NotificationBell.jsx';
import { notificationsSupported, notificationPermission, requestNotificationPermission } from '../desktopNotify.js';

export default function Sidebar({
  user, channels, joinable, users, onlineIds, view,
  onSelectChannel, onSelectView, onOpenDm, onJoinChannel, onChannelCreated, onLogout, onOpenSearch,
  notifications = [], unreadCount = 0, onSelectNotification, onMarkAllRead,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState(null);
  const [notifPerm, setNotifPerm] = useState(notificationPermission());

  async function enableDesktopAlerts() {
    setNotifPerm(await requestNotificationPermission());
  }

  const regularChannels = channels.filter((c) => !c.is_dm);
  const dms = channels.filter((c) => c.is_dm);
  const isOnline = (id) => onlineIds.includes(id);
  const activeChannelId = view?.type === 'channel' ? view.channel.id : null;

  async function createChannel(e) {
    e.preventDefault();
    setError(null);
    try {
      const channel = await api('/channels', { method: 'POST', body: { name: newName } });
      setNewName('');
      setShowCreate(false);
      onChannelCreated(channel);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">TeamHub</span>
        <div className="header-actions">
          <button className="icon-btn" title="Search messages" onClick={onOpenSearch}>🔍</button>
          {notificationsSupported() && notifPerm === 'default' && (
            <button className="icon-btn" title="Enable desktop notifications" onClick={enableDesktopAlerts}>🖥️</button>
          )}
          <NotificationBell
            notifications={notifications}
            unreadCount={unreadCount}
            onSelect={onSelectNotification}
            onMarkAllRead={onMarkAllRead}
          />
          <button className="icon-btn" title="Sign out" onClick={onLogout}>⏻</button>
        </div>
      </div>

      <div className="sidebar-me">
        <Avatar user={user} size={28} online />
        <span className="me-name">{user.name}</span>
      </div>

      <nav className="sidebar-nav">
        <button
          className={`nav-item ${view?.type === 'messenger' ? 'active' : ''}`}
          onClick={() => onSelectView('messenger')}
        >
          💬 Messenger
        </button>
        <button
          className={`nav-item ${view?.type === 'collabs' ? 'active' : ''}`}
          onClick={() => onSelectView('collabs')}
        >
          👥 Collabs
        </button>
        <button
          className={`nav-item ${view?.type === 'tasks' ? 'active' : ''}`}
          onClick={() => onSelectView('tasks')}
        >
          ☑ Tasks
        </button>
        <button
          className={`nav-item ${view?.type === 'workflows' ? 'active' : ''}`}
          onClick={() => onSelectView('workflows')}
        >
          ⚙ Workflows
        </button>
        {user.role === 'admin' && (
          <button
            className={`nav-item ${view?.type === 'admin' ? 'active' : ''}`}
            onClick={() => onSelectView('admin')}
          >
            👑 Admin
          </button>
        )}
      </nav>

      <div className="sidebar-section">
        <div className="section-title">
          <span>Channels</span>
          <button className="icon-btn" title="Create channel" onClick={() => setShowCreate((s) => !s)}>＋</button>
        </div>
        {showCreate && (
          <form className="create-channel" onSubmit={createChannel}>
            <input
              autoFocus
              placeholder="channel-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            {error && <div className="form-error">{error}</div>}
          </form>
        )}
        {regularChannels.map((c) => (
          <button
            key={c.id}
            className={`nav-item ${activeChannelId === c.id ? 'active' : ''}`}
            onClick={() => onSelectChannel(c)}
          >
            <span className="hash">#</span> {c.name}
          </button>
        ))}
        {joinable.map((c) => (
          <button key={c.id} className="nav-item joinable" onClick={() => onJoinChannel(c)} title="Click to join">
            <span className="hash">#</span> {c.name} <span className="join-tag">join</span>
          </button>
        ))}
      </div>

      <div className="sidebar-section">
        <div className="section-title"><span>Direct messages</span></div>
        {dms.map((c) => (
          <button
            key={c.id}
            className={`nav-item ${activeChannelId === c.id ? 'active' : ''}`}
            onClick={() => onSelectChannel(c)}
          >
            <Avatar user={c.dm_user} size={20} online={c.dm_user ? isOnline(c.dm_user.id) : false} />
            <span className="dm-name">{c.display_name}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-section">
        <div className="section-title"><span>Team</span></div>
        {users.filter((u) => u.id !== user.id).map((u) => (
          <button key={u.id} className="nav-item" onClick={() => onOpenDm(u)} title={`Message ${u.name}`}>
            <Avatar user={u} size={20} online={isOnline(u.id)} />
            <span className="dm-name">{u.name}</span>
          </button>
        ))}
        {users.length <= 1 && <div className="empty-hint">Invite teammates by sharing this app's URL — they can register themselves.</div>}
      </div>
    </aside>
  );
}
