import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import { connectSocket, disconnectSocket, getSocket } from './socket.js';
import { showDesktopNotification } from './desktopNotify.js';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import TasksBoard from './components/TasksBoard.jsx';
import WorkflowsView from './components/WorkflowsView.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import Messenger from './components/Messenger.jsx';
import PeopleView from './components/PeopleView.jsx';
import ActivityView from './components/ActivityView.jsx';
import FilesView from './components/FilesView.jsx';
import CallManager from './components/CallManager.jsx';
import GroupCallManager from './components/GroupCallManager.jsx';
import SearchModal from './components/SearchModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import DashboardView from './components/DashboardView.jsx';
import GuestJoin from './components/GuestJoin.jsx';
import GuestApp from './components/GuestApp.jsx';
import JoinWorkspace from './components/JoinWorkspace.jsx';
import ResetPassword from './components/ResetPassword.jsx';
import { applyTheme, saveLocalTheme } from './theme.js';
import { onLangChange } from './i18n.js';

// A guest invite link looks like /invite/<token>.
const inviteToken = () => {
  const m = window.location.pathname.match(/^\/invite\/([a-f0-9]+)$/i);
  return m ? m[1] : null;
};
// A workspace join link looks like /join/<slug>.
const joinSlug = () => {
  const m = window.location.pathname.match(/^\/join\/([a-z0-9-]+)$/i);
  return m ? m[1] : null;
};
// A password-reset link looks like /reset/<token>.
const resetToken = () => {
  const m = window.location.pathname.match(/^\/reset\/([a-f0-9]+)$/i);
  return m ? m[1] : null;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [channels, setChannels] = useState([]);
  const [joinable, setJoinable] = useState([]);
  const [collabs, setCollabs] = useState([]);
  const [users, setUsers] = useState([]);
  const [onlineIds, setOnlineIds] = useState([]);
  // view: { type: 'channel', channel } | { type: 'tasks' } | { type: 'workflows' }
  const [view, setView] = useState(null);
  const [toast, setToast] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [taskToOpen, setTaskToOpen] = useState(null);
  const [avatarColors, setAvatarColors] = useState([]);
  const [settings, setSettings] = useState(null); // null or { section }
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile sidebar drawer
  // Always-current pointer to selectNotification, so desktop-notification
  // clicks navigate using the latest state (channels, etc.).
  const selectNotifRef = useRef(null);

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshChannels = useCallback(async () => {
    const data = await api('/channels');
    setChannels(data.channels);
    setJoinable(data.joinable);
    return data;
  }, []);

  const refreshUsers = useCallback(async () => {
    // Guests have no directory access — skip silently.
    const data = await api('/users').catch(() => ({ users: [] }));
    setUsers(data.users);
  }, []);

  const refreshCollabs = useCallback(async () => {
    const data = await api('/collabs');
    setCollabs(data.collabs);
    return data.collabs;
  }, []);

  const refreshNotifications = useCallback(async () => {
    const data = await api('/notifications');
    setNotifications(data.notifications);
    setUnreadCount(data.unread_count);
  }, []);

  // Restore session on load, and read public config (for the invite panel).
  useEffect(() => {
    api('/config').then((c) => { setAvatarColors(c.avatar_colors || []); }).catch(() => {});
    if (!getToken()) return;
    api('/auth/me')
      .then((d) => { setUser(d.user); setWorkspace(d.workspace); })
      .catch(() => clearToken())
      .finally(() => setBooting(false));
  }, []);

  const isGuest = user?.role === 'guest';

  // After login: connect socket, load directory + channels.
  useEffect(() => {
    if (!user) return;
    const socket = connectSocket();
    socket.on('presence', ({ online_user_ids }) => setOnlineIds(online_user_ids));
    socket.on('task:assigned', ({ task, by }) => showToast(`${by.name} assigned you: "${task.title}"`));
    socket.on('mention', ({ from, preview }) => showToast(`${from.name} mentioned you: "${preview}"`));
    socket.on('directory:changed', () => { refreshUsers(); refreshChannels(); });
    socket.on('collabs:changed', () => { refreshCollabs(); });
    socket.on('account:deactivated', () => { showToast('Your access has been revoked by an administrator.'); logout(); });
    socket.on('notification:new', ({ notification, unread_count }) => {
      setNotifications((ns) => [notification, ...ns].slice(0, 50));
      setUnreadCount(unread_count);
      if (notification.type === 'task_reminder') showToast(`🔔 ${notification.text}`);
      // Native desktop alert (only when the tab is in the background). Group-chat
      // messages are too frequent to pop — they still land in the Activity feed.
      if (notification.type !== 'channel_msg') {
        showDesktopNotification('TeamHub', {
          body: notification.text,
          tag: `notif-${notification.id}`,
          onClick: () => selectNotifRef.current?.(notification),
        });
      }
    });

    refreshNotifications();
    refreshCollabs();
    // Guests are scoped to their collab chats — skip team-wide loads and the
    // dashboard entirely (GuestApp drives its own layout).
    if (!isGuest) {
      refreshUsers();
      setView((v) => v || { type: 'dashboard' });
      refreshChannels();
    }

    return () => disconnectSocket();
  }, [user, refreshChannels, refreshUsers, refreshNotifications, refreshCollabs, showToast]);

  // Keep the desktop-notification click handler pointed at the latest state.
  useEffect(() => { selectNotifRef.current = selectNotification; });

  function handleAuth({ token, user, workspace }) {
    setToken(token);
    setUser(user);
    if (workspace) setWorkspace(workspace);
  }

  // Apply (and remember) the signed-in user's saved theme.
  useEffect(() => {
    if (!user) return;
    const t = { mode: user.theme || 'light', accent: user.accent || '#4f46e5' };
    applyTheme(t);
    saveLocalTheme(t);
  }, [user?.theme, user?.accent]);

  // Re-render the whole app when the interface language changes.
  const [, setLangTick] = useState(0);
  useEffect(() => onLangChange(() => setLangTick((n) => n + 1)), []);

  // Ctrl/Cmd+K opens search from anywhere (like Slack's quick switcher).
  useEffect(() => {
    if (!user) return;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);

  // Sidebar quick toggle between light and dark.
  function toggleDarkMode() {
    if (!user) return;
    const mode = user.theme === 'dark' ? 'light' : 'dark';
    setUser((u) => ({ ...u, theme: mode }));
    api('/auth/me', { method: 'PATCH', body: { theme: mode } }).catch(() => {});
  }

  function logout() {
    clearToken();
    disconnectSocket();
    setUser(null);
    setWorkspace(null);
    setView(null);
    setChannels([]);
    setCollabs([]);
    setNotifications([]);
    setUnreadCount(0);
  }

  async function selectNotification(n) {
    if (!n.is_read) {
      api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
      setNotifications((ns) => ns.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (n.channel_id) {
      const ch = channels.find((c) => c.id === n.channel_id);
      if (ch) setView({ type: 'channel', channel: ch });
    } else if (n.task_id) {
      setView({ type: 'tasks' });
      setTaskToOpen(n.task_id);
    }
  }

  async function markAllRead() {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => {});
    setNotifications((ns) => ns.map((x) => ({ ...x, is_read: true })));
    setUnreadCount(0);
  }

  // Mark one notification read without navigating (used by the Activity pane).
  function markNotificationRead(n) {
    if (n.is_read) return;
    api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    setNotifications((ns) => ns.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
    setUnreadCount((c) => Math.max(0, c - 1));
  }

  async function openDm(otherUser) {
    const channel = await api(`/channels/dm/${otherUser.id}`, { method: 'POST' });
    getSocket()?.emit('channel:subscribe', channel.id);
    await refreshChannels();
    setView({ type: 'channel', channel });
  }

  // Open/find a DM and return the channel without changing the top-level view
  // (used by the Messenger's in-pane conversation switching).
  async function ensureDm(otherUser) {
    const channel = await api(`/channels/dm/${otherUser.id}`, { method: 'POST' });
    getSocket()?.emit('channel:subscribe', channel.id);
    await refreshChannels();
    return channel;
  }

  async function joinChannel(channel) {
    const joined = await api(`/channels/${channel.id}/join`, { method: 'POST' });
    getSocket()?.emit('channel:subscribe', joined.id);
    await refreshChannels();
    setView({ type: 'channel', channel: joined });
  }

  if (booting) return <div className="boot">Loading…</div>;
  // Invite / join / reset links show their own landing pages.
  const invite = inviteToken();
  const join = joinSlug();
  const reset = resetToken();
  if (reset) return <ResetPassword token={reset} />;
  if (!user && invite) return <GuestJoin token={invite} onAuth={handleAuth} />;
  if (!user && join) return <JoinWorkspace slug={join} onAuth={handleAuth} />;
  if (!user) return <Login onAuth={handleAuth} />;

  // External guests get a stripped-down, collab-only shell.
  if (isGuest) {
    return (
      <>
        <GuestApp user={user} collabs={collabs} onlineIds={onlineIds} onLogout={logout} onRefresh={refreshCollabs} />
        {settings && (
          <SettingsModal
            user={user} colors={avatarColors} initialSection={settings.section}
            onClose={() => setSettings(null)} onSaved={(u) => setUser(u)} onLogout={logout}
          />
        )}
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  return (
    <div className={`app ${drawerOpen ? 'drawer-open' : ''}`}>
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        user={user}
        workspace={workspace}
        channels={channels}
        joinable={joinable}
        users={users}
        onlineIds={onlineIds}
        view={view}
        onSelectChannel={(channel) => { setView({ type: 'channel', channel }); setDrawerOpen(false); }}
        onSelectView={(type) => { setView({ type }); setDrawerOpen(false); }}
        onOpenDm={(u) => { openDm(u); setDrawerOpen(false); }}
        onJoinChannel={joinChannel}
        onChannelCreated={async (channel) => {
          getSocket()?.emit('channel:subscribe', channel.id);
          await refreshChannels();
          setView({ type: 'channel', channel });
        }}
        onLogout={logout}
        onOpenSettings={(section) => setSettings({ section: section || 'profile' })}
        darkMode={user.theme === 'dark'}
        onToggleTheme={toggleDarkMode}
        onOpenSearch={() => setSearchOpen(true)}
        notifications={notifications}
        unreadCount={unreadCount}
        onSelectNotification={selectNotification}
        onMarkAllRead={markAllRead}
      />
      <main className="main">
        <div className="mobile-topbar">
          <button className="mobile-menu-btn" aria-label="Menu" onClick={() => setDrawerOpen(true)}>☰</button>
          <span className="mobile-topbar-title">{workspace?.name || 'TeamHub'}</span>
          <button className="mobile-menu-btn" aria-label="Search" onClick={() => setSearchOpen(true)}>🔍</button>
        </div>
        {view?.type === 'dashboard' && (
          <DashboardView
            user={user}
            users={users}
            onOpenTasks={() => setView({ type: 'tasks' })}
            onOpenActivity={() => setView({ type: 'activity' })}
          />
        )}
        {view?.type === 'channel' && (
          <ChatView key={view.channel.id} channel={view.channel} user={user} users={users} onlineIds={onlineIds} />
        )}
        {view?.type === 'tasks' && (
          <TasksBoard user={user} users={users} openTaskRequest={taskToOpen} onTaskOpened={() => setTaskToOpen(null)} />
        )}
        {view?.type === 'messenger' && (
          <Messenger user={user} users={users} channels={channels} onlineIds={onlineIds} onEnsureDm={ensureDm} />
        )}
        {(view?.type === 'team' || view?.type === 'collabs') && (
          <PeopleView
            key={view.type}
            user={user} users={users} onlineIds={onlineIds} collabs={collabs}
            onMessage={openDm} onRefresh={refreshCollabs}
            initialTab={view.type === 'collabs' ? 'collabs' : 'team'}
          />
        )}
        {view?.type === 'activity' && (
          <ActivityView
            user={user} users={users} onlineIds={onlineIds}
            channels={channels} collabs={collabs}
            notifications={notifications} unreadCount={unreadCount}
            onMarkAllRead={markAllRead} onMarkRead={markNotificationRead}
          />
        )}
        {(view?.type === 'files' || view?.type === 'drive') && (
          <FilesView user={user} users={users} initialMode={view.type === 'drive' ? 'drive' : 'files'} />
        )}
        {view?.type === 'workflows' && <WorkflowsView />}
        {view?.type === 'admin' && user.role === 'admin' && (
          <AdminPanel user={user} />
        )}
      </main>
      <CallManager user={user} />
      <GroupCallManager user={user} users={users} />
      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onSelect={(channelId) => {
            const ch = channels.find((c) => c.id === channelId);
            if (ch) setView({ type: 'channel', channel: ch });
            setSearchOpen(false);
          }}
        />
      )}
      {settings && (
        <SettingsModal
          user={user} colors={avatarColors} initialSection={settings.section}
          onClose={() => setSettings(null)}
          onSaved={(u) => setUser(u)} onLogout={logout}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
