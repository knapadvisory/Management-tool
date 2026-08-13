import React, { useState, useRef, useEffect, useCallback } from 'react';
import { api, uploadAvatar } from '../api.js';
import Avatar from './Avatar.jsx';
import { ACCENTS, applyTheme, saveLocalTheme } from '../theme.js';
import { notificationsSupported, notificationPermission, requestNotificationPermission, desktopEnabled, setDesktopEnabled } from '../desktopNotify.js';
import { enableWebPush } from '../webpush.js';
import { getPrefs, setPref } from '../prefs.js';
import { LANGUAGES, timeZones } from '../i18nData.js';
import { t, notifyLangChange } from '../i18n.js';

const SECTIONS = [
  { key: 'profile', tkey: 'settings.profile', icon: '👤' },
  { key: 'appearance', tkey: 'settings.appearance', icon: '🎨' },
  { key: 'notifications', tkey: 'settings.notifications', icon: '🔔' },
  { key: 'messages', tkey: 'settings.messages', icon: '💬' },
  { key: 'calendar', tkey: 'settings.calendar', icon: '📅' },
  { key: 'language', tkey: 'settings.language', icon: '🌐' },
  { key: 'accessibility', tkey: 'settings.accessibility', icon: '♿' },
  { key: 'location', tkey: 'settings.location', icon: '📍' },
  { key: 'advanced', tkey: 'settings.advanced', icon: '⚙️' },
  { key: 'account', tkey: 'settings.account', icon: '🔒' },
];

// A Slack-style Preferences hub: a left rail of categories and a panel per
// category. Extensible — add an entry to SECTIONS and a case below.
export default function SettingsModal({ user, colors = [], initialSection = 'profile', onClose, onSaved, onLogout }) {
  const [section, setSection] = useState(SECTIONS.some((s) => s.key === initialSection) ? initialSection : 'profile');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>{t('settings.title')}</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button key={s.key} className={`settings-nav-item ${section === s.key ? 'active' : ''}`} onClick={() => setSection(s.key)}>
                <span className="settings-nav-icon">{s.icon}</span> {t(s.tkey)}
              </button>
            ))}
            {onLogout && (
              <button className="settings-nav-item settings-signout" onClick={onLogout}>
                <span className="settings-nav-icon">⏻</span> Sign out
              </button>
            )}
          </nav>
          <div className="settings-panel">
            {section === 'profile' && <ProfilePanel user={user} colors={colors} onSaved={onSaved} />}
            {section === 'appearance' && <AppearancePanel user={user} onSaved={onSaved} />}
            {section === 'notifications' && <NotificationsPanel />}
            {section === 'messages' && <MessagesPanel />}
            {section === 'calendar' && <CalendarPanel />}
            {section === 'language' && <LanguagePanel />}
            {section === 'accessibility' && <AccessibilityPanel />}
            {section === 'location' && <LocationPanel />}
            {section === 'advanced' && <AdvancedPanel />}
            {section === 'account' && <AccountPanel user={user} onLogout={onLogout} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfilePanel({ user, colors, onSaved }) {
  const [name, setName] = useState(user.name || '');
  const [title, setTitle] = useState(user.title || '');
  const [color, setColor] = useState(user.avatar_color);
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url || '');
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const photoRef = useRef(null);
  const palette = colors.length ? colors : [user.avatar_color];
  const dirty = name.trim() !== (user.name || '') || (title.trim() || '') !== (user.title || '') || color !== user.avatar_color;

  async function save() {
    if (!name.trim()) { setMsg({ err: true, text: 'Name is required.' }); return; }
    setSaving(true); setMsg(null);
    try {
      const { user: u } = await api('/auth/me', { method: 'PATCH', body: { name: name.trim(), title: title.trim(), avatar_color: color } });
      onSaved(u); setMsg({ err: false, text: 'Profile saved.' });
    } catch (e) { setMsg({ err: true, text: e.message }); } finally { setSaving(false); }
  }

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { setMsg({ err: true, text: 'Please choose an image file.' }); return; }
    if (file.size > 5 * 1024 * 1024) { setMsg({ err: true, text: 'Image must be under 5 MB.' }); return; }
    setPhotoBusy(true); setMsg(null);
    try {
      const u = await uploadAvatar(file);
      setAvatarUrl(u.avatar_url); onSaved(u); setMsg({ err: false, text: 'Photo updated.' });
    } catch (e2) { setMsg({ err: true, text: e2.message }); } finally { setPhotoBusy(false); }
  }
  async function removePhoto() {
    setPhotoBusy(true); setMsg(null);
    try {
      const { user: u } = await api('/auth/me', { method: 'PATCH', body: { avatar_url: '' } });
      setAvatarUrl(''); onSaved(u); setMsg({ err: false, text: 'Photo removed.' });
    } catch (e) { setMsg({ err: true, text: e.message }); } finally { setPhotoBusy(false); }
  }

  return (
    <div>
      <h3 className="settings-title">Profile</h3>
      <div className="profile-head">
        <Avatar user={{ name: name || user.name, avatar_color: color, avatar_url: avatarUrl }} size={64} />
        <div className="profile-head-meta">
          <div className="profile-head-name">{name || user.name}</div>
          <div className="muted">{user.email}{user.role === 'admin' ? ' · Admin' : ''}</div>
          <div className="profile-photo-actions">
            <button type="button" className="btn btn-sm" disabled={photoBusy} onClick={() => photoRef.current?.click()}>{photoBusy ? 'Uploading…' : (avatarUrl ? 'Change photo' : 'Upload photo')}</button>
            {avatarUrl && <button type="button" className="btn btn-sm" disabled={photoBusy} onClick={removePhoto}>Remove</button>}
            <input ref={photoRef} type="file" accept="image/*" hidden onChange={onPhoto} />
          </div>
        </div>
      </div>
      <label className="profile-label">Display name</label>
      <input className="profile-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      <label className="profile-label">Title <span className="muted">(optional)</span></label>
      <input className="profile-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Accountant, Partner" />
      <label className="profile-label">Avatar colour</label>
      <div className="profile-swatches">
        {palette.map((c) => (
          <button key={c} type="button" className={`profile-swatch ${c === color ? 'sel' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c}>{c === color ? '✓' : ''}</button>
        ))}
      </div>
      {msg && <p className={msg.err ? 'form-error' : 'form-ok'}>{msg.text}</p>}
      <div className="editor-actions"><button className="btn btn-primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save profile'}</button></div>
    </div>
  );
}

function AppearancePanel({ user, onSaved }) {
  const [mode, setMode] = useState(user.theme || 'light');
  const [accent, setAccent] = useState(user.accent || ACCENTS[0].accent);
  const [skin, setSkin] = useState(user.skin || 'original');
  function applyAndSave(next) {
    const t = { mode, accent, skin, ...next };
    setMode(t.mode); setAccent(t.accent); setSkin(t.skin);
    applyTheme(t); saveLocalTheme(t);
    api('/auth/me', { method: 'PATCH', body: { theme: t.mode, accent: t.accent, skin: t.skin } }).then(({ user: u }) => onSaved(u)).catch(() => {});
  }
  const editorial = skin === 'editorial';
  return (
    <div>
      <h3 className="settings-title">Appearance</h3>
      <p className="muted settings-hint">Pick a design style, then light or dark. Your choice recolours the whole app and is saved to your account.</p>

      <label className="profile-label">Design style</label>
      <div className="skin-grid">
        <button type="button" className={`skin-card ${skin === 'original' ? 'sel' : ''}`} onClick={() => applyAndSave({ skin: 'original' })}>
          <span className="skin-preview skin-preview-original"><span className="skin-side" /><span className="skin-body"><i /><i /></span></span>
          <span className="skin-name">Original</span>
          <span className="skin-desc muted">The standard TeamHub look</span>
        </button>
        <button type="button" className={`skin-card ${skin === 'editorial' ? 'sel' : ''}`} onClick={() => applyAndSave({ skin: 'editorial' })}>
          <span className="skin-preview skin-preview-editorial"><span className="skin-side" /><span className="skin-body"><i /><i /></span></span>
          <span className="skin-name">Editorial</span>
          <span className="skin-desc muted">Warm, minimalist &amp; classy</span>
        </button>
      </div>

      <label className="profile-label">Colour mode</label>
      <div className="mode-toggle">
        {[['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '🖥 System']].map(([m, lbl]) => (
          <button key={m} type="button" className={`mode-btn ${mode === m ? 'sel' : ''}`} onClick={() => applyAndSave({ mode: m })}>{lbl}</button>
        ))}
      </div>

      <label className="profile-label">Theme colour</label>
      {editorial && <p className="muted settings-hint" style={{ marginTop: 0 }}>Editorial uses its own warm palette — switch to Original to pick a colour.</p>}
      <div className={`theme-grid ${editorial ? 'is-disabled' : ''}`}>
        {ACCENTS.map((a) => (
          <button key={a.accent} type="button" disabled={editorial} className={`theme-card ${a.accent === accent ? 'sel' : ''}`} onClick={() => applyAndSave({ accent: a.accent })}>
            <span className="theme-swatch" style={{ background: a.sidebar }}><span style={{ background: a.accent }} /></span>
            <span className="theme-name">{a.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`settings-toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="settings-toggle-main">
        <span className="settings-toggle-label">{label}</span>
        {hint && <span className="settings-toggle-hint muted">{hint}</span>}
      </span>
    </label>
  );
}

// The native Android app injects window.TeamHubNative; on the web it's absent.
const nativeBridge = () => (typeof window !== 'undefined'
  && window.TeamHubNative
  && typeof window.TeamHubNative.openChannelSettings === 'function')
  ? window.TeamHubNative : null;

function NotificationsPanel() {
  const [perm, setPerm] = useState(notificationPermission());
  const [enabled, setEnabled] = useState(desktopEnabled());
  const supported = notificationsSupported();
  const native = nativeBridge();
  // On Android 14+ full-screen call alerts need an explicit permission; when it
  // isn't granted the incoming-call screen can't wake the phone. Surface a
  // one-tap fix. `canUseFullScreenIntent` is a synchronous native bridge call.
  const [fsiOk, setFsiOk] = useState(() => {
    try { return native && typeof native.canUseFullScreenIntent === 'function' ? native.canUseFullScreenIntent() : true; }
    catch { return true; }
  });

  async function enable(on) {
    if (on && perm !== 'granted') {
      const p = await requestNotificationPermission();
      setPerm(p);
      if (p !== 'granted') { setEnabled(false); setDesktopEnabled(false); return; }
    }
    setEnabled(on); setDesktopEnabled(on);
    // Also (un)register the browser for background Web Push.
    if (on) enableWebPush().catch(() => {});
  }

  return (
    <div>
      <h3 className="settings-title">Notifications</h3>
      <p className="muted settings-hint">Alerts appear for @mentions, DMs, task assignments, task activity and reminders — as a desktop notification while the tab is backgrounded, and as a background push (Chrome/Edge/Firefox) even when TeamHub is closed.</p>
      {!supported ? (
        <p className="form-error">This browser doesn’t support desktop notifications.</p>
      ) : (
        <>
          <Toggle checked={enabled && perm === 'granted'} onChange={enable}
            label="Desktop notifications"
            hint={perm === 'denied' ? 'Blocked in your browser — allow notifications for this site, then reload.' : 'Show a desktop alert for new activity while the tab is in the background.'}
            disabled={perm === 'denied'} />
          <p className="muted settings-hint" style={{ marginTop: 14 }}>Browser permission: <strong>{perm}</strong></p>
        </>
      )}
      {native && (
        <>
          <hr className="profile-sep" />
          <div className="profile-section-title">Sounds &amp; vibration</div>
          <p className="muted settings-hint">Pick the ringtone for incoming calls and the tone for messages. This opens Android’s sound picker for each — choose any tone on your phone.</p>
          <div className="profile-photo-actions" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" onClick={() => (native.openCallSoundSettings ? native.openCallSoundSettings() : native.openChannelSettings('teamhub_calls_v2'))}>📞 Call ringtone</button>
            <button type="button" className="btn btn-sm" onClick={() => (native.openMessageSoundSettings ? native.openMessageSoundSettings() : native.openChannelSettings('teamhub_messages'))}>💬 Message tone</button>
          </div>
          <hr className="profile-sep" />
          <div className="profile-section-title">Full-screen calls</div>
          {fsiOk ? (
            <p className="muted settings-hint">Incoming calls show full-screen and wake your phone. ✅ Allowed.</p>
          ) : (
            <>
              <p className="form-error" style={{ marginBottom: 8 }}>Android is blocking full-screen call alerts, so incoming calls can’t light up your screen. Allow it so calls ring like a normal phone call.</p>
              <div className="profile-photo-actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => { try { native.openFullScreenIntentSettings(); } catch { /* ignore */ } }}>Allow full-screen calls</button>
              </div>
              <p className="muted settings-hint" style={{ marginTop: 8 }}>Turn on “Allow full-screen notifications”, then come back.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// A local-preference toggle backed by prefs.js (re-renders this panel on change).
function usePref(key) {
  const [v, setV] = useState(getPrefs()[key]);
  return [v, (nv) => { setPref(key, nv); setV(nv); }];
}

function MessagesPanel() {
  const [density, setDensity] = usePref('density');
  const [clock24, setClock24] = usePref('clock24');
  const [showTyping, setShowTyping] = usePref('showTyping');
  return (
    <div>
      <h3 className="settings-title">Messages &amp; media</h3>
      <label className="profile-label">Message density</label>
      <div className="mode-toggle" style={{ marginBottom: 16 }}>
        <button className={`mode-btn ${density === 'comfortable' ? 'sel' : ''}`} onClick={() => setDensity('comfortable')}>Comfortable</button>
        <button className={`mode-btn ${density === 'compact' ? 'sel' : ''}`} onClick={() => setDensity('compact')}>Compact</button>
      </div>
      <div className="settings-toggles">
        <Toggle checked={clock24} onChange={setClock24} label="24-hour clock" hint="Show message and task times as 14:30 instead of 2:30 PM." />
        <Toggle checked={showTyping} onChange={setShowTyping} label="Show typing indicators" hint="Display “… is typing” under a conversation." />
      </div>
    </div>
  );
}

function CalendarPanel() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    api('/calendar/url').then((d) => setUrl(d.url)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* ignore */ }
  };
  const rotate = async () => {
    if (!window.confirm('Generate a new link? Your current calendar subscription will stop updating and you’ll need to re-subscribe with the new link.')) return;
    setBusy(true);
    try { const d = await api('/calendar/rotate', { method: 'POST' }); setUrl(d.url); } catch { /* ignore */ } finally { setBusy(false); }
  };
  const googleAddUrl = url ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url)}` : '#';

  return (
    <div>
      <h3 className="settings-title">Calendar subscription</h3>
      <p className="muted settings-hint">
        Subscribe to this private link in Google Calendar, Apple Calendar or Outlook to see your assigned tasks and the compliance deadlines you own — with a reminder the day before. It refreshes automatically, so new due dates just appear.
      </p>

      {loading ? (
        <p className="muted">Loading your link…</p>
      ) : (
        <>
          <label className="profile-label">Your private calendar link</label>
          <div className="cal-url-row">
            <input className="auth-input cal-url" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="cal-btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
          </div>

          <div className="cal-actions">
            <a className="cal-btn cal-btn-primary" href={googleAddUrl} target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>
            <button className="cal-btn" onClick={rotate} disabled={busy}>{busy ? 'Working…' : 'Reset link'}</button>
          </div>

          <div className="profile-section-title" style={{ marginTop: 18 }}>How to subscribe</div>
          <ul className="cal-help">
            <li><b>Google Calendar:</b> click “Add to Google Calendar” above, or Other calendars → From URL → paste the link.</li>
            <li><b>Apple Calendar:</b> File → New Calendar Subscription → paste the link.</li>
            <li><b>Outlook:</b> Add calendar → Subscribe from web → paste the link.</li>
          </ul>
          <p className="muted settings-hint" style={{ marginTop: 10 }}>Keep this link private — anyone who has it can see your task titles and due dates. Use “Reset link” if it’s ever exposed.</p>
        </>
      )}
    </div>
  );
}

function LanguagePanel() {
  const [locale, setLocale] = usePref('locale');
  const [timezone, setTimezone] = usePref('timezone');
  const [spellcheck, setSpellcheck] = usePref('spellcheck');
  const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'device setting'; } })();
  const zones = timeZones();
  return (
    <div>
      <h3 className="settings-title">Language &amp; region</h3>
      <label className="profile-label">Language</label>
      <select className="profile-input" value={locale} onChange={(e) => { setLocale(e.target.value); notifyLangChange(); }}>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
      <p className="muted settings-hint">Translates the main interface (menus, tabs, settings) and sets date/number formatting. Deeper screens stay in English.</p>
      <label className="profile-label" style={{ marginTop: 12 }}>Time zone</label>
      <select className="profile-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
        <option value="auto">Automatic — {deviceTz}</option>
        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
      </select>
      <p className="muted settings-hint">Times across the app (including the clock) are shown in this zone.</p>
      <hr className="profile-sep" />
      <div className="settings-toggles">
        <Toggle checked={spellcheck} onChange={setSpellcheck} label="Spellcheck" hint="Check spelling as you type in the message box." />
      </div>
    </div>
  );
}

function AccessibilityPanel() {
  const [reduceMotion, setReduceMotion] = usePref('reduceMotion');
  const [underlineLinks, setUnderlineLinks] = usePref('underlineLinks');
  return (
    <div>
      <h3 className="settings-title">Accessibility</h3>
      <div className="settings-toggles">
        <Toggle checked={reduceMotion} onChange={setReduceMotion} label="Reduce motion" hint="Turn off animations and transitions across the app." />
        <Toggle checked={underlineLinks} onChange={setUnderlineLinks} label="Underline links" hint="Always underline links in messages, not just on hover." />
      </div>
    </div>
  );
}

// Opt-in location sharing. Off unless the user turns it on here; when on, the
// app shows a persistent banner (see LocationSharing) so it's never covert.
function LocationPanel() {
  const [status, setStatus] = useState({ location_sharing: false, last: null });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api('/location/me').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(enabled) {
    setBusy(true);
    try {
      await api('/location/consent', { method: 'POST', body: { enabled } });
      window.dispatchEvent(new Event('location-consent-changed'));
      load();
    } catch { /* ignore */ }
    setBusy(false);
  }

  const on = !!status.location_sharing;
  return (
    <div>
      <h3 className="settings-title">Location</h3>
      <p className="muted">
        Optionally share your live location with your workspace admins while you’re on duty — handy for field
        visits and client meetings. It’s entirely your choice, and it’s off until you turn it on.
      </p>
      <Toggle
        checked={on}
        disabled={busy}
        onChange={toggle}
        label="Share my location while on duty"
        hint={on ? 'On — your admins can see your current location.' : 'Off — nothing is shared.'}
      />
      <hr className="profile-sep" />
      <ul className="settings-points muted">
        <li>Only your <strong>latest</strong> position is stored — no history or trail is kept.</li>
        <li>Only your workspace <strong>admins</strong> can see it, and only while this is on.</li>
        <li>A banner stays on screen the whole time it’s active, so you always know.</li>
        <li>Turn it off any time — your stored location is deleted right away.</li>
      </ul>
      {on && status.last && (
        <p className="settings-toggle-hint muted">Last shared {new Date(status.last.recorded_at).toLocaleString()}.</p>
      )}
    </div>
  );
}

function AdvancedPanel() {
  const [enterToSend, setEnterToSend] = usePref('enterToSend');
  const [apkAvailable, setApkAvailable] = useState(false);
  useEffect(() => { api('/config').then((c) => setApkAvailable(!!c.android_app_available)).catch(() => {}); }, []);
  const mod = navigator.platform?.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
  return (
    <div>
      <h3 className="settings-title">Advanced</h3>
      <label className="profile-label">When writing a message, press <kbd>Enter</kbd> to…</label>
      <div className="settings-radios">
        <label className="settings-radio">
          <input type="radio" name="enter" checked={enterToSend} onChange={() => setEnterToSend(true)} />
          <span><span className="settings-toggle-label">Send the message</span><span className="settings-toggle-hint muted"><kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span></span>
        </label>
        <label className="settings-radio">
          <input type="radio" name="enter" checked={!enterToSend} onChange={() => setEnterToSend(false)} />
          <span><span className="settings-toggle-label">Start a new line</span><span className="settings-toggle-hint muted">Use <kbd>{mod}</kbd>+<kbd>Enter</kbd> to send</span></span>
        </label>
      </div>
      <hr className="profile-sep" />
      <div className="profile-section-title">Keyboard shortcuts</div>
      <ul className="settings-shortcuts">
        <li><kbd>{mod}</kbd>+<kbd>K</kbd> <span className="muted">Search messages</span></li>
        <li><kbd>{mod}</kbd>/<kbd>⌘</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>K</kbd> <span className="muted">Bold / italic / link (with text selected)</span></li>
        <li><kbd>Enter</kbd> <span className="muted">Send a message (or add a new line — see above)</span></li>
        <li><kbd>Esc</kbd> <span className="muted">Close a dialog</span></li>
      </ul>
      {apkAvailable && (
        <>
          <hr className="profile-sep" />
          <div className="profile-section-title">Mobile app</div>
          <p className="settings-toggle-hint muted">Install TeamHub on your Android phone — same sign-in, with native calls and notifications.</p>
          <a className="btn btn-primary btn-sm settings-apk-btn" href="/download/android" download>📱 Download the Android app</a>
        </>
      )}
    </div>
  );
}

function AccountPanel({ user, onLogout }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save() {
    if (next.length < 6) { setMsg({ err: true, text: 'New password must be at least 6 characters.' }); return; }
    if (next !== confirm) { setMsg({ err: true, text: 'New passwords don’t match.' }); return; }
    setSaving(true); setMsg(null);
    try {
      await api('/auth/password', { method: 'POST', body: { current_password: cur, new_password: next } });
      setCur(''); setNext(''); setConfirm(''); setMsg({ err: false, text: 'Password changed.' });
    } catch (e) { setMsg({ err: true, text: e.message }); } finally { setSaving(false); }
  }

  return (
    <div>
      <h3 className="settings-title">Account & password</h3>
      <label className="profile-label">Email</label>
      <input className="profile-input" value={user.email} disabled />
      <hr className="profile-sep" />
      <div className="profile-section-title">Change password</div>
      <label className="profile-label">Current password</label>
      <input className="profile-input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
      <label className="profile-label">New password</label>
      <input className="profile-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      <label className="profile-label">Confirm new password</label>
      <input className="profile-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      {msg && <p className={msg.err ? 'form-error' : 'form-ok'}>{msg.text}</p>}
      <div className="editor-actions"><button className="btn" disabled={saving || !cur || !next} onClick={save}>{saving ? 'Saving…' : 'Change password'}</button></div>
      <hr className="profile-sep" />
      <div className="profile-section-title">Session</div>
      <p className="muted" style={{ margin: '0 0 10px' }}>Signed in as {user.email}.</p>
      <button className="btn btn-danger" onClick={onLogout}>⏻ Sign out</button>
    </div>
  );
}
