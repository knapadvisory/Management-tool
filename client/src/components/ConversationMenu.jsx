import React from 'react';

// A small cursor-positioned context menu (right-click on a conversation row).
// items: [{ label, icon, danger?, onClick }]. Clamped to stay on-screen.
export default function ConversationMenu({ x, y, items, onClose }) {
  const W = 200, H = items.length * 40 + 8;
  const left = Math.min(window.innerWidth - W - 8, Math.max(8, x));
  const top = Math.min(window.innerHeight - H - 8, Math.max(8, y));
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="msg-menu" style={{ position: 'fixed', top, left, minWidth: W }}>
        {items.map((it) => (
          <button key={it.label} className={it.danger ? 'danger' : ''} onClick={it.onClick}>
            <span>{it.icon}</span> {it.label}
          </button>
        ))}
      </div>
    </>
  );
}
