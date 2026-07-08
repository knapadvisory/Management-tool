import React, { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import { connectSocket, disconnectSocket, getSocket } from './socket.js';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import TasksBoard from './components/TasksBoard.jsx';
import WorkflowsView from './components/WorkflowsView.jsx';
import CallManager from './components/CallManager.jsx';
import SearchModal from './components/SearchModal.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [channels, setChannels] = useState([]);
  const [joinable, setJoinable] = useState([]);
  const [users, setUsers] = useState([]);
  const [onlineIds, setOnlineIds] = useState([]);
  // view: { type: 'channel', channel } | { type: 'tasks' } | { type: 'workflows' }
  const [view, setView] = useState(null);
  const [toast, setToast] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);

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

  // Restore session on load.
  useEffect(() => {
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

    refreshUsers();
    refreshChannels().then((d) => {
      const general = d.channels.find((c) => c.name === 'general' && !c.is_dm) || d.channels[0];
      setView((v) => v || (general ? { type: 'channel', channel: general } : { type: 'tasks' }));
    });

    return () => disconnectSocket();
  }, [user, refreshChannels, refreshUsers, showToast]);

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
  }

  async function openDm(otherUser) {
    const channel = await api(`/channels/dm/${otherUser.id}`, { method: 'POST' });
    getSocket()?.emit('channel:subscribe', channel.id);
    await refreshChannels();
    setView({ type: 'channel', channel });
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
      />
      <main className="main">
        {view?.type === 'channel' && (
          <ChatView key={view.channel.id} channel={view.channel} user={user} users={users} onlineIds={onlineIds} />
        )}
        {view?.type === 'tasks' && <TasksBoard user={user} users={users} />}
        {view?.type === 'workflows' && <WorkflowsView />}
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
