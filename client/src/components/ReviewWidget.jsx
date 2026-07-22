import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// "For Your Review": completed tasks awaiting your rating (as assigner, as a
// chosen reporting manager, or your own self-rating). 1-5 stars + a required
// comment; a self-rating also names the reporting manager.
export default function ReviewWidget({ user, users = [] }) {
  const [items, setItems] = useState([]);
  const [rating, setRating] = useState(null); // the item being rated

  function load() {
    api('/tasks/ratings/pending').then((d) => setItems(d.ratings || [])).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  if (!items.length && !rating) return null;

  return (
    <section className="review-widget">
      <div className="review-head">
        <strong>⭐ For Your Review</strong>
        <span className="review-count">{items.length}</span>
      </div>
      <p className="muted review-sub">Completed tasks waiting for your rating.</p>
      <div className="review-list">
        {items.map((it) => (
          <button key={it.id} className="review-item" onClick={() => setRating(it)}>
            <div className="review-item-main">
              <span className="review-item-title">{it.task_title}</span>
              <span className="review-item-sub muted">
                {it.role === 'self' ? 'Rate your work + pick a manager' : `Rate ${it.ratee_name}’s work`}
              </span>
            </div>
            <span className="review-item-cta">Rate →</span>
          </button>
        ))}
      </div>

      {rating && (
        <RatingModal
          item={rating}
          user={user}
          users={users}
          onClose={() => setRating(null)}
          onDone={() => { setRating(null); load(); }}
        />
      )}
    </section>
  );
}

function RatingModal({ item, user, users, onClose, onDone }) {
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [managerId, setManagerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isSelf = item.role === 'self';
  const isAdmin = user.role === 'admin';
  const managerOptional = isSelf && isAdmin; // admins are the senior — no reviewer required
  const managers = users.filter((u) => u.id !== user.id && u.name);

  async function submit() {
    if (!stars) { setErr('Please tap a star rating.'); return; }
    if (!comment.trim()) { setErr('A short comment is required.'); return; }
    if (isSelf && !managerId && !managerOptional) { setErr('Choose a reporting manager.'); return; }
    setBusy(true); setErr('');
    try {
      await api(`/tasks/ratings/${item.id}`, {
        method: 'POST',
        body: { stars, comment: comment.trim(), manager_id: isSelf ? Number(managerId) : undefined },
      });
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rating-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><strong>Rate task</strong><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="rating-body">
          <div className="rating-task">{item.task_title}</div>
          <div className="muted rating-who">
            {isSelf ? 'Self-appraisal — then choose who reviews it' : `Work done by ${item.ratee_name}`}
          </div>

          <div className="rating-stars" role="radiogroup" aria-label="Star rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`star ${(hover || stars) >= n ? 'on' : ''}`}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(0)}
                onClick={() => setStars(n)}
                aria-label={`${n} star${n > 1 ? 's' : ''}`}
              >★</button>
            ))}
            {!!stars && <span className="rating-stars-val">{stars}/5</span>}
          </div>

          <label className="profile-label">Comment <span className="muted">(required)</span></label>
          <textarea
            className="rating-comment"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={isSelf ? 'How did it go? Notes for your reviewer…' : 'Feedback on the work…'}
          />

          {isSelf && (
            <>
              <label className="profile-label">Reporting manager {managerOptional && <span className="muted">(optional)</span>}</label>
              <select className="profile-input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">{managerOptional ? 'No reviewer — finalise my rating' : 'Select a teammate…'}</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <p className="muted rating-hint">
                {managerOptional
                  ? 'As an admin you can finalise your own rating, or pick someone to review it.'
                  : 'They’ll be notified to review and rate this task.'}
              </p>
            </>
          )}

          {err && <p className="form-error">{err}</p>}
        </div>
        <div className="editor-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : (isSelf && managerId ? 'Submit & notify manager' : 'Submit rating')}
          </button>
        </div>
      </div>
    </div>
  );
}
