import React, { useEffect, useRef, useState } from 'react';
import { getSocket } from '../socket.js';
import Avatar from './Avatar.jsx';
import { showDesktopNotification } from '../desktopNotify.js';

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/**
 * 1:1 audio/video calls over WebRTC. The server relays signaling
 * (offer/answer/ICE) via socket.io; media flows peer-to-peer.
 * The caller creates the offer once the callee accepts.
 */
export default function CallManager({ user }) {
  // call: { peer, call_type, direction: 'in'|'out', status: 'ringing'|'active' }
  const [call, setCall] = useState(null);
  const [error, setError] = useState(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callRef = useRef(null);
  callRef.current = call;

  function cleanup() {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setCall(null);
  }

  async function getMedia(callType) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }

  function createPeer(peerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        getSocket()?.emit('call:signal', { to_user_id: peerId, data: { candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
    };
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    return pc;
  }

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

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
      socket.emit('call:invite', { to_user_id: peer.id, call_type });
    }

    const onIncoming = ({ from, call_type }) => {
      if (callRef.current) {
        socket.emit('call:reject', { to_user_id: from.id });
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
      const pc = createPeer(from.id);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:signal', { to_user_id: from.id, data: { sdp: pc.localDescription } });
      setCall((c) => c && { ...c, status: 'active' });
    };

    const onSignal = async ({ from_user_id, data }) => {
      const current = callRef.current;
      if (!current || from_user_id !== current.peer.id) return;
      let pc = pcRef.current;
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (!pc) pc = createPeer(from_user_id);
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('call:signal', { to_user_id: from_user_id, data: { sdp: pc.localDescription } });
        } else if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
      } else if (data.candidate && pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch { /* stale candidate */ }
      }
    };

    const onRejected = () => { setError('Call declined'); cleanup(); };
    const onEnded = () => cleanup();

    window.addEventListener('teamhub:start-call', onStartCall);
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:signal', onSignal);
    socket.on('call:rejected', onRejected);
    socket.on('call:ended', onEnded);
    return () => {
      window.removeEventListener('teamhub:start-call', onStartCall);
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:signal', onSignal);
      socket.off('call:rejected', onRejected);
      socket.off('call:ended', onEnded);
    };
    // Reconnects create a new socket; user change re-runs this effect.
  }, [user.id]);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(null), 4000);
      return () => clearTimeout(t);
    }
  }, [error]);

  async function accept() {
    try {
      await getMedia(call.call_type);
    } catch {
      setError('Could not access microphone/camera. Check browser permissions.');
      getSocket()?.emit('call:reject', { to_user_id: call.peer.id });
      cleanup();
      return;
    }
    getSocket()?.emit('call:accept', { to_user_id: call.peer.id });
    setCall((c) => c && { ...c, status: 'active' });
  }

  function reject() {
    getSocket()?.emit('call:reject', { to_user_id: call.peer.id });
    cleanup();
  }

  function hangUp() {
    getSocket()?.emit('call:end', { to_user_id: call.peer.id });
    cleanup();
  }

  if (!call && !error) return null;

  return (
    <>
      {error && <div className="toast toast-error">{error}</div>}
      {call && (
        <div className="call-overlay">
          <div className="call-window">
            <div className="call-peer">
              <Avatar user={call.peer} size={56} />
              <div>
                <strong>{call.peer.name}</strong>
                <div className="call-status">
                  {call.status === 'ringing'
                    ? call.direction === 'in'
                      ? `Incoming ${call.call_type} call…`
                      : 'Ringing…'
                    : `${call.call_type === 'video' ? 'Video' : 'Audio'} call in progress`}
                </div>
              </div>
            </div>

            <div className={`call-media ${call.call_type === 'video' && call.status === 'active' ? '' : 'hidden'}`}>
              <video ref={remoteVideoRef} autoPlay playsInline className="remote-video" />
              <video ref={localVideoRef} autoPlay playsInline muted className="local-video" />
            </div>
            {call.call_type === 'audio' && <audio ref={remoteAudioRef} autoPlay />}

            <div className="call-buttons">
              {call.status === 'ringing' && call.direction === 'in' ? (
                <>
                  <button className="btn btn-success" onClick={accept}>Accept</button>
                  <button className="btn btn-danger" onClick={reject}>Decline</button>
                </>
              ) : (
                <button className="btn btn-danger" onClick={hangUp}>
                  {call.status === 'ringing' ? 'Cancel' : 'Hang up'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
