import React, { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { ACCENTS, applyTheme, saveLocalTheme } from '../theme.js';

// Self-service profile: a user edits their own name, title and avatar colour,
// and changes their own password (no admin needed).
export default function ProfileModal({ user, colors = [], onClose, onSaved }) {
  const [name, setName] = useState(user.name || '');
  const [title, setTitle] = useState(user.title || '');
  const [color, setColor] = useState(user.avatar_color);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState(null);

  const [mode, setMode] = useState(user.theme || 'light');
  const [accent, setAccent] = useState(user.accent || ACCENTS[0].accent);

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);

  const palette = colors.length ? colors : [user.avatar_color];
  const dirty = name.trim() !== (user.name || '') || (title.trim() || '') !== (user.title || '') || color !== user.avatar_color;

  async function saveProfile() {
    if (!name.trim()) { setProfileMsg({ err: true, text: 'Name is required.' }); return; }
    setSavingProfile(true); setProfileMsg(null);
    try {
      const { user: updated } = await api('/auth/me', { method: 'PATCH', body: { name: name.trim(), title: title.trim(), avatar_color: color } });
      onSaved(updated);
      setProfileMsg({ err: false, text: 'Profile saved.' });
    } catch (e) { setProfileMsg({ err: true, text: e.message }); }
    finally { setSavingProfile(false); }
  }

  // Appearance changes apply instantly (live preview) and save right away.
  function applyAndSave(nextMode, nextAccent) {
    setMode(nextMode); setAccent(nextAccent);
    const t = { mode: nextMode, accent: nextAccent };
    applyTheme(t); saveLocalTheme(t);
    api('/auth/me', { method: 'PATCH', body: { theme: nextMode, accent: nextAccent } })
      .then(({ user: u }) => onSaved(u)).catch(() => {});
  }

  async function savePassword() {
    if (next.length < 6) { setPwMsg({ err: true, text: 'New password must be at least 6 characters.' }); return; }
    if (next !== confirm) { setPwMsg({ err: true, text: 'New passwords don’t match.' }); return; }
    setSavingPw(true); setPwMsg(null);
    try {
      await api('/auth/password', { method: 'POST', body: { current_password: cur, new_password: next } });
      setCur(''); setNext(''); setConfirm('');
      setPwMsg({ err: false, text: 'Password changed.' });
    } catch (e) { setPwMsg({ err: true, text: e.message }); }
    finally { setSavingPw(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Your profile</strong><button className="icon-btn" onClick={onClose}>✕</button></div>

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
            <button key={c} type="button" className={`profile-swatch ${c === color ? 'sel' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c}>
              {c === color ? '✓' : ''}
            </button>
          ))}
        </div>

        {profileMsg && <p className={profileMsg.err ? 'form-error' : 'form-ok'}>{profileMsg.text}</p>}
        <div className="editor-actions">
          <button className="btn btn-primary" disabled={savingProfile || !dirty} onClick={saveProfile}>{savingProfile ? 'Saving…' : 'Save profile'}</button>
        </div>

        <hr className="profile-sep" />

        <div className="profile-section-title">Appearance</div>
        <label className="profile-label">Mode</label>
        <div className="mode-toggle">
          {[['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '🖥 System']].map(([m, lbl]) => (
            <button key={m} type="button" className={`mode-btn ${mode === m ? 'sel' : ''}`} onClick={() => applyAndSave(m, accent)}>{lbl}</button>
          ))}
        </div>
        <label className="profile-label">Accent colour</label>
        <div className="profile-swatches">
          {ACCENTS.map((a) => (
            <button key={a.accent} type="button" className={`profile-swatch ${a.accent === accent ? 'sel' : ''}`} style={{ background: a.accent }} onClick={() => applyAndSave(mode, a.accent)} title={a.name}>
              {a.accent === accent ? '✓' : ''}
            </button>
          ))}
        </div>

        <hr className="profile-sep" />

        <div className="profile-section-title">Change password</div>
        <label className="profile-label">Current password</label>
        <input className="profile-input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        <label className="profile-label">New password</label>
        <input className="profile-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <label className="profile-label">Confirm new password</label>
        <input className="profile-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />

        {pwMsg && <p className={pwMsg.err ? 'form-error' : 'form-ok'}>{pwMsg.text}</p>}
        <div className="editor-actions">
          <button className="btn" disabled={savingPw || !cur || !next} onClick={savePassword}>{savingPw ? 'Saving…' : 'Change password'}</button>
        </div>
      </div>
    </div>
  );
}
