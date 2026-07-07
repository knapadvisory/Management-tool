import React from 'react';

export default function Avatar({ user, size = 32, online }) {
  const initials = (user?.name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      <span
        className="avatar"
        style={{ width: size, height: size, background: user?.avatar_color || '#666', fontSize: size * 0.4 }}
      >
        {initials}
      </span>
      {online !== undefined && <span className={`presence-dot ${online ? 'on' : 'off'}`} />}
    </span>
  );
}
