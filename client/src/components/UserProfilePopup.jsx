import React, { useState } from 'react';
import Avatar from './Avatar.jsx';
import { fileUrl } from '../api.js';

// A small profile card shown when you tap someone in a group chat: their
// details plus quick actions to message or call them directly.
export default function UserProfilePopup({ profile, me, online = false, onOpenDm, onClose }) {
  const isSelf = profile.id === me.id;
  const [zoom, setZoom] = useState(false);
  const photo = profile.avatar_url ? fileUrl(profile.avatar_url) : null;

  function call(type) {
    window.dispatchEvent(new CustomEvent('teamhub:start-call', { detail: { user: profile, call_type: type } }));
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal profile-popup" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn profile-popup-x" onClick={onClose} aria-label="Close">✕</button>
        <div className="profile-popup-head">
          {photo ? (
            <button type="button" className="profile-popup-avatar" onClick={() => setZoom(true)} title="Tap to enlarge">
              <Avatar user={profile} size={88} online={online} />
            </button>
          ) : (
            <Avatar user={profile} size={88} online={online} />
          )}
          <div className="profile-popup-name">{profile.name}{isSelf ? ' (you)' : ''}</div>
          {profile.title && <div className="muted">{profile.title}</div>}
          <div className={`presence-text ${online ? 'on' : 'off'}`}>{online ? '● Online' : '○ Offline'}</div>
          {profile.email && <a className="profile-popup-email" href={`mailto:${profile.email}`}>{profile.email}</a>}
        </div>
        {!isSelf && (
          <div className="profile-popup-actions">
            {onOpenDm && <button className="btn btn-primary" onClick={() => { onOpenDm(profile); onClose(); }}>💬 Message</button>}
            <button className="btn" disabled={!online} title={online ? 'Audio call' : `${profile.name} is offline`} onClick={() => call('audio')}>📞 Call</button>
            <button className="btn" disabled={!online} title={online ? 'Video call' : `${profile.name} is offline`} onClick={() => call('video')}>🎥 Video</button>
          </div>
        )}
      </div>
      {zoom && photo && (
        <div className="img-lightbox" onClick={() => setZoom(false)}>
          <img src={photo} alt={profile.name} onClick={(e) => e.stopPropagation()} />
          <button className="img-lightbox-x" onClick={() => setZoom(false)} aria-label="Close">✕</button>
        </div>
      )}
    </div>
  );
}
