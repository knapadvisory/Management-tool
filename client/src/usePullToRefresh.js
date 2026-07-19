import { useEffect, useRef, useState } from 'react';

// Pull-to-refresh for the native app. Attaches touch handlers to a container
// element; when the user drags down while the inner scroll area is already at
// the top, it shows a pull indicator and — past a threshold — runs onRefresh.
// Deliberately conservative: it only engages at scrollTop 0 on a clear downward
// drag, so it never fights normal scrolling.

const THRESHOLD = 70; // px of pull needed to trigger a refresh
const MAX = 110; // px the indicator can stretch to

// Nearest scrollable ancestor of `el` up to (and including) `root`.
function nearestScrollable(el, root) {
  let n = el;
  while (n && n !== root.parentElement) {
    if (n.scrollHeight > n.clientHeight) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
    }
    if (n === root) break;
    n = n.parentElement;
  }
  return root;
}

export function usePullToRefresh(onRefresh, enabled = true) {
  const ref = useRef(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const st = useRef({ startY: 0, active: false, scroller: null, pull: 0, busy: false });

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    const set = (v) => { st.current.pull = v; setPull(v); };

    const onStart = (e) => {
      if (e.touches.length !== 1 || st.current.busy) return;
      const scroller = nearestScrollable(e.target, el);
      st.current.startY = e.touches[0].clientY;
      st.current.scroller = scroller;
      st.current.active = scroller.scrollTop <= 0;
    };
    const onMove = (e) => {
      const s = st.current;
      if (!s.active || s.busy) return;
      const dy = e.touches[0].clientY - s.startY;
      // Bail if the scroller moved off the top or the drag turned upward.
      if (dy <= 0 || (s.scroller && s.scroller.scrollTop > 0)) { if (s.pull) set(0); return; }
      e.preventDefault(); // requires a non-passive listener (below)
      set(Math.min(MAX, dy * 0.5));
    };
    const onEnd = async () => {
      const s = st.current;
      if (!s.active) return;
      s.active = false;
      if (s.pull >= THRESHOLD) {
        s.busy = true; setRefreshing(true); set(MAX);
        try { await onRefresh(); } catch { /* ignore */ }
        s.busy = false; setRefreshing(false); set(0);
      } else {
        set(0);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, onRefresh]);

  return { ref, pull, refreshing };
}
