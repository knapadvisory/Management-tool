import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import { connectSocket, disconnectSocket, getSocket } from './socket.js';
import { initPush } from './capacitorPush.js';
import { usePullToRefresh } from './usePullToRefresh.js';
import { initWebPush } from './webpush.js';
import { showDesktopNotification } from './desktopNotify.js';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import TasksBoard from './components/TasksBoard.jsx';
import WorkflowsView from './components/WorkflowsView.jsx';
import KnapTools from './components/KnapTools.jsx';
import homeIco from './assets/icons/Home.png';
import taskIco from './assets/icons/Task.png';
import dmsIco from './assets/icons/DMs.png';
import filesIco from './assets/icons/Files.png';
import clientIco from './assets/icons/Client.png';
import ClientsView from './components/ClientsView.jsx';
import AnalyticsView from './components/AnalyticsView.jsx';
import TimesheetView from './components/TimesheetView.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import Messenger from './components/Messenger.jsx';
import PeopleView from './components/PeopleView.jsx';
import ActivityView from './components/ActivityView.jsx';
import NotificationPopups from './components/NotificationPopups.jsx';
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
  const [hrEnabled, setHrEnabled] = useState(false); // KNAP-HRMS bridge available?
  // view: { type: 'channel', channel } | { type: 'tasks' } | { type: 'workflows' }
  const [view, setView] = useState(null);
  const [toast, setToast] = useState(null);
  const [popups, setPopups] = useState([]); // dismissible corner pop-ups
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [taskToOpen, setTaskToOpen] = useState(null);
  const [avatarColors, setAvatarColors] = useState([]);
  const [settings, setSettings] = useState(null); // null or { section }
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile sidebar drawer

  // Pull-to-refresh for the native app (a plain browser already has its own).
  const isNativeApp = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
  const reloadApp = useCallback(() => { window.location.reload(); }, []);
  const { ref: mainRef, pull: ptrPull, refreshing: ptrBusy } = usePullToRefresh(reloadApp, isNativeApp);
  // Always-current pointer to selectNotification, so desktop-notification
  // clicks navigate using the latest state (channels, etc.).
  const selectNotifRef = useRef(null);
  const viewRef = useRef(null); // latest view, for socket handlers

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(null), 4000);
  }, []);

  // A dismissible corner pop-up for an incoming notification (kept to the last
  // few, auto-expiring after 8s).
  const pushPopup = useCallback((notification) => {
    setPopups((ps) => [...ps.filter((p) => p.id !== notification.id), { id: notification.id, notification }].slice(-3));
    setTimeout(() => setPopups((ps) => ps.filter((p) => p.id !== notification.id)), 8000);
  }, []);
  const dismissPopup = useCallback((id) => setPopups((ps) => ps.filter((p) => p.id !== id)), []);

  // Opening a conversation clears its unread notifications (server + local),
  // so the Messages/channel badges reflect what's actually unread.
  const markChannelRead = useCallback((channelId) => {
    setNotifications((ns) => {
      let dec = 0;
      const next = ns.map((n) => {
        if (n.channel_id === channelId && !n.is_read) { dec++; return { ...n, is_read: true }; }
        return n;
      });
      if (dec) setUnreadCount((c) => Math.max(0, c - dec));
      return next;
    });
    api(`/channels/${channelId}/read`, { method: 'POST' }).catch(() => {});
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
    // Keep the conversation list's preview + ordering live: patch the matching
    // channel's last message/activity when any message arrives (or refetch if
    // it's a conversation we don't have loaded yet, e.g. a brand-new DM).
    socket.on('message:new', ({ message }) => {
      if (!message?.channel_id) return;
      let found = false;
      setChannels((cs) => {
        found = cs.some((c) => c.id === message.channel_id);
        if (!found) return cs;
        return cs.map((c) => (
          c.id === message.channel_id
            ? {
              ...c,
              last_message: { user_id: message.user_id, user_name: message.user_name, content: message.content || '📎 Attachment' },
              last_activity: message.created_at,
            }
            : c
        ));
      });
      // A message arrived for a conversation we don't have yet (e.g. a brand-new
      // DM) — pull the list. Done outside the updater to avoid a double-invoke.
      if (!found) refreshChannels();
    });
    socket.on('account:deactivated', () => { showToast('Your access has been revoked by an administrator.'); logout(); });
    socket.on('notification:new', ({ notification, unread_count }) => {
      setNotifications((ns) => [notification, ...ns].slice(0, 50));
      setUnreadCount(unread_count);
      // Don't pop for the conversation you're already looking at.
      const viewingChannel = viewRef.current?.type === 'channel' ? viewRef.current.channel?.id : null;
      const forOpenChannel = notification.channel_id && notification.channel_id === viewingChannel;
      if (!forOpenChannel) pushPopup(notification);
      // Native desktop alert (fires only when the tab is backgrounded).
      showDesktopNotification('TeamHub', {
        body: notification.text,
        tag: `notif-${notification.id}`,
        onClick: () => selectNotifRef.current?.(notification),
      });
    });

    refreshNotifications();
    refreshCollabs();
    // Guests are scoped to their collab chats — skip team-wide loads and the
    // dashboard entirely (GuestApp drives its own layout).
    if (!isGuest) {
      refreshUsers();
      setView((v) => v || { type: 'dashboard' });
      refreshChannels();
      // Is the HR (KNAP-HRMS) bridge configured on this deployment? Any member
      // can open HR (they land in their own self-service portal); guests can't.
      if (user.role !== 'guest') api('/hr/config').then((c) => setHrEnabled(!!c.enabled)).catch(() => setHrEnabled(false));
    }

    return () => disconnectSocket();
  }, [user, refreshChannels, refreshUsers, refreshNotifications, refreshCollabs, showToast]);

  // Keep the desktop-notification click handler pointed at the latest state.
  useEffect(() => { selectNotifRef.current = selectNotification; });

  // Viewing a channel/DM marks it read, clearing its sidebar badge.
  useEffect(() => {
    viewRef.current = view;
    if (view?.type === 'channel' && view.channel?.id) markChannelRead(view.channel.id);
  }, [view, markChannelRead]);

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
    // Clear the team directory too, so the next account doesn't briefly see the
    // previous user's people / channels / presence before the refetch lands.
    setUsers([]);
    setJoinable([]);
    setOnlineIds([]);
    setToast(null);
    // Reset transient UI so the next sign-in lands on a clean Home, not
    // whatever overlay was open when the user signed out (the Sign-out button
    // lives inside Settings, so this modal in particular used to re-open).
    setSettings(null);
    setSearchOpen(false);
    setDrawerOpen(false);
    setTaskToOpen(null);
    setPopups([]);
  }

  // Register for mobile push once logged in (no-op in a browser). Tapping a
  // push opens the relevant task or conversation.
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  useEffect(() => {
    if (!user) return undefined;
    let cleanup;
    initPush((data) => {
      if (data?.task_id) { setView({ type: 'tasks' }); setTaskToOpen(Number(data.task_id)); }
      else if (data?.channel_id) {
        const ch = channelsRef.current.find((c) => c.id === Number(data.channel_id));
        setView(ch ? { type: 'channel', channel: ch } : { type: 'messenger' });
      }
    }).then((fn) => { cleanup = fn; });
    // Browser (Chrome/Edge/Firefox) web push — no-op on native / unsupported.
    initWebPush();
    return () => { cleanup?.(); };
  }, [user]);

  // Android hardware back button: navigate *within* the app instead of the
  // default (which, in a WebView with no browser history, just drops out of the
  // app). Adding a backButton listener makes Capacitor hand control to us.
  // Priority: close the topmost open modal → close the mobile drawer → return
  // to the dashboard → and only a press at the root backgrounds the app.
  const backStateRef = useRef({});
  backStateRef.current = { view, drawerOpen };

  // In-app back stack so hardware back retraces where you actually were — e.g. a
  // DM conversation returns to the DMs list, not straight home. We record the
  // view being left whenever it changes (unless the change *is* a back-pop).
  const viewKey = (v) => (v ? `${v.type}:${v.channel?.id ?? ''}` : '');
  const viewHistoryRef = useRef([]);
  const prevViewRef = useRef(view);
  const poppingRef = useRef(false);
  useEffect(() => {
    const prev = prevViewRef.current;
    if (poppingRef.current) {
      poppingRef.current = false; // arrived here via back — don't re-record
    } else if (prev && viewKey(prev) !== viewKey(view)) {
      const hist = viewHistoryRef.current;
      if (viewKey(hist[hist.length - 1]) !== viewKey(view)) hist.push(prev);
      if (hist.length > 30) hist.shift(); // bound it
    }
    prevViewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (!window.Capacitor?.isNativePlatform?.()) return undefined;
    let remove;
    (async () => {
      let CapApp;
      try { ({ App: CapApp } = await import('@capacitor/app')); } catch { return; }
      const h = await CapApp.addListener('backButton', () => {
        // 1. Any open modal — they all render .modal-overlay with onClick=onClose,
        //    so clicking the topmost overlay dismisses it.
        const overlays = document.querySelectorAll('.modal-overlay');
        if (overlays.length) { overlays[overlays.length - 1].click(); return; }
        // 2. Mobile sidebar drawer.
        if (backStateRef.current.drawerOpen) { setDrawerOpen(false); return; }
        // 3. Retrace the in-app history one step (DM → DMs list, task → wherever
        //    you opened it from, …).
        const hist = viewHistoryRef.current;
        if (hist.length) {
          const prev = hist.pop();
          poppingRef.current = true;
          setDrawerOpen(false);
          setView(prev);
          return;
        }
        // 4. Nothing recorded but not at home → home.
        const v = backStateRef.current.view;
        if (v && v.type !== 'dashboard') { poppingRef.current = true; setView({ type: 'dashboard' }); return; }
        // 5. At the root: background the app, like a normal Android back press.
        if (CapApp.minimizeApp) CapApp.minimizeApp(); else CapApp.exitApp();
      });
      remove = () => h.remove();
    })();
    return () => { remove?.(); };
  }, []);

  // Deep-link from a web-push notification click (#channel-N / #task-N).
  useEffect(() => {
    if (!user) return undefined;
    const route = () => {
      const cm = window.location.hash.match(/^#channel-(\d+)/);
      const tm = window.location.hash.match(/^#task-(\d+)/);
      if (cm) {
        const ch = channelsRef.current.find((c) => c.id === Number(cm[1]));
        if (ch) { setView({ type: 'channel', channel: ch }); window.location.hash = ''; }
      } else if (tm) {
        setView({ type: 'tasks' }); setTaskToOpen(Number(tm[1])); window.location.hash = '';
      }
    };
    route();
    window.addEventListener('hashchange', route);
    return () => window.removeEventListener('hashchange', route);
  }, [user]);

  async function selectNotification(n) {
    if (!n.is_read) {
      api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
      setNotifications((ns) => ns.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (n.channel_id) {
      // Collab conversations live in a separate list, so search both.
      const ch = channels.find((c) => c.id === n.channel_id) || collabs.find((c) => c.id === n.channel_id);
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

  // Hand off to the KNAP-HRMS app via single sign-on (opens in a new tab).
  async function openHr() {
    try {
      const { url } = await api('/hr/sso');
      if (url) window.open(url, '_blank', 'noopener');
    } catch (e) {
      showToast(e.message || 'Could not open HR.');
    }
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
        hrEnabled={hrEnabled}
        onOpenHr={openHr}
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
        onOpenSettings={(section) => { setSettings({ section: section || 'profile' }); setDrawerOpen(false); }}
        darkMode={user.theme === 'dark'}
        onToggleTheme={toggleDarkMode}
        onOpenSearch={() => setSearchOpen(true)}
        notifications={notifications}
        unreadCount={unreadCount}
        onSelectNotification={selectNotification}
        onMarkAllRead={markAllRead}
      />
      <main className="main" ref={mainRef}>
        {isNativeApp && (ptrPull > 0 || ptrBusy) && (
          <div className="ptr" style={{ height: ptrPull }}>
            <span className={`ptr-icon ${ptrBusy ? 'ptr-spin' : ''}`}>
              {ptrBusy ? '↻' : ptrPull >= 70 ? '↑' : '↓'}
            </span>
          </div>
        )}
        <div className="mobile-topbar">
          <button className="mobile-menu-btn" aria-label="Menu" onClick={() => setDrawerOpen(true)}>☰</button>
          <span className="mobile-topbar-title">{workspace?.name || 'TeamHub'}</span>
          <button className="mobile-menu-btn" aria-label="Search" onClick={() => setSearchOpen(true)}>🔍</button>
        </div>
        {view?.type === 'dashboard' && (
          <DashboardView
            user={user}
            users={users}
            hrEnabled={hrEnabled}
            onOpenHr={openHr}
            onOpenTasks={() => setView({ type: 'tasks' })}
            onOpenActivity={() => setView({ type: 'activity' })}
            onOpenTimesheet={() => setView({ type: 'timesheet' })}
          />
        )}
        {view?.type === 'channel' && (
          <ChatView key={view.channel.id} channel={view.channel} user={user} users={users} onlineIds={onlineIds} onOpenDm={openDm} />
        )}
        {view?.type === 'tasks' && (
          <TasksBoard user={user} users={users} openTaskRequest={taskToOpen} onTaskOpened={() => setTaskToOpen(null)} />
        )}
        {view?.type === 'messenger' && (
          <Messenger user={user} users={users} channels={channels} onlineIds={onlineIds} onEnsureDm={ensureDm} onRefresh={refreshChannels} onNotifRefresh={refreshNotifications} />
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
        {view?.type === 'clients' && (
          <ClientsView user={user} users={users} initialClientId={view.clientId} onOpenTask={(id) => { setView({ type: 'tasks' }); setTaskToOpen(id); }} />
        )}
        {view?.type === 'timesheet' && <TimesheetView user={user} />}
        {view?.type === 'analytics' && user.role !== 'guest' && <AnalyticsView user={user} users={users} />}
        {view?.type === 'workflows' && <WorkflowsView />}
        {view?.type === 'tools' && user.role !== 'guest' && <KnapTools />}
        {view?.type === 'admin' && user.role === 'admin' && (
          <AdminPanel user={user} />
        )}
      </main>
      <nav className="mobile-tabbar">
        {[
          { type: 'dashboard', ico: homeIco, label: 'Home' },
          { type: 'tasks', ico: taskIco, label: 'Tasks' },
          { type: 'messenger', ico: dmsIco, label: 'Chat', match: (t) => t === 'messenger' || t === 'channel' },
          { type: 'files', ico: filesIco, label: 'Files', match: (t) => t === 'files' || t === 'drive' },
          { type: 'clients', ico: clientIco, label: 'Clients' },
        ].map((t) => {
          const active = t.match ? t.match(view?.type) : view?.type === t.type;
          return (
            <button
              key={t.type}
              className={`tabbar-btn ${active ? 'active' : ''}`}
              onClick={() => { setView({ type: t.type }); setDrawerOpen(false); }}
            >
              <img className="tabbar-ico" src={t.ico} alt="" />
              <span className="tabbar-label">{t.label}</span>
            </button>
          );
        })}
      </nav>
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
          onSelectClient={(id) => { setView({ type: 'clients', clientId: id }); setSearchOpen(false); }}
          onSelectTask={(id) => { setView({ type: 'tasks' }); setTaskToOpen(id); setSearchOpen(false); }}
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
      <NotificationPopups popups={popups} onOpen={(n) => { dismissPopup(n.id); selectNotification(n); }} onClose={dismissPopup} />
    </div>
  );
}
