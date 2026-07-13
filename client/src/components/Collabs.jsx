import React, { useState, useEffect } from 'react';
import { getSocket } from '../socket.js';
import { localeArg, dateOpts } from '../prefs.js';
import ChatView from './ChatView.jsx';
import CollabForm from './CollabForm.jsx';
import CollabSettings from './CollabSettings.jsx';
import ConferenceStart from './ConferenceStart.jsx';

// Kick off a group call (collab huddle or ad-hoc conference) via GroupCallManager.
function startRoomCall(detail) {
  window.dispatchEvent(new CustomEvent('teamhub:start-room-call', { detail }));
}

function shortTime(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(localeArg(), dateOpts({ hour: 'numeric', minute: '2-digit' }))
    : d.toLocaleDateString(localeArg(), dateOpts({ day: 'numeric', month: 'short' }));
}

// Bitrix-style "Collabs": private group spaces with their own membership and
// permissions. Left = the collab list + create button; right = the create
// form, the open collab chat, or a promo empty state.
export default function Collabs({ user, users = [], collabs = [], onlineIds = [], onRefresh }) {
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [conferenceMode, setConferenceMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCall, setActiveCall] = useState(null); // live huddle in the open collab

  const selected = collabs.find((c) => c.id === selectedId) || null;

  useEffect(() => { if (selectedId) getSocket()?.emit('channel:subscribe', selectedId); }, [selectedId]);

  // Track whether the open collab has a live huddle (for the Join banner).
  useEffect(() => {
    setActiveCall(null);
    if (!selectedId) return;
    const socket = getSocket();
    if (!socket) return;
    socket.emit('call:room:status', { collab_id: selectedId }, (res) => {
      if (res?.active) setActiveCall(res);
    });
    const onActive = (m) => { if (m.collab_id === selectedId) setActiveCall(m); };
    const onEnded = (m) => { if (m.collab_id === selectedId) setActiveCall(null); };
    socket.on('call:room:active', onActive);
    socket.on('call:room:ended', onEnded);
    return () => { socket.off('call:room:active', onActive); socket.off('call:room:ended', onEnded); };
  }, [selectedId]);

  const q = query.trim().toLowerCase();
  const visible = collabs.filter((c) => !q || c.name.toLowerCase().includes(q));

  const myRole = selected
    ? (selected.members.find((m) => m.id === user.id)?.channel_role || (selected.owner_id === user.id ? 'owner' : 'member'))
    : null;
  const isManager = !!selected && (user.role === 'admin' || myRole === 'owner' || myRole === 'moderator');
  const canPost = !selected || selected.who_can_post !== 'mods' || myRole === 'owner' || myRole === 'moderator' || user.role === 'admin';

  function openCreate() { setCreating(true); setConferenceMode(false); setSelectedId(null); }
  function openConference() { setConferenceMode(true); setCreating(false); setSelectedId(null); }
  function selectCollab(id) { setCreating(false); setConferenceMode(false); setSelectedId(id); }

  return (
    <div className="messenger">
      <div className="msgr-list">
        <div className="msgr-search collab-search">
          <input placeholder="Find a collab" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="collab-new" title="New collab" onClick={openCreate}>＋</button>
        </div>

        <button className={`msgr-row conference-row ${conferenceMode ? 'active' : ''}`} onClick={openConference}>
          <span className="collab-avatar">📞</span>
          <div className="msgr-row-body">
            <div className="msgr-row-top"><span className="msgr-name">Conference call</span></div>
            <div className="msgr-preview">Start a call and add anyone</div>
          </div>
        </button>

        {visible.map((c) => (
          <button key={c.id} className={`msgr-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => selectCollab(c.id)}>
            <span className="collab-avatar">👥</span>
            <div className="msgr-row-body">
              <div className="msgr-row-top">
                <span className="msgr-name">{c.name}</span>
                <span className="msgr-time">{shortTime(c.last_activity)}</span>
              </div>
              <div className="msgr-preview">
                {c.last_message ? `${c.last_message.user_name}: ${c.last_message.content}` : `${c.members.length} member${c.members.length === 1 ? '' : 's'}`}
              </div>
            </div>
          </button>
        ))}

        {collabs.length === 0 && (
          <div className="collab-empty-list">
            <div className="collab-empty-art">💬</div>
            <p>No collab chats here yet</p>
          </div>
        )}
      </div>

      <div className="msgr-pane">
        {creating ? (
          <CollabForm
            user={user}
            users={users}
            onCancel={() => setCreating(false)}
            onCreated={(collab) => { setCreating(false); onRefresh?.(); setSelectedId(collab.id); }}
          />
        ) : conferenceMode ? (
          <ConferenceStart user={user} users={users} onlineIds={onlineIds} />
        ) : selected ? (
          <div className="collab-open">
            <div className="collab-bar">
              <div className="collab-bar-title">👥 {selected.name}</div>
              <div className="collab-bar-meta">
                <span className="muted">{selected.members.length} members</span>
                <button className="btn btn-sm" title="Start an audio huddle for this space"
                  onClick={() => startRoomCall({ kind: 'collab', target_id: selected.id, call_type: 'audio', title: selected.name })}>📞 Call</button>
                <button className="btn btn-sm" title="Start a video call for this space"
                  onClick={() => startRoomCall({ kind: 'collab', target_id: selected.id, call_type: 'video', title: selected.name })}>🎥 Video</button>
                {isManager && <button className="btn btn-sm" onClick={() => setShowSettings(true)}>⚙ Settings</button>}
              </div>
            </div>
            {activeCall && (
              <div className="call-live-banner">
                <span>🔴 {activeCall.call_type === 'video' ? 'Video call' : 'Call'} in progress{activeCall.peers?.length ? ` · ${activeCall.peers.length} in call` : ''}</span>
                <button className="btn btn-sm btn-primary"
                  onClick={() => startRoomCall({ kind: 'collab', target_id: selected.id, call_type: activeCall.call_type, title: selected.name })}>Join</button>
              </div>
            )}
            <ChatView key={selected.id} channel={selected} user={user} users={selected.members} onlineIds={onlineIds} canPost={canPost} />
          </div>
        ) : (
          <div className="collab-promo">
            <div className="collab-promo-badge">👥</div>
            <h2>A co-working space for your team &amp; clients</h2>
            <ul className="collab-promo-points">
              <li><strong>Focused membership</strong><span>Only the people involved — teammates and, later, clients.</span></li>
              <li><strong>Everything in one place</strong><span>Chat, files and calls for a single engagement.</span></li>
              <li><strong>You control access</strong><span>Owner and moderators, and who can invite or post.</span></li>
            </ul>
            <button className="btn btn-primary" onClick={openCreate}>Create collab</button>
          </div>
        )}
      </div>

      {showSettings && selected && (
        <CollabSettings
          collab={selected}
          user={user}
          users={users}
          onClose={() => setShowSettings(false)}
          onChanged={() => onRefresh?.()}
        />
      )}
    </div>
  );
}
