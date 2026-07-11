import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { ACCENTS, applyTheme, saveLocalTheme } from '../theme.js';
import { notificationsSupported, notificationPermission, requestNotificationPermission, desktopEnabled, setDesktopEnabled } from '../desktopNotify.js';

const SECTIONS = [
  { key: 'profile', label: 'Profile', icon: '👤' },
  { key: 'appearance', label: 'Appearance', icon: '🎨' },
  { key: 'notifications', label: 'Notifications', icon: '🔔' },
  { key: 'account', label: 'Account & password', icon: '🔒' },
];

// A Slack-style Preferences hub: a left rail of categories and a panel per
// category. Extensible — add an entry to SECTIONS and a case below.
export default function SettingsModal({ user, colors = [], initialSection = 'profile', onClose, onSaved }) {
  const [section, setSection] = useState(SECTIONS.some((s) => s.key === initialSection) ? initialSection : 'profile');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Settings</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button key={s.key} className={`settings-nav-item ${section === s.key ? 'active' : ''}`} onClick={() => setSection(s.key)}>
                <span className="settings-nav-icon">{s.icon}</span> {s.label}
              </button>
            ))}
          </nav>
          <div className="settings-panel">
            {section === 'profile' && <ProfilePanel user={user} colors={colors} onSaved={onSaved} />}
            {section === 'appearance' && <AppearancePanel user={user} onSaved={onSaved} />}
            {section === 'notifications' && <NotificationsPanel />}
            {section === 'account' && <AccountPanel user={user} />}
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
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
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

  return (
    <div>
      <h3 className="settings-title">Profile</h3>
      <div className="profile-head">
        <Avatar user={{ name: name || user.name, avatar_color: color }} size={56} />
        <div className="profile-head-meta">
          <div className="profile-head-name">{name || user.name}</div>
          <div className="muted">{user.email}{user.role === 'admin' ? ' · Admin' : ''}</div>
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
  function applyAndSave(nextMode, nextAccent) {
    setMode(nextMode); setAccent(nextAccent);
    const t = { mode: nextMode, accent: nextAccent };
    applyTheme(t); saveLocalTheme(t);
    api('/auth/me', { method: 'PATCH', body: { theme: nextMode, accent: nextAccent } }).then(({ user: u }) => onSaved(u)).catch(() => {});
  }
  return (
    <div>
      <h3 className="settings-title">Appearance</h3>
      <p className="muted settings-hint">Choose light or dark, then a colour that recolours the whole app — sidebar, buttons and highlights. Saved to your account.</p>
      <label className="profile-label">Colour mode</label>
      <div className="mode-toggle">
        {[['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '🖥 System']].map(([m, lbl]) => (
          <button key={m} type="button" className={`mode-btn ${mode === m ? 'sel' : ''}`} onClick={() => applyAndSave(m, accent)}>{lbl}</button>
        ))}
      </div>
      <label className="profile-label">Theme colour</label>
      <div className="theme-grid">
        {ACCENTS.map((a) => (
          <button key={a.accent} type="button" className={`theme-card ${a.accent === accent ? 'sel' : ''}`} onClick={() => applyAndSave(mode, a.accent)}>
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

function NotificationsPanel() {
  const [perm, setPerm] = useState(notificationPermission());
  const [enabled, setEnabled] = useState(desktopEnabled());
  const supported = notificationsSupported();

  async function enable(on) {
    if (on && perm !== 'granted') {
      const p = await requestNotificationPermission();
      setPerm(p);
      if (p !== 'granted') { setEnabled(false); setDesktopEnabled(false); return; }
    }
    setEnabled(on); setDesktopEnabled(on);
  }

  return (
    <div>
      <h3 className="settings-title">Notifications</h3>
      <p className="muted settings-hint">Desktop alerts appear when TeamHub is in the background — for @mentions, DMs, task assignments, task activity and reminders.</p>
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
    </div>
  );
}

function AccountPanel({ user }) {
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
    </div>
  );
}
