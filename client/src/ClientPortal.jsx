import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Client Portal — a separate, tightly-scoped app your clients sign into. It
// shares the bundle with the staff app but runs entirely on its own portal
// session token, calling only /api/portal/* (each scoped to one client).

const PKEY = 'teamhub_portal';
const getPToken = () => localStorage.getItem(PKEY);
const setPToken = (t) => localStorage.setItem(PKEY, t);
const clearPToken = () => localStorage.removeItem(PKEY);

async function papi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/portal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getPToken() || ''}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
  return data;
}

const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (s) => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); };

export default function ClientPortal() {
  const [user, setUser] = useState(null);
  const [firm, setFirm] = useState('Client Portal');
  const [booting, setBooting] = useState(true);

  // Consume a magic-link token if we arrived via one, else validate the session.
  useEffect(() => {
    const url = new URL(window.location.href);
    const magic = url.searchParams.get('token');
    (async () => {
      try {
        if (magic) {
          const r = await papi('/login', { method: 'POST', body: { token: magic } });
          setPToken(r.token); setUser(r.user); if (r.firm) setFirm(r.firm);
          url.searchParams.delete('token');
          window.history.replaceState({}, '', url.pathname);
        } else if (getPToken()) {
          const r = await papi('/me');
          setUser(r.user); if (r.firm) setFirm(r.firm);
        }
      } catch { clearPToken(); }
      finally { setBooting(false); }
    })();
  }, []);

  function signOut() { clearPToken(); setUser(null); }

  if (booting) return <div className="pt-boot">Loading your portal…</div>;
  if (!user) return <PortalLogin />;
  return <PortalHome user={user} firm={firm} onSignOut={signOut} />;
}

function PortalLogin() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [firm, setFirm] = useState('Client Portal');
  useEffect(() => { papi('/branding').then((b) => b.firm && setFirm(b.firm)).catch(() => {}); }, []);

  async function submit(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setErr('');
    try { await papi('/request-link', { method: 'POST', body: { email: email.trim() } }); setSent(true); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="pt-auth">
      <form className="pt-auth-card" onSubmit={submit}>
        <div className="pt-logo">{(firm[0] || 'K').toUpperCase()}</div>
        <div className="pt-eyebrow">{firm}</div>
        <h1>Client Portal</h1>
        {sent ? (
          <>
            <p className="pt-muted">If <strong>{email}</strong> is registered, a secure sign-in link is on its way. Check your inbox — the link is valid for 45 minutes.</p>
            <button type="button" className="pt-btn pt-ghost" onClick={() => setSent(false)}>Use a different email</button>
          </>
        ) : (
          <>
            <p className="pt-muted">Secure access to your filings &amp; documents.</p>
            <label className="pt-field">Work email
              <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
            </label>
            {err && <div className="pt-err">{err}</div>}
            <button className="pt-btn" disabled={busy}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
            <p className="pt-fine">No password needed. We'll email you a one-time link.</p>
          </>
        )}
      </form>
      <p className="pt-foot">Powered by TeamHub</p>
    </div>
  );
}

const NAV = [['overview', 'Overview'], ['documents', 'Documents'], ['requests', 'Requests'], ['filings', 'Filings'], ['messages', 'Messages']];
const fmtDue = (d) => (d ? fmtDate(d) : 'No date');
const CH = { filed: 'pt-c-good', due: 'pt-c-warn', overdue: 'pt-c-bad', received: 'pt-c-good', pending: 'pt-c-bad', done: 'pt-c-good' };

function PortalHome({ user, firm, onSignOut }) {
  const [view, setView] = useState('overview');
  const [docs, setDocs] = useState(null);
  const [requests, setRequests] = useState(null);
  const [filings, setFilings] = useState(null);
  const [messages, setMessages] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDocs = useCallback(() => papi('/documents').then((d) => setDocs(d.documents)).catch((e) => setErr(e.message)), []);
  const loadReq = useCallback(() => papi('/requests').then((d) => setRequests(d.requests)).catch(() => setRequests([])), []);
  const loadFil = useCallback(() => papi('/filings').then((d) => setFilings(d.filings)).catch(() => setFilings([])), []);
  const loadMsg = useCallback(() => papi('/messages').then((d) => setMessages(d.messages)).catch(() => setMessages([])), []);
  useEffect(() => { loadDocs(); loadReq(); loadFil(); loadMsg(); }, [loadDocs, loadReq, loadFil, loadMsg]);

  // Live updates over a dedicated portal socket. The server authenticates the
  // portal session token and joins this connection to its client's room, then
  // pushes a `portal:changed` whenever the firm (or a co-contact) touches this
  // client — a new message, document request, shared file or filing. We refresh
  // on that event, on (re)connect (to close any gap while disconnected), and on
  // tab focus as a belt-and-braces fallback. No polling.
  useEffect(() => {
    const refresh = () => { loadDocs(); loadReq(); loadFil(); loadMsg(); };
    const socket = io('/', { auth: { token: getPToken() } });
    socket.on('connect', refresh);
    socket.on('portal:changed', refresh);
    const onFocus = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      socket.off('connect', refresh);
      socket.off('portal:changed', refresh);
      socket.disconnect();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadDocs, loadReq, loadFil, loadMsg]);

  // Upload files, optionally answering a specific request. Updates both lists.
  async function upload(files, requestId) {
    if (!files.length) return;
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      if (requestId) fd.append('request_id', String(requestId));
      const res = await fetch('/api/portal/documents', { method: 'POST', headers: { Authorization: `Bearer ${getPToken()}` }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setDocs(data.documents);
      if (data.requests) setRequests(data.requests);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  function download(d) { window.open(`/api/portal/documents/${d.id}/download?token=${encodeURIComponent(getPToken())}`, '_blank'); }

  const openReqs = (requests || []).filter((r) => r.status !== 'done');
  const nextFiling = (filings || []).filter((f) => f.status !== 'filed' && f.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];

  return (
    <div className="pt-app">
      <header className="pt-top">
        <div className="pt-top-brand"><span className="pt-logo sm">K</span><span className="pt-top-name">{user.client}</span></div>
        <div className="pt-top-right">
          <span className="pt-who">{user.name}</span>
          <button className="pt-btn pt-ghost pt-sm" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <nav className="pt-nav">
        {NAV.map(([k, label]) => (
          <button key={k} className={`pt-navb ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>
            {label}{k === 'requests' && openReqs.length > 0 && <span className="pt-navbadge">{openReqs.length}</span>}
          </button>
        ))}
      </nav>

      <main className="pt-main">
        {err && <div className="pt-err">{err}</div>}

        {view === 'overview' && (
          <>
            <div className="pt-head"><div className="pt-eyebrow">Client portal</div><h1>Welcome, {user.name}</h1></div>
            {openReqs.length > 0 && (
              <div className="pt-banner">
                <span className="pt-banner-ic">!</span>
                <div><strong>{openReqs.length} document{openReqs.length === 1 ? '' : 's'} needed.</strong> Your accountant has requested files to progress your filings.</div>
                <button className="pt-mini" onClick={() => setView('requests')}>View</button>
              </div>
            )}
            <div className="pt-kpis">
              <div className="pt-kpi"><div className={`pt-kpi-num ${openReqs.length ? 'warn' : ''}`}>{requests ? openReqs.length : '—'}</div><div className="pt-kpi-cap">Open requests</div></div>
              <div className="pt-kpi"><div className="pt-kpi-num">{nextFiling ? fmtDate(nextFiling.due_date) : '—'}</div><div className="pt-kpi-cap">{nextFiling ? `Next · ${nextFiling.title}` : 'No filing due'}</div></div>
              <div className="pt-kpi"><div className="pt-kpi-num">{docs ? docs.length : '—'}</div><div className="pt-kpi-cap">Documents</div></div>
            </div>
            {openReqs.length > 0 && (
              <section className="pt-block">
                <div className="pt-block-h"><span>Requests from your accountant</span><span>{openReqs.length} open</span></div>
                {openReqs.slice(0, 4).map((r) => (
                  <div key={r.id} className="pt-row">
                    <span className="pt-file">▤</span>
                    <div className="pt-row-main"><div className="pt-row-name">{r.title}</div><div className="pt-row-sub">Due {fmtDue(r.due_date)}</div></div>
                    <button className="pt-mini" onClick={() => setView('requests')}>Upload</button>
                  </div>
                ))}
              </section>
            )}
            <section className="pt-block">
              <div className="pt-block-h"><span>Your filings</span><span>{(filings || []).length} total</span></div>
              {(filings || []).slice(0, 5).map((f) => (
                <div key={f.id} className="pt-row">
                  <div className="pt-row-main"><div className="pt-row-name">{f.title}</div><div className="pt-row-sub">{f.status === 'filed' ? `Filed ${f.filed_on ? fmtDate(f.filed_on) : ''}` : `Due ${fmtDue(f.due_date)}`}</div></div>
                  <span className={`pt-chip ${CH[f.status]}`}>{f.status}</span>
                </div>
              ))}
              {filings && filings.length === 0 && <div className="pt-empty">No filings on record yet.</div>}
            </section>
          </>
        )}

        {view === 'documents' && (
          <DocumentsView docs={docs} busy={busy} onUpload={(f) => upload(f)} onDownload={download} />
        )}

        {view === 'requests' && (
          <RequestsView requests={requests} busy={busy} onUpload={(f, rid) => upload(f, rid)} />
        )}

        {view === 'filings' && (
          <FilingsView filings={filings} />
        )}

        {view === 'messages' && (
          <MessagesView messages={messages} firm={firm} onSend={async (body) => {
            const d = await papi('/messages', { method: 'POST', body: { body } });
            setMessages(d.messages);
          }} />
        )}
      </main>
      <footer className="pt-appfoot">Secure client portal · {firm}</footer>
    </div>
  );
}

function MessagesView({ messages, firm, onSend }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const seen = useRef(0);
  // Only jump to the newest message when the count actually grows — polling
  // hands us a fresh array every 12s, and scrolling on each poll would yank
  // the reader away from whatever they're looking at.
  useEffect(() => {
    const n = messages?.length || 0;
    if (n > seen.current) endRef.current?.scrollIntoView({ block: 'end' });
    seen.current = n;
  }, [messages]);
  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try { await onSend(body); setText(''); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="pt-head"><div className="pt-eyebrow">Client portal</div><h1>Messages</h1>
        <p className="pt-muted">A direct line to your accountant at {firm}.</p></div>
      <div className="pt-thread">
        {messages == null ? <div className="pt-muted">Loading…</div>
          : messages.length === 0 ? <div className="pt-empty">No messages yet. Say hello 👋</div>
          : messages.map((m) => (
            <div key={m.id} className={`pt-msg ${m.sender === 'client' ? 'mine' : 'firm'}`}>
              <div className="pt-msg-bubble">{m.body}</div>
              <div className="pt-msg-meta">{m.sender === 'client' ? 'You' : (m.author_name || firm)} · {fmtDate(m.created_at)}</div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <form className="pt-composer" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" />
        <button className="pt-btn pt-sm" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
    </>
  );
}

function DocumentsView({ docs, busy, onUpload, onDownload }) {
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const fromFirm = (docs || []).filter((d) => d.source === 'firm');
  const fromYou = (docs || []).filter((d) => d.source === 'you');
  return (
    <>
      <div className="pt-head"><div className="pt-eyebrow">Client portal</div><h1>Documents</h1>
        <p className="pt-muted">Download what we've shared, and upload anything we've asked for.</p></div>
      <div className={`pt-drop ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onUpload(Array.from(e.dataTransfer.files || [])); }}
        onClick={() => fileRef.current?.click()}>
        <div className="pt-drop-big">{busy ? 'Uploading…' : '⬆ Drag files here or click to upload'}</div>
        <div className="pt-muted pt-fine">PDF, images, Excel — up to 25 MB each</div>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; onUpload(f); }} />
      </div>
      {docs == null ? <div className="pt-muted">Loading…</div> : (
        <>
          <DocGroup title="Shared with you" empty="Nothing shared yet." docs={fromFirm} onDownload={onDownload} />
          <DocGroup title="Your uploads" empty="You haven't uploaded anything yet." docs={fromYou} onDownload={onDownload} />
        </>
      )}
    </>
  );
}

function RequestsView({ requests, busy, onUpload }) {
  const fileRefs = useRef({});
  if (requests == null) return <div className="pt-muted">Loading…</div>;
  const open = requests.filter((r) => r.status !== 'done');
  const done = requests.filter((r) => r.status === 'done');
  return (
    <>
      <div className="pt-head"><div className="pt-eyebrow">Client portal</div><h1>Document requests</h1>
        <p className="pt-muted">Everything your accountant needs from you, in one checklist.</p></div>
      {requests.length === 0 && <div className="pt-block"><div className="pt-empty">Nothing requested right now — you're all caught up. 🎉</div></div>}
      {open.length > 0 && (
        <section className="pt-block">
          <div className="pt-block-h"><span>Open</span><span>{open.length}</span></div>
          {open.map((r) => (
            <div key={r.id} className="pt-row">
              <span className="pt-file">▤</span>
              <div className="pt-row-main"><div className="pt-row-name">{r.title}</div>
                <div className="pt-row-sub">Due {fmtDue(r.due_date)}{r.note ? ` · ${r.note}` : ''}</div></div>
              {r.status === 'received'
                ? <span className="pt-chip pt-c-good">received</span>
                : <>
                    <button className="pt-mini" disabled={busy} onClick={() => fileRefs.current[r.id]?.click()}>Upload</button>
                    <input ref={(el) => { fileRefs.current[r.id] = el; }} type="file" multiple hidden
                      onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; onUpload(f, r.id); }} />
                  </>}
            </div>
          ))}
        </section>
      )}
      {done.length > 0 && (
        <section className="pt-block">
          <div className="pt-block-h"><span>Completed</span><span>{done.length}</span></div>
          {done.map((r) => (
            <div key={r.id} className="pt-row">
              <span className="pt-file">📄</span>
              <div className="pt-row-main"><div className="pt-row-name">{r.title}</div></div>
              <span className="pt-chip pt-c-good">done</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function FilingsView({ filings }) {
  if (filings == null) return <div className="pt-muted">Loading…</div>;
  return (
    <>
      <div className="pt-head"><div className="pt-eyebrow">Client portal</div><h1>Filing status</h1>
        <p className="pt-muted">Where each of your statutory filings stands.</p></div>
      <section className="pt-block">
        <div className="pt-block-h"><span>Statutory filings</span><span>{filings.length}</span></div>
        {filings.length === 0 && <div className="pt-empty">No filings on record yet.</div>}
        {filings.map((f) => (
          <div key={f.id} className="pt-row">
            <div className="pt-row-main"><div className="pt-row-name">{f.title}</div>
              <div className="pt-row-sub">{f.status === 'filed' ? `Filed ${f.filed_on ? fmtDate(f.filed_on) : ''}` : `Due ${fmtDue(f.due_date)}`}</div></div>
            <span className={`pt-chip ${CH[f.status]}`}>{f.status}</span>
          </div>
        ))}
      </section>
    </>
  );
}

function DocGroup({ title, docs, empty, onDownload }) {
  return (
    <section className="pt-block">
      <div className="pt-block-h"><span>{title}</span><span>{docs.length} file{docs.length === 1 ? '' : 's'}</span></div>
      {docs.length === 0 && <div className="pt-empty">{empty}</div>}
      {docs.map((d) => (
        <div key={d.id} className="pt-row">
          <span className="pt-file">📄</span>
          <div className="pt-row-main">
            <div className="pt-row-name">{d.original_name}</div>
            <div className="pt-row-sub">{fmtBytes(d.size)}{d.created_at ? ` · ${fmtDate(d.created_at)}` : ''}</div>
          </div>
          <button className="pt-mini" onClick={() => onDownload(d)}>Download</button>
        </div>
      ))}
    </section>
  );
}
