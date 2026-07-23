import React from 'react';
import { fileUrl } from '../api.js';

export default function Avatar({ user, size = 32, online }) {
  const initials = (user?.name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  // avatar_url holds the id of an uploaded profile photo (or '' for none).
  const photo = user?.avatar_url ? fileUrl(user.avatar_url) : null;
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      {photo ? (
        <img
          className="avatar avatar-photo"
          src={photo}
          alt={user?.name || ''}
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="avatar"
          style={{ width: size, height: size, background: user?.avatar_color || '#666', fontSize: size * 0.4 }}
        >
          {initials}
        </span>
      )}
      {online !== undefined && <span className={`presence-dot ${online ? 'on' : 'off'}`} />}
    </span>
  );
}
