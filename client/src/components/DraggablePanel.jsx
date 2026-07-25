import React, { useRef, useState, useCallback } from 'react';

// A centered modal panel you can reposition by dragging its header. State is
// self-contained, so the panel re-centers every time it's opened (mounted).
// Clicking the dimmed backdrop closes it; controls in the header (buttons,
// inputs) still work — a drag only starts on empty header space.
export default function DraggablePanel({ onClose, className = '', header, children }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef(null);

  const onPointerDown = useCallback((e) => {
    // Don't hijack clicks on the close button / any control inside the header.
    if (e.target.closest('button, input, select, a, textarea')) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    const move = (ev) => {
      if (!drag.current) return;
      setPos({
        x: drag.current.ox + (ev.clientX - drag.current.sx),
        y: drag.current.oy + (ev.clientY - drag.current.sy),
      });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [pos]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal draggable-panel ${className}`}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header drag-handle" onPointerDown={onPointerDown} title="Drag to move">
          {header}
        </div>
        {children}
      </div>
    </div>
  );
}
