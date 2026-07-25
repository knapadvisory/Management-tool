import React from 'react';
import useDragPosition from '../useDragPosition.js';

// A centered modal panel you can reposition by dragging its header. Re-centers
// every time it's opened (mounted). Clicking the dimmed backdrop closes it;
// header controls (buttons, inputs) still work — a drag only starts on empty
// header space.
export default function DraggablePanel({ onClose, className = '', header, children }) {
  const { style, onPointerDown } = useDragPosition();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal draggable-panel ${className}`} style={style} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header drag-handle" onPointerDown={onPointerDown} title="Drag to move">
          {header}
        </div>
        {children}
      </div>
    </div>
  );
}
