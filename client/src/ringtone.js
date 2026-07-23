// A synthesized ringtone — no audio file needed. Plays a classic two-tone
// telephone ring (440 + 480 Hz) in short bursts, repeating on a loop, using the
// Web Audio API. Used for incoming calls in the browser/desktop app. (In the
// native mobile app the ringtone comes from the call notification channel, so
// this stays off there to avoid double sound.)
let ctx = null;
let timer = null;

function burst(offset, dur) {
  const t0 = ctx.currentTime + offset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(440, t0);
  osc.frequency.setValueAtTime(480, t0 + dur / 2);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.04);
  gain.gain.setValueAtTime(0.22, t0 + dur - 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function startRingtone() {
  try {
    if (timer) return; // already ringing
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = ctx || new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const ring = () => { burst(0, 0.4); burst(0.6, 0.4); };
    ring();
    timer = setInterval(ring, 3000); // ring cadence, like a phone
  } catch { /* audio is best-effort */ }
}

export function stopRingtone() {
  if (timer) { clearInterval(timer); timer = null; }
}
