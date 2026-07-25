import React from 'react';
import infoIcon from '../assets/icons/information.png';

// A small info marker that explains exactly what a metric counts, so numbers
// that legitimately differ across screens (different time windows or scopes) are
// self-explanatory. Uses a styled tooltip (not the native browser title) so the
// text wraps and stays clear of the screen edge. Hover (desktop) or tap/focus
// (mobile/keyboard) reveals it; the click is swallowed so tapping the icon on a
// clickable KPI tile doesn't also trigger the tile's drill-down.
export default function ScopeInfo({ text }) {
  return (
    <span
      className="scope-info-wrap"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
    >
      <img src={infoIcon} className="scope-info" alt="info" />
      <span className="scope-tip" role="tooltip">{text}</span>
    </span>
  );
}
