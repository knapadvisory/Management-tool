import React, { useCallback, useEffect, useRef, useState } from 'react';

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
  const [session, setSession] = useState(getPToken() ? {} : null); // {} = have token, loading me
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  // Consume a magic-link token if we arrived via one, else validate the session.
  useEffect(() => {
    const url = new URL(window.location.href);
    const magic = url.searchParams.get('token');
    (async () => {
      try {
        if (magic) {
          const r = await papi('/login', { method: 'POST', body: { token: magic } });
          setPToken(r.token); setUser(r.user); setSession({});
          url.searchParams.delete('token');
          window.history.replaceState({}, '', url.pathname);
        } else if (getPToken()) {
          const r = await papi('/me');
          setUser(r.user); setSession({});
        }
      } catch {
        clearPToken(); setSession(null);
      } finally { setBooting(false); }
    })();
  }, []);

  function signOut() { clearPToken(); setUser(null); setSession(null); }

  if (booting) return <div className="pt-boot">Loading your portal…</div>;
  if (!user) return <PortalLogin onedIn={(tok, u) => { setPToken(tok); setUser(u); setSession({}); }} />;
  return <PortalHome user={user} onSignOut={signOut} />;
}

function PortalLogin({ onedIn }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

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
        <div className="pt-logo">K</div>
        <div className="pt-eyebrow">KNAP Advisory</div>
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

function PortalHome({ user, onSignOut }) {
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(() => { papi('/documents').then((d) => setDocs(d.documents)).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);

  async function upload(files) {
    if (!files.length) return;
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const res = await fetch('/api/portal/documents', { method: 'POST', headers: { Authorization: `Bearer ${getPToken()}` }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setDocs(data.documents);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  function download(d) {
    window.open(`/api/portal/documents/${d.id}/download?token=${encodeURIComponent(getPToken())}`, '_blank');
  }

  const fromFirm = (docs || []).filter((d) => d.source === 'firm');
  const fromYou = (docs || []).filter((d) => d.source === 'you');

  return (
    <div className="pt-app">
      <header className="pt-top">
        <div className="pt-top-brand"><span className="pt-logo sm">K</span><span className="pt-top-name">{user.client}</span></div>
        <div className="pt-top-right">
          <span className="pt-who">{user.name}</span>
          <button className="pt-btn pt-ghost pt-sm" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <main className="pt-main">
        <div className="pt-head">
          <div className="pt-eyebrow">Client portal</div>
          <h1>Documents</h1>
          <p className="pt-muted">Download what {`we've`} shared, and upload anything we've asked for. Files are stored securely with your engagement.</p>
        </div>

        {err && <div className="pt-err">{err}</div>}

        <div
          className={`pt-drop ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(Array.from(e.dataTransfer.files || [])); }}
          onClick={() => fileRef.current?.click()}
        >
          <div className="pt-drop-big">{busy ? 'Uploading…' : '⬆ Drag files here or click to upload'}</div>
          <div className="pt-muted pt-fine">PDF, images, Excel — up to 25 MB each</div>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; upload(f); }} />
        </div>

        {docs == null ? <div className="pt-muted">Loading…</div> : (
          <>
            <DocGroup title="Shared with you" empty="Nothing shared yet." docs={fromFirm} onDownload={download} />
            <DocGroup title="Your uploads" empty="You haven't uploaded anything yet." docs={fromYou} onDownload={download} />
          </>
        )}
      </main>
      <footer className="pt-appfoot">Secure client portal · Powered by TeamHub</footer>
    </div>
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
