import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import TimeTracker from './TimeTracker.jsx';
import { t } from '../i18n.js';

export default function Sidebar({
  user, workspace, channels, joinable, users, onlineIds, view,
  onSelectChannel, onSelectView, onOpenDm, onJoinChannel, onChannelCreated, onLogout, onOpenSettings, darkMode, onToggleTheme, onOpenSearch,
  notifications = [], unreadCount = 0, onSelectNotification, onMarkAllRead,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState(null);

  const regularChannels = channels.filter((c) => !c.is_dm);
  const dms = channels.filter((c) => c.is_dm);
  const isOnline = (id) => onlineIds.includes(id);
  const activeChannelId = view?.type === 'channel' ? view.channel.id : null;

  // Unread reflection: derive per-section badges from the notification inbox so
  // Messages and Tasks show what's waiting, not just the Activity feed.
  const unread = notifications.filter((n) => !n.is_read);
  const unreadByChannel = {};
  for (const n of unread) if (n.channel_id) unreadByChannel[n.channel_id] = (unreadByChannel[n.channel_id] || 0) + 1;
  const dmChannelIds = new Set(dms.map((c) => c.id));
  const dmUnread = unread.filter((n) => n.type === 'dm' || (n.channel_id && dmChannelIds.has(n.channel_id))).length;
  const tasksUnread = unread.filter((n) => (n.type || '').startsWith('task')).length;
  const badge = (n) => (n > 0 ? <span className="nav-badge">{n > 9 ? '9+' : n}</span> : null);

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
        <span className="logo" title={workspace ? `${workspace.name} · TeamHub` : 'TeamHub'}>{workspace?.name || 'TeamHub'}</span>
        <div className="header-actions">
          <button className="icon-btn" title={t('action.search')} onClick={onOpenSearch}>🔍</button>
          <button className="icon-btn" title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} onClick={onToggleTheme}>{darkMode ? '☀️' : '🌙'}</button>
          <button className="icon-btn" title={t('action.settings')} onClick={() => onOpenSettings('appearance')}>⚙️</button>
          <button className="icon-btn" title={t('action.signout')} onClick={onLogout}>⏻</button>
        </div>
      </div>

      <button className="sidebar-me" onClick={() => onOpenSettings('profile')} title="Your profile & settings">
        <Avatar user={user} size={28} online />
        <span className="me-name">{user.name}</span>
        <span className="me-edit">⚙</span>
      </button>

      <TimeTracker />
      <button className={`nav-item ${view?.type === 'timesheet' ? 'active' : ''}`} onClick={() => onSelectView('timesheet')}>
        <span className="nav-logo">⏱️</span> {t('nav.timesheet')}
      </button>

      <nav className="sidebar-nav">
        <button
          className={`nav-item ${view?.type === 'dashboard' ? 'active' : ''}`}
          onClick={() => onSelectView('dashboard')}
        >
          <span className="nav-logo">🏠</span> {t('nav.home')}
        </button>
        <button
          className={`nav-item ${view?.type === 'messenger' ? 'active' : ''}`}
          onClick={() => onSelectView('messenger')}
        >
          <span className="nav-logo">💬</span> {t('nav.dms')}
          {badge(dmUnread)}
        </button>
        <button
          className={`nav-item ${(view?.type === 'team' || view?.type === 'collabs') ? 'active' : ''}`}
          onClick={() => onSelectView('team')}
        >
          <span className="nav-logo">👥</span> {t('nav.people')}
        </button>
        <button
          className={`nav-item ${view?.type === 'activity' ? 'active' : ''}`}
          onClick={() => onSelectView('activity')}
        >
          <span className="nav-logo">🔔</span> {t('nav.activity')}
          {unreadCount > 0 && <span className="nav-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>
        <button
          className={`nav-item ${view?.type === 'files' ? 'active' : ''}`}
          onClick={() => onSelectView('files')}
        >
          <span className="nav-logo">🗂️</span> {t('nav.files')}
        </button>
        <button
          className={`nav-item ${view?.type === 'tasks' ? 'active' : ''}`}
          onClick={() => onSelectView('tasks')}
        >
          ☑ {t('nav.tasks')}
          {badge(tasksUnread)}
        </button>
        <button
          className={`nav-item ${view?.type === 'clients' ? 'active' : ''}`}
          onClick={() => onSelectView('clients')}
        >
          <span className="nav-logo">🗂️</span> {t('nav.clients')}
        </button>
        <button
          className={`nav-item ${view?.type === 'workflows' ? 'active' : ''}`}
          onClick={() => onSelectView('workflows')}
        >
          ⚙ {t('nav.workflows')}
        </button>
        {user.role === 'admin' && (
          <button
            className={`nav-item ${view?.type === 'admin' ? 'active' : ''}`}
            onClick={() => onSelectView('admin')}
          >
            👑 {t('nav.admin')}
          </button>
        )}
      </nav>

      <div className="sidebar-section">
        <div className="section-title">
          <span>{t('sidebar.channels')}</span>
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
            className={`nav-item ${activeChannelId === c.id ? 'active' : ''} ${unreadByChannel[c.id] ? 'has-unread' : ''}`}
            onClick={() => onSelectChannel(c)}
          >
            <span className="hash">#</span> {c.name}
            {badge(unreadByChannel[c.id] || 0)}
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
