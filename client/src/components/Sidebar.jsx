import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { notificationsSupported, notificationPermission, requestNotificationPermission } from '../desktopNotify.js';

export default function Sidebar({
  user, channels, joinable, users, onlineIds, view,
  onSelectChannel, onSelectView, onOpenDm, onJoinChannel, onChannelCreated, onLogout, onEditProfile, darkMode, onToggleTheme, onOpenSearch,
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
          <button className="icon-btn" title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} onClick={onToggleTheme}>{darkMode ? '☀️' : '🌙'}</button>
          {notificationsSupported() && notifPerm === 'default' && (
            <button className="icon-btn" title="Enable desktop notifications" onClick={enableDesktopAlerts}>🖥️</button>
          )}
          <button className="icon-btn" title="Sign out" onClick={onLogout}>⏻</button>
        </div>
      </div>

      <button className="sidebar-me" onClick={onEditProfile} title="Edit your profile">
        <Avatar user={user} size={28} online />
        <span className="me-name">{user.name}</span>
        <span className="me-edit">✎</span>
      </button>

      <nav className="sidebar-nav">
        <button
          className={`nav-item ${view?.type === 'dashboard' ? 'active' : ''}`}
          onClick={() => onSelectView('dashboard')}
        >
          <span className="nav-logo">📊</span> Dashboard
        </button>
        <button
          className={`nav-item ${view?.type === 'messenger' ? 'active' : ''}`}
          onClick={() => onSelectView('messenger')}
        >
          <span className="nav-logo">💬</span> DMs
        </button>
        <button
          className={`nav-item ${view?.type === 'team' ? 'active' : ''}`}
          onClick={() => onSelectView('team')}
        >
          <span className="nav-logo">👤</span> Team
        </button>
        <button
          className={`nav-item ${view?.type === 'collabs' ? 'active' : ''}`}
          onClick={() => onSelectView('collabs')}
        >
          👥 Collabs
        </button>
        <button
          className={`nav-item ${view?.type === 'activity' ? 'active' : ''}`}
          onClick={() => onSelectView('activity')}
        >
          <span className="nav-logo">🔔</span> Activity
          {unreadCount > 0 && <span className="nav-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>
        <button
          className={`nav-item ${view?.type === 'files' ? 'active' : ''}`}
          onClick={() => onSelectView('files')}
        >
          <span className="nav-logo">🗂️</span> Files
        </button>
        <button
          className={`nav-item ${view?.type === 'drive' ? 'active' : ''}`}
          onClick={() => onSelectView('drive')}
        >
          <span className="nav-logo">💾</span> Drive
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
    </aside>
  );
}
