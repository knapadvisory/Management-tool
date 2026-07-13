import React, { useEffect, useRef, useState } from 'react';
import { getSocket, onSocket } from '../socket.js';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { showDesktopNotification } from '../desktopNotify.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Multi-party calls (collab huddles + ad-hoc conferences) over WebRTC. Media
 * flows peer-to-peer in a mesh — one RTCPeerConnection per other participant —
 * while the server relays signaling. To avoid glare, the LATER joiner always
 * creates the offer: on join we dial every existing peer; an existing peer just
 * answers when the newcomer's offer arrives.
 */
export default function GroupCallManager({ user, users = [] }) {
  const [room, setRoom] = useState(null); // { room_id, kind, collab_id, call_type, title }
  const [incoming, setIncoming] = useState(null); // pending ring
  const [tiles, setTiles] = useState([]); // [{ user, stream }]
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [chat, setChat] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [error, setError] = useState(null);

  const pcsRef = useRef(new Map());      // peerId -> RTCPeerConnection (+ _pending, _ready)
  const localStreamRef = useRef(null);
  const screenTrackRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const iceRef = useRef(DEFAULT_ICE);
  const roomRef = useRef(null);
  const localVideoRef = useRef(null);
  roomRef.current = room;

  useEffect(() => {
    api('/config').then((c) => {
      if (Array.isArray(c.ice_servers) && c.ice_servers.length) iceRef.current = c.ice_servers;
    }).catch(() => {});
  }, []);

  // Keep the local self-view wired up whenever the call UI is on screen.
  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  });

  function setTileStream(peer, stream) {
    setTiles((ts) => {
      const idx = ts.findIndex((t) => t.user.id === peer.id);
      if (idx === -1) return [...ts, { user: peer, stream }];
      const copy = [...ts]; copy[idx] = { user: peer, stream }; return copy;
    });
  }
  function removeTile(peerId) {
    setTiles((ts) => ts.filter((t) => t.user.id !== peerId));
  }

  async function getMedia(callType) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
    localStreamRef.current = stream;
    cameraTrackRef.current = stream.getVideoTracks()[0] || null;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }

  function peerConn(peerUser) {
    const existing = pcsRef.current.get(peerUser.id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    pc._pending = [];
    pc._ready = false;
    pc.onicecandidate = (e) => {
      if (e.candidate && roomRef.current) {
        getSocket()?.emit('call:room:signal', { room_id: roomRef.current.room_id, to_user_id: peerUser.id, data: { candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => setTileStream(peerUser, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // A dropped peer connection just removes their tile; the room lives on.
      }
    };
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    pcsRef.current.set(peerUser.id, pc);
    return pc;
  }

  async function dial(peerUser) {
    const pc = peerConn(peerUser);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      getSocket()?.emit('call:room:signal', { room_id: roomRef.current.room_id, to_user_id: peerUser.id, data: { sdp: pc.localDescription } });
    } catch { /* peer may have vanished */ }
  }

  async function applyRemote(pc, sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    pc._ready = true;
    for (const c of pc._pending.splice(0)) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* stale */ }
    }
  }

  function teardown() {
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    cameraTrackRef.current = null;
    setTiles([]);
    setChat([]);
    setChatOpen(false);
    setShowInvite(false);
    setMuted(false);
    setCamOff(false);
    setSharing(false);
    setRoom(null);
  }

  function leave() {
    const r = roomRef.current;
    if (r) getSocket()?.emit('call:room:leave', { room_id: r.room_id });
    teardown();
  }

  // Join (or start) a room, then dial everyone already inside.
  async function joinRoom({ room_id, kind, target_id, call_type, title, invite_user_ids }) {
    if (roomRef.current) return;
    try {
      await getMedia(call_type);
    } catch {
      setError('Could not access microphone/camera. Check browser permissions.');
      return;
    }
    const socket = getSocket();
    socket?.emit('call:room:join', { room_id, kind, target_id, call_type }, (res) => {
      if (!res || res.error) {
        setError(res?.error || 'Could not join the call.');
        teardown();
        return;
      }
      const joined = { room_id: res.room_id, kind: res.kind, collab_id: res.collab_id, call_type: res.call_type, title: title || null };
      setRoom(joined);
      roomRef.current = joined;
      (res.peers || []).forEach((p) => dial(p)); // we are the newest — offer to each
      if (invite_user_ids?.length) socket.emit('call:room:invite', { room_id: res.room_id, user_ids: invite_user_ids });
    });
  }

  useEffect(() => {
    // Start a call from elsewhere in the app (collab header / conference tab).
    async function onStart(e) { joinRoom(e.detail || {}); }

    const onIncoming = (msg) => {
      if (roomRef.current) return; // already busy
      setIncoming(msg);
      showDesktopNotification(`Incoming ${msg.call_type} call`, {
        body: `${msg.from.name} is inviting you${msg.title ? ` — ${msg.title}` : ''}`,
        tag: 'incoming-room-call', force: true,
      });
    };

    const onPeerJoined = ({ room_id, user: peer }) => {
      // Existing members just prepare a connection and wait for the newcomer's
      // offer (the joiner is always the offerer).
      if (roomRef.current?.room_id === room_id) peerConn(peer);
    };
    const onPeerLeft = ({ room_id, user_id }) => {
      if (roomRef.current?.room_id !== room_id) return;
      pcsRef.current.get(user_id)?.close();
      pcsRef.current.delete(user_id);
      removeTile(user_id);
    };

    const onSignal = async ({ room_id, from_user_id, data }) => {
      if (roomRef.current?.room_id !== room_id) return;
      const peer = users.find((u) => u.id === from_user_id) || tiles.find((t) => t.user.id === from_user_id)?.user || { id: from_user_id, name: 'Participant' };
      const pc = peerConn(peer);
      try {
        if (data.sdp) {
          if (data.sdp.type === 'offer') {
            await applyRemote(pc, data.sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            getSocket()?.emit('call:room:signal', { room_id, to_user_id: from_user_id, data: { sdp: pc.localDescription } });
          } else {
            await applyRemote(pc, data.sdp);
          }
        } else if (data.candidate) {
          if (pc._ready) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch { /* stale */ } }
          else pc._pending.push(data.candidate);
        }
      } catch { /* setup race; ignore */ }
    };

    const onEnded = ({ room_id }) => { if (roomRef.current?.room_id === room_id) teardown(); };
    const onChat = (msg) => { if (roomRef.current?.room_id === msg.room_id) setChat((c) => [...c, msg]); };

    const attach = (socket) => {
      socket.on('call:room:incoming', onIncoming);
      socket.on('call:room:peer-joined', onPeerJoined);
      socket.on('call:room:peer-left', onPeerLeft);
      socket.on('call:room:signal', onSignal);
      socket.on('call:room:ended', onEnded);
      socket.on('call:room:chat', onChat);
    };

    window.addEventListener('teamhub:start-room-call', onStart);
    const detach = onSocket(attach);
    return () => {
      window.removeEventListener('teamhub:start-room-call', onStart);
      detach();
      const s = getSocket();
      s?.off('call:room:incoming', onIncoming);
      s?.off('call:room:peer-joined', onPeerJoined);
      s?.off('call:room:peer-left', onPeerLeft);
      s?.off('call:room:signal', onSignal);
      s?.off('call:room:ended', onEnded);
      s?.off('call:room:chat', onChat);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, users, tiles]);

  useEffect(() => {
    if (error) { const t = setTimeout(() => setError(null), 5000); return () => clearTimeout(t); }
  }, [error]);

  async function acceptIncoming() {
    const msg = incoming;
    setIncoming(null);
    await joinRoom({ room_id: msg.room_id, kind: msg.kind, target_id: msg.collab_id, call_type: msg.call_type, title: msg.title });
  }
  function declineIncoming() {
    if (incoming) getSocket()?.emit('call:room:decline', { room_id: incoming.room_id });
    setIncoming(null);
  }

  function toggleMute() {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }
  function toggleCamera() {
    const next = !camOff;
    localStreamRef.current?.getVideoTracks().forEach((t) => { t.enabled = !next; });
    setCamOff(next);
  }

  // Swap the outgoing video track on every peer connection (screen <-> camera).
  function replaceVideoEverywhere(track) {
    pcsRef.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(track);
    });
  }
  async function toggleScreenShare() {
    if (sharing) {
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      if (cameraTrackRef.current) replaceVideoEverywhere(cameraTrackRef.current);
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      setSharing(false);
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      screenTrackRef.current = track;
      replaceVideoEverywhere(track);
      // Show the shared screen in the local self-view too.
      if (localVideoRef.current) localVideoRef.current.srcObject = display;
      track.onended = () => { if (roomRef.current) toggleScreenShare(); };
      setSharing(true);
    } catch { /* user cancelled the picker */ }
  }

  function sendChat(text) {
    text = (text || '').trim();
    if (!text || !roomRef.current) return;
    getSocket()?.emit('call:room:chat', { room_id: roomRef.current.room_id, text });
  }
  function inviteUsers(ids) {
    if (!ids.length || !roomRef.current) return;
    getSocket()?.emit('call:room:invite', { room_id: roomRef.current.room_id, user_ids: ids });
    setShowInvite(false);
  }

  const isVideo = room?.call_type === 'video';

  return (
    <>
      {error && <div className="toast toast-error">{error}</div>}

      {incoming && !room && (
        <div className="call-overlay">
          <div className="call-window ring">
            <Avatar user={incoming.from} size={64} />
            <strong>{incoming.from.name}</strong>
            <div className="call-status">
              Inviting you to a {incoming.call_type} call{incoming.title ? ` · ${incoming.title}` : ''}
            </div>
            <div className="call-buttons">
              <button className="btn btn-success" onClick={acceptIncoming}>Join</button>
              <button className="btn btn-danger" onClick={declineIncoming}>Decline</button>
            </div>
          </div>
        </div>
      )}

      {room && (
        <div className="call-overlay">
          <div className="room-call">
            <div className="room-topbar">
              <span className="room-title">{room.title || (room.kind === 'collab' ? 'Huddle' : 'Conference call')}</span>
              <span className="room-count">{tiles.length + 1} in call</span>
            </div>

            <div className={`room-grid tiles-${Math.min(tiles.length + 1, 9)}`}>
              <div className="video-tile">
                {isVideo ? (
                  <video ref={localVideoRef} autoPlay playsInline muted className={camOff && !sharing ? 'off' : ''} />
                ) : <Avatar user={user} size={72} />}
                {(!isVideo || (camOff && !sharing)) && <Avatar user={user} size={72} className="tile-avatar" />}
                <span className="tile-name">You{muted ? ' 🔇' : ''}{sharing ? ' · sharing' : ''}</span>
              </div>
              {tiles.map((t) => <RemoteTile key={t.user.id} tile={t} isVideo={isVideo} />)}
            </div>

            {chatOpen && (
              <CallChat chat={chat} onSend={sendChat} onClose={() => setChatOpen(false)} meId={user.id} />
            )}

            <div className="room-controls">
              <button className={`call-toggle ${muted ? 'on' : ''}`} onClick={toggleMute}>{muted ? '🔇' : '🎙'}<span>{muted ? 'Unmute' : 'Mute'}</span></button>
              {isVideo && <button className={`call-toggle ${camOff ? 'on' : ''}`} onClick={toggleCamera}>{camOff ? '📷' : '🎥'}<span>{camOff ? 'Start video' : 'Stop video'}</span></button>}
              {isVideo && <button className={`call-toggle ${sharing ? 'on' : ''}`} onClick={toggleScreenShare}>🖥<span>{sharing ? 'Stop share' : 'Share'}</span></button>}
              <button className={`call-toggle ${chatOpen ? 'on' : ''}`} onClick={() => setChatOpen((v) => !v)}>💬<span>Chat</span></button>
              <button className="call-toggle" onClick={() => setShowInvite(true)}>＋<span>Add people</span></button>
              <button className="call-toggle leave" onClick={leave}>📞<span>Leave</span></button>
            </div>
          </div>

          {showInvite && (
            <InvitePicker
              users={users.filter((u) => u.id !== user.id && !tiles.some((t) => t.user.id === u.id))}
              onCancel={() => setShowInvite(false)}
              onInvite={inviteUsers}
            />
          )}
        </div>
      )}
    </>
  );
}

function RemoteTile({ tile, isVideo }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && tile.stream) ref.current.srcObject = tile.stream; }, [tile.stream]);
  const hasVideo = isVideo && tile.stream?.getVideoTracks().some((t) => t.enabled);
  return (
    <div className="video-tile">
      {isVideo && <video ref={ref} autoPlay playsInline />}
      {!isVideo && <audio ref={ref} autoPlay />}
      {!hasVideo && <Avatar user={tile.user} size={72} className="tile-avatar" />}
      <span className="tile-name">{tile.user.name}</span>
    </div>
  );
}

function CallChat({ chat, onSend, onClose, meId }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [chat]);
  return (
    <div className="call-chat">
      <div className="call-chat-head"><span>In-call chat</span><button className="icon-btn" onClick={onClose}>✕</button></div>
      <div className="call-chat-body">
        {chat.length === 0 && <div className="muted small">Messages here vanish when the call ends.</div>}
        {chat.map((m, i) => (
          <div key={i} className={`call-chat-msg ${m.from.id === meId ? 'me' : ''}`}>
            <strong>{m.from.name}</strong><span>{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="call-chat-input" onSubmit={(e) => { e.preventDefault(); onSend(text); setText(''); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" />
        <button className="btn btn-sm btn-primary" type="submit">Send</button>
      </form>
    </div>
  );
}

function InvitePicker({ users, onCancel, onInvite }) {
  const [sel, setSel] = useState([]);
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add people to the call</h3>
        <div className="invite-list">
          {users.length === 0 && <div className="muted">Everyone's already here.</div>}
          {users.map((u) => (
            <label key={u.id} className="invite-row">
              <input type="checkbox" checked={sel.includes(u.id)} onChange={() => toggle(u.id)} />
              <Avatar user={u} size={28} /> <span>{u.name}</span>
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!sel.length} onClick={() => onInvite(sel)}>Ring {sel.length || ''}</button>
        </div>
      </div>
    </div>
  );
}
