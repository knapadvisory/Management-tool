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
import Collabs from './components/Collabs.jsx';
import TeamDirectory from './components/TeamDirectory.jsx';
import ActivityView from './components/ActivityView.jsx';
import FilesView from './components/FilesView.jsx';
import CallManager from './components/CallManager.jsx';
import SearchModal from './components/SearchModal.jsx';

export default function App() {
  const [user, setUser] = useState(null);
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
  const [signupCodeRequired, setSignupCodeRequired] = useState(false);
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
    const data = await api('/users');
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
    api('/config').then((c) => setSignupCodeRequired(!!c.signup_code_required)).catch(() => {});
    if (!getToken()) return;
    api('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => clearToken())
      .finally(() => setBooting(false));
  }, []);

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
      // Native desktop alert (only when the tab is in the background).
      showDesktopNotification('TeamHub', {
        body: notification.text,
        tag: `notif-${notification.id}`,
        onClick: () => selectNotifRef.current?.(notification),
      });
    });

    refreshUsers();
    refreshNotifications();
    refreshCollabs();
    refreshChannels().then((d) => {
      const general = d.channels.find((c) => c.name === 'general' && !c.is_dm) || d.channels[0];
      setView((v) => v || (general ? { type: 'channel', channel: general } : { type: 'tasks' }));
    });

    return () => disconnectSocket();
  }, [user, refreshChannels, refreshUsers, refreshNotifications, refreshCollabs, showToast]);

  // Keep the desktop-notification click handler pointed at the latest state.
  useEffect(() => { selectNotifRef.current = selectNotification; });

  function handleAuth({ token, user }) {
    setToken(token);
    setUser(user);
  }

  function logout() {
    clearToken();
    disconnectSocket();
    setUser(null);
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
  if (!user) return <Login onAuth={handleAuth} />;

  return (
    <div className="app">
      <Sidebar
        user={user}
        channels={channels}
        joinable={joinable}
        users={users}
        onlineIds={onlineIds}
        view={view}
        onSelectChannel={(channel) => setView({ type: 'channel', channel })}
        onSelectView={(type) => setView({ type })}
        onOpenDm={openDm}
        onJoinChannel={joinChannel}
        onChannelCreated={async (channel) => {
          getSocket()?.emit('channel:subscribe', channel.id);
          await refreshChannels();
          setView({ type: 'channel', channel });
        }}
        onLogout={logout}
        onOpenSearch={() => setSearchOpen(true)}
        notifications={notifications}
        unreadCount={unreadCount}
        onSelectNotification={selectNotification}
        onMarkAllRead={markAllRead}
      />
      <main className="main">
        {view?.type === 'channel' && (
          <ChatView key={view.channel.id} channel={view.channel} user={user} users={users} onlineIds={onlineIds} />
        )}
        {view?.type === 'tasks' && (
          <TasksBoard user={user} users={users} openTaskRequest={taskToOpen} onTaskOpened={() => setTaskToOpen(null)} />
        )}
        {view?.type === 'messenger' && (
          <Messenger user={user} users={users} channels={channels} onlineIds={onlineIds} onEnsureDm={ensureDm} />
        )}
        {view?.type === 'collabs' && (
          <Collabs user={user} users={users} collabs={collabs} onlineIds={onlineIds} onRefresh={refreshCollabs} />
        )}
        {view?.type === 'team' && (
          <TeamDirectory user={user} users={users} onlineIds={onlineIds} onMessage={openDm} />
        )}
        {view?.type === 'activity' && (
          <ActivityView notifications={notifications} unreadCount={unreadCount} onSelect={selectNotification} onMarkAllRead={markAllRead} />
        )}
        {view?.type === 'files' && <FilesView />}
        {view?.type === 'workflows' && <WorkflowsView />}
        {view?.type === 'admin' && user.role === 'admin' && (
          <AdminPanel user={user} signupCodeRequired={signupCodeRequired} />
        )}
      </main>
      <CallManager user={user} />
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
