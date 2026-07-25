import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import infoIcon from '../assets/icons/information.png';

// A small info marker that explains exactly what a metric counts, so numbers
// that legitimately differ across screens (different time windows or scopes) are
// self-explanatory. The tooltip is portalled to <body> and position:fixed, then
// clamped to the viewport, so it never gets clipped by a card or runs off either
// screen edge. Hover (desktop) or tap/focus (mobile/keyboard) reveals it; the
// click is swallowed so tapping the icon on a clickable KPI tile doesn't also
// trigger the tile's drill-down.
const MARGIN = 10;   // min gap from the viewport edge
const MAX_W = 260;

export default function ScopeInfo({ text }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null); // { left, top } in viewport coords, or null

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(MAX_W, window.innerWidth - 2 * MARGIN);
    // Centre on the icon, then clamp so the whole bubble stays on screen.
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    const top = r.bottom + 8; // below the icon
    setTip({ left, top, width: w, arrow: r.left + r.width / 2 - left });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  return (
    <span
      ref={ref}
      className="scope-info-wrap"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); tip ? hide() : show(); }}
    >
      <img src={infoIcon} className="scope-info" alt="info" />
      {tip && createPortal(
        <span className="scope-tip" role="tooltip" style={{ left: tip.left, top: tip.top, maxWidth: tip.width }}>
          <span className="scope-tip-arrow" style={{ left: tip.arrow }} />
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
