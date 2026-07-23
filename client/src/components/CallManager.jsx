import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { getSocket, onSocket } from '../socket.js';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { showDesktopNotification } from '../desktopNotify.js';
import { startRingtone, stopRingtone } from '../ringtone.js';

// Stop the native call notification's ring once the call is answered/declined.
function stopNativeRing() {
  try { window.TeamHubNative?.cancelIncomingCall?.(); } catch { /* web app */ }
}
const isNativeApp = () => { try { return !!Capacitor?.isNativePlatform?.(); } catch { return false; } };
const nativeBridge = () => { try { return window.TeamHubNative || null; } catch { return null; } };
// Ordered list of audio outputs to cycle through (bluetooth only when present).
function audioRoutes() {
  const nb = nativeBridge();
  const bt = nb && typeof nb.hasBluetooth === 'function' && nb.hasBluetooth();
  return bt ? ['earpiece', 'speaker', 'bluetooth'] : ['earpiece', 'speaker'];
}
function applyRoute(r) {
  try { nativeBridge()?.setAudioRoute?.(r); } catch { /* web app: browser handles output */ }
}

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * 1:1 audio/video calls over WebRTC. The server relays signaling
 * (offer/answer/ICE) via socket.io; media flows peer-to-peer (through a TURN
 * relay when one is configured, so calls connect across NATs/firewalls).
 * The caller creates the offer once the callee accepts.
 */
export default function CallManager({ user }) {
  // call: { peer, call_type, direction: 'in'|'out', status: 'ringing'|'connecting'|'active' }
  const [call, setCall] = useState(null);
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [route, setRoute] = useState('earpiece'); // earpiece | speaker | bluetooth
  const facingRef = useRef('user'); // 'user' (front) | 'environment' (rear)
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callRef = useRef(null);
  const iceServersRef = useRef(DEFAULT_ICE);
  const pendingCandidatesRef = useRef([]); // ICE candidates that arrived before the remote description
  const remoteReadyRef = useRef(false);
  callRef.current = call;

  // Load the ICE server list (STUN + optional TURN) once.
  useEffect(() => {
    api('/config').then((c) => {
      if (Array.isArray(c.ice_servers) && c.ice_servers.length) iceServersRef.current = c.ice_servers;
    }).catch(() => {});
  }, []);

  // Keep the local self-view attached whenever the call UI is on screen.
  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  }, [call]);

  function cleanup() {
    stopRingtone();
    stopNativeRing();
    try { nativeBridge()?.resetAudioRoute?.(); } catch { /* web app */ }
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pendingCandidatesRef.current = [];
    remoteReadyRef.current = false;
    facingRef.current = 'user';
    setMuted(false);
    setCamOff(false);
    setRoute('earpiece');
    setCall(null);
  }

  async function getMedia(callType) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }

  function createPeer(peerId) {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pcRef.current = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) getSocket()?.emit('call:signal', { to_user_id: peerId, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        setCall((c) => (c ? { ...c, status: 'active' } : c));
      } else if (st === 'failed') {
        setError('The call could not connect. You may be on a restricted network.');
        cleanup();
      }
    };
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    return pc;
  }

  // Add a remote description, then flush any ICE candidates that raced ahead of it.
  async function applyRemote(pc, sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    remoteReadyRef.current = true;
    for (const c of pendingCandidatesRef.current.splice(0)) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* stale */ }
    }
  }

  useEffect(() => {
    async function onStartCall(e) {
      const { user: peer, call_type } = e.detail;
      if (!peer || callRef.current) return;
      try {
        await getMedia(call_type);
      } catch {
        setError('Could not access microphone/camera. Check browser permissions.');
        return;
      }
      setCall({ peer, call_type, direction: 'out', status: 'ringing' });
      getSocket()?.emit('call:invite', { to_user_id: peer.id, call_type });
    }

    const onIncoming = ({ from, call_type }) => {
      if (callRef.current) {
        getSocket()?.emit('call:reject', { to_user_id: from.id });
        return;
      }
      setCall({ peer: from, call_type, direction: 'in', status: 'ringing' });
      showDesktopNotification(`Incoming ${call_type} call`, {
        body: `${from.name} is calling you`,
        tag: 'incoming-call',
        force: true, // a call is urgent — alert even if the tab is focused
      });
    };

    // Callee accepted -> caller creates and sends the offer.
    const onAccepted = async ({ from }) => {
      const current = callRef.current;
      if (!current || from.id !== current.peer.id) return;
      try {
        const pc = createPeer(from.id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        getSocket()?.emit('call:signal', { to_user_id: from.id, data: { sdp: pc.localDescription } });
        setCall((c) => c && { ...c, status: 'connecting' });
      } catch {
        setError('Could not start the call.');
        cleanup();
      }
    };

    const onSignal = async ({ from_user_id, data }) => {
      const current = callRef.current;
      if (!current || from_user_id !== current.peer.id) return;
      try {
        let pc = pcRef.current;
        if (data.sdp) {
          if (data.sdp.type === 'offer') {
            if (!pc) pc = createPeer(from_user_id);
            await applyRemote(pc, data.sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            getSocket()?.emit('call:signal', { to_user_id: from_user_id, data: { sdp: pc.localDescription } });
            setCall((c) => c && { ...c, status: 'connecting' });
          } else if (pc) {
            await applyRemote(pc, data.sdp);
          }
        } else if (data.candidate) {
          // Queue candidates until the remote description is in place.
          if (pc && remoteReadyRef.current) {
            try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch { /* stale */ }
          } else {
            pendingCandidatesRef.current.push(data.candidate);
          }
        }
      } catch {
        setError('The call dropped during setup.');
        cleanup();
      }
    };

    const onRejected = () => { setError('Call declined'); cleanup(); };
    const onEnded = () => cleanup();
    // The call was answered or declined on another of my devices — stop ringing
    // here (only dismiss an unanswered incoming call, never an active one).
    const onHandled = () => {
      // Only the callee's OTHER devices receive this, so any not-yet-active
      // incoming call here is stale — clear it.
      const c = callRef.current;
      if (c && c.direction === 'in' && c.status !== 'active') cleanup();
    };

    const attach = (socket) => {
      socket.on('call:incoming', onIncoming);
      socket.on('call:accepted', onAccepted);
      socket.on('call:signal', onSignal);
      socket.on('call:rejected', onRejected);
      socket.on('call:ended', onEnded);
      socket.on('call:handled', onHandled);
    };

    window.addEventListener('teamhub:start-call', onStartCall);
    // Attach as soon as the socket exists — even if it connects AFTER this
    // component mounted (it usually does), and again on every reconnect.
    const detach = onSocket(attach);
    return () => {
      window.removeEventListener('teamhub:start-call', onStartCall);
      detach();
      const s = getSocket();
      s?.off('call:incoming', onIncoming);
      s?.off('call:accepted', onAccepted);
      s?.off('call:signal', onSignal);
      s?.off('call:rejected', onRejected);
      s?.off('call:ended', onEnded);
      s?.off('call:handled', onHandled);
    };
    // Reconnects create a new socket; user change re-runs this effect.
  }, [user.id]);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(t);
    }
  }, [error]);

  // Ring for an unanswered incoming call. In the browser/desktop app the
  // ringtone is synthesized here; in the native app the call notification
  // channel already rings, so we stay silent to avoid doubling up.
  useEffect(() => {
    const ringing = call && call.direction === 'in' && call.status === 'ringing';
    if (ringing && !isNativeApp()) startRingtone();
    else stopRingtone();
    return () => stopRingtone();
  }, [call?.direction, call?.status]);

  // When a call connects, default the audio to the natural output — earpiece
  // for a voice call, speakerphone for video — and reflect it in the toggle.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const active = call && (call.status === 'connecting' || call.status === 'active');
    if (active && !wasActiveRef.current) {
      wasActiveRef.current = true;
      const def = call.call_type === 'video' ? 'speaker' : 'earpiece';
      setRoute(def);
      applyRoute(def);
    } else if (!active) {
      wasActiveRef.current = false;
    }
  }, [call?.status, call?.call_type]);

  function cycleRoute() {
    const routes = audioRoutes();
    const next = routes[(routes.indexOf(route) + 1) % routes.length];
    setRoute(next);
    applyRoute(next);
  }

  // Flip between the front and rear camera without dropping the call: grab the
  // other camera and hot-swap the outgoing video track.
  async function switchCamera() {
    try {
      const stream = localStreamRef.current;
      if (!stream) return;
      const next = facingRef.current === 'user' ? 'environment' : 'user';
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: next } });
      const newTrack = fresh.getVideoTracks()[0];
      if (!newTrack) return;
      const sender = pcRef.current?.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      const old = stream.getVideoTracks()[0];
      if (old) { stream.removeTrack(old); old.stop(); }
      stream.addTrack(newTrack);
      newTrack.enabled = !camOff;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      facingRef.current = next;
    } catch {
      setError('Could not switch camera.');
    }
  }

  async function accept() {
    stopRingtone();
    stopNativeRing();
    try {
      await getMedia(call.call_type);
    } catch {
      setError('Could not access microphone/camera. Check browser permissions.');
      getSocket()?.emit('call:reject', { to_user_id: call.peer.id });
      cleanup();
      return;
    }
    getSocket()?.emit('call:accept', { to_user_id: call.peer.id });
    setCall((c) => c && { ...c, status: 'connecting' });
  }

  function reject() {
    getSocket()?.emit('call:reject', { to_user_id: call.peer.id });
    cleanup();
  }

  function hangUp() {
    getSocket()?.emit('call:end', { to_user_id: call.peer.id });
    cleanup();
  }

  function toggleMute() {
    const tracks = localStreamRef.current?.getAudioTracks() || [];
    const next = !muted;
    tracks.forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }

  function toggleCamera() {
    const tracks = localStreamRef.current?.getVideoTracks() || [];
    const next = !camOff;
    tracks.forEach((t) => { t.enabled = !next; });
    setCamOff(next);
  }

  if (!call && !error) return null;

  const inCall = call && (call.status === 'connecting' || call.status === 'active');
  const isIncomingRing = call && call.direction === 'in' && call.status === 'ringing';
  const statusText = !call ? '' :
    call.status === 'ringing'
      ? (call.direction === 'in' ? `Incoming ${call.call_type} call` : 'Ringing…')
      : call.status === 'connecting' ? 'Connecting…'
      : `${call.call_type === 'video' ? 'Video' : 'Audio'} call in progress`;

  return (
    <>
      {error && <div className="toast toast-error">{error}</div>}
      {call && (
        <div className={`call-overlay ${isIncomingRing ? 'call-incoming' : ''}`}>
          <div className={`call-window ${isIncomingRing ? 'incoming' : ''}`}>
            {isIncomingRing ? (
              <div className="call-incoming-hero">
                <div className="call-incoming-avatar"><Avatar user={call.peer} size={120} /></div>
                <strong className="call-incoming-name">{call.peer.name}</strong>
                <div className="call-incoming-sub">{call.call_type === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call'}</div>
              </div>
            ) : (
              <div className="call-peer">
                <Avatar user={call.peer} size={56} />
                <div>
                  <strong>{call.peer.name}</strong>
                  <div className="call-status">{statusText}</div>
                </div>
              </div>
            )}

            <div className={`call-media ${call.call_type === 'video' && inCall ? '' : 'hidden'}`}>
              <video ref={remoteVideoRef} autoPlay playsInline className="remote-video" />
              <video ref={localVideoRef} autoPlay playsInline muted className="local-video" />
            </div>
            {call.call_type === 'audio' && <audio ref={remoteAudioRef} autoPlay />}

            <div className="call-buttons">
              {isIncomingRing ? (
                <>
                  <div className="call-action">
                    <button className="call-round call-decline" onClick={reject} aria-label="Decline">✕</button>
                    <span className="call-action-label">Decline</span>
                  </div>
                  <div className="call-action">
                    <button className="call-round call-answer" onClick={accept} aria-label="Accept">📞</button>
                    <span className="call-action-label">Accept</span>
                  </div>
                </>
              ) : (
                <>
                  {inCall && (
                    <>
                      <div className="call-action">
                        <button className={`call-ctrl ${muted ? 'active' : ''}`} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? '🔇' : '🎙'}</button>
                        <span className="call-action-label">{muted ? 'Unmute' : 'Mute'}</span>
                      </div>
                      <div className="call-action">
                        <button className="call-ctrl" onClick={cycleRoute} aria-label="Audio output">{route === 'speaker' ? '🔊' : route === 'bluetooth' ? '🎧' : '🔈'}</button>
                        <span className="call-action-label">{route === 'speaker' ? 'Speaker' : route === 'bluetooth' ? 'Bluetooth' : 'Earpiece'}</span>
                      </div>
                      {call.call_type === 'video' && (
                        <>
                          <div className="call-action">
                            <button className={`call-ctrl ${camOff ? 'active' : ''}`} onClick={toggleCamera} aria-label={camOff ? 'Turn camera on' : 'Turn camera off'}>{camOff ? '📷' : '🎥'}</button>
                            <span className="call-action-label">{camOff ? 'Camera on' : 'Camera off'}</span>
                          </div>
                          <div className="call-action">
                            <button className="call-ctrl" onClick={switchCamera} aria-label="Switch camera">🔄</button>
                            <span className="call-action-label">Flip</span>
                          </div>
                        </>
                      )}
                    </>
                  )}
                  <div className="call-action">
                    <button className="call-round call-decline" onClick={hangUp} aria-label={call.status === 'ringing' ? 'Cancel' : 'Hang up'}>✕</button>
                    <span className="call-action-label">{call.status === 'ringing' ? 'Cancel' : 'Hang up'}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
