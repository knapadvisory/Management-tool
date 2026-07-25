import { useRef, useState, useCallback } from 'react';

// Reusable "drag me around" behaviour for floating panels/modals. Returns a
// transform style for the panel and a pointer-down handler for its drag handle
// (usually the header). A drag won't start on an interactive control inside the
// handle (button / input / select / link / textarea), so close buttons and
// dropdowns keep working. State is local, so a freshly-mounted panel starts
// centered.
export default function useDragPosition() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef(null);

  const onPointerDown = useCallback((e) => {
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

  return { style: { transform: `translate(${pos.x}px, ${pos.y}px)` }, onPointerDown };
}
