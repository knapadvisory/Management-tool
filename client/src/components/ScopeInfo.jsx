import React from 'react';

// A small ⓘ marker that explains exactly what a metric counts, so numbers that
// legitimately differ across screens (different time windows or scopes) are
// self-explanatory. Hover (desktop) or tap (mobile) shows the note; the click is
// swallowed so tapping the ⓘ on a clickable KPI tile doesn't also trigger the
// tile's drill-down.
export default function ScopeInfo({ text }) {
  return (
    <span
      className="scope-info"
      role="img"
      aria-label={text}
      title={text}
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
    >
      ⓘ
    </span>
  );
}
