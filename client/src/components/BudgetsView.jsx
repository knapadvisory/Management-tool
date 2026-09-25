import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Indian-grouped money, compact for big numbers (₹4.5L, ₹1.2Cr).
export function money(n, currency = 'INR') {
  const sym = currency === 'INR' ? '₹' : '';
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  const g = abs.toLocaleString('en-IN');
  return `${v < 0 ? '-' : ''}${sym}${g}`;
}
const pct = (n) => `${Math.round(Number(n) || 0)}%`;

export default function BudgetsView({ user }) {
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState('');
  const [budgets, setBudgets] = useState([]);
  const [budgetId, setBudgetId] = useState(null);
  const [report, setReport] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editMonth, setEditMonth] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { api('/clients').then((d) => setClients(d.clients || d || [])).catch(() => setClients([])); }, []);

  const loadBudgets = useCallback((cid) => {
    const q = cid ? `?client_id=${cid}` : '';
    api(`/budgets${q}`).then((d) => setBudgets(d.budgets || [])).catch(() => setBudgets([]));
  }, []);
  useEffect(() => { loadBudgets(clientId); }, [clientId, loadBudgets]);

  const loadReport = useCallback((id) => {
    if (!id) { setReport(null); return; }
    api(`/budgets/${id}`).then((r) => { setReport(r); setEditMonth((m) => m || r.period?.[0]?.key || ''); }).catch(() => setReport(null));
  }, []);
  useEffect(() => { loadReport(budgetId); }, [budgetId, loadReport]);

  // Keep a selected budget once the list loads.
  useEffect(() => { if (budgets.length && !budgets.some((b) => b.id === budgetId)) setBudgetId(budgets[0].id); if (!budgets.length) setBudgetId(null); }, [budgets, budgetId]);

  async function setCell(lineId, month, field, value) {
    try { const r = await api(`/budgets/${budgetId}/cell`, { method: 'PUT', body: { line_id: lineId, month, [field]: value === '' ? 0 : Number(value) } }); setReport(r); }
    catch (e) { setErr(e.message); }
  }
  async function addLine(section) {
    const category = window.prompt('New line item (category):', ''); if (!category?.trim()) return;
    try { const r = await api(`/budgets/${budgetId}/lines`, { method: 'POST', body: { category: category.trim(), section, kind: /capex/i.test(section) ? 'capex' : 'expense' } }); setReport(r); }
    catch (e) { setErr(e.message); }
  }
  async function delLine(lineId) {
    if (!window.confirm('Remove this line item?')) return;
    const r = await api(`/budgets/lines/${lineId}`, { method: 'DELETE' }); setReport(r);
  }
  async function seedDemo() {
    if (!window.confirm('Replace this budget with the manufacturing demo dataset?')) return;
    const r = await api(`/budgets/${budgetId}/seed-demo`, { method: 'POST' }); setReport(r);
  }
  async function delBudget() {
    if (!window.confirm('Delete this whole budget?')) return;
    await api(`/budgets/${budgetId}`, { method: 'DELETE' }); setBudgetId(null); loadBudgets(clientId);
  }

  const cur = report?.budget?.currency || 'INR';
  const t = report?.totals;

  return (
    <div className="budget-view">
      <div className="budget-head">
        <div>
          <h2>Budgets & Actuals</h2>
          <p className="muted">Plan the spend for a client's build, track actuals against it, and share the report to their portal.</p>
        </div>
        <div className="budget-head-controls">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={budgetId || ''} onChange={(e) => setBudgetId(Number(e.target.value) || null)}>
            <option value="">{budgets.length ? 'Select a budget' : 'No budgets yet'}</option>
            {budgets.map((b) => <option key={b.id} value={b.id}>{b.name}{b.client ? ` · ${b.client.name}` : ''}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>＋ New budget</button>
        </div>
      </div>

      {err && <div className="form-error" onClick={() => setErr('')}>{err}</div>}

      {!report && <div className="empty-hint" style={{ padding: 32 }}>Pick a budget above, or create one. A new budget can be pre-filled with a manufacturing product-development demo dataset.</div>}

      {report && t && (
        <>
          <div className="budget-toolbar">
            <div className="budget-title">
              <strong>{report.budget.name}</strong>
              {report.budget.client && <span className="muted"> · {report.budget.client.name}</span>}
            </div>
            <div className="budget-actions">
              <label className="muted">Editing month
                <select value={editMonth} onChange={(e) => setEditMonth(e.target.value)}>
                  {report.period.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </label>
              <button className="btn btn-sm" onClick={seedDemo}>Load demo data</button>
              {user.role === 'admin' && <button className="btn btn-sm btn-danger" onClick={delBudget}>Delete</button>}
            </div>
          </div>

          <BudgetKpis t={t} cur={cur} />
          <MonthlyTrend monthly={t.monthly} cur={cur} />

          <div className="budget-grid-wrap">
            <table className="budget-grid">
              <thead>
                <tr>
                  <th className="bg-cat">Line item</th>
                  <th>Budget <span className="muted">({report.period.find((p) => p.key === editMonth)?.label})</span></th>
                  <th>Actual <span className="muted">({report.period.find((p) => p.key === editMonth)?.label})</span></th>
                  <th>YTD budget</th>
                  <th>YTD actual</th>
                  <th>Variance</th>
                  <th>Used</th>
                  <th />
                </tr>
              </thead>
              {report.sections.map((sec) => (
                <tbody key={sec.name}>
                  <tr className="bg-section">
                    <td colSpan={7}>{sec.name}</td>
                    <td className="bg-addcell"><button className="icon-btn" title="Add line to this section" onClick={() => addLine(sec.name)}>＋</button></td>
                  </tr>
                  {sec.lines.map((l) => {
                    const cell = l.months.find((m) => m.month === editMonth) || { budget: 0, actual: 0 };
                    const used = l.total_budget ? (l.total_actual / l.total_budget) * 100 : 0;
                    const over = l.kind !== 'revenue' && l.total_actual > l.total_budget;
                    return (
                      <tr key={l.id}>
                        <td className="bg-cat">{l.category}{l.kind === 'capex' && <span className="bg-tag">capex</span>}{l.kind === 'revenue' && <span className="bg-tag rev">income</span>}</td>
                        <td><input className="bg-input" type="number" min="0" defaultValue={cell.budget || ''} key={`b-${l.id}-${editMonth}-${cell.budget}`}
                          onBlur={(e) => setCell(l.id, editMonth, 'budget', e.target.value)} /></td>
                        <td><input className="bg-input" type="number" min="0" defaultValue={cell.actual || ''} key={`a-${l.id}-${editMonth}-${cell.actual}`}
                          onBlur={(e) => setCell(l.id, editMonth, 'actual', e.target.value)} /></td>
                        <td className="bg-num">{money(l.total_budget, cur)}</td>
                        <td className="bg-num">{money(l.total_actual, cur)}</td>
                        <td className={`bg-num ${over ? 'bg-over' : 'bg-under'}`}>{money(l.variance, cur)}</td>
                        <td className="bg-num">{pct(used)}</td>
                        <td><button className="icon-btn" title="Remove line" onClick={() => delLine(l.id)}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </>
      )}

      {creating && <NewBudgetModal clients={clients} defaultClientId={clientId} onClose={() => setCreating(false)}
        onCreated={(rep) => { setCreating(false); setClientId(String(rep.budget.client?.id || '')); loadBudgets(rep.budget.client?.id || ''); setBudgetId(rep.budget.id); setReport(rep); }} />}
    </div>
  );
}

function BudgetKpis({ t, cur }) {
  const overspend = t.actual > t.budget;
  return (
    <div className="budget-kpis">
      <Kpi label="Total budget" value={money(t.budget, cur)} />
      <Kpi label="Actual spent" value={money(t.actual, cur)} tone={overspend ? 'bad' : 'ok'} />
      <Kpi label="Variance" value={money(t.variance, cur)} tone={t.variance < 0 ? 'bad' : 'ok'} hint={t.variance < 0 ? 'over budget' : 'under budget'} />
      <Kpi label="Budget used" value={pct(t.pct_spent)} tone={t.pct_spent > 100 ? 'bad' : 'ok'} />
      <Kpi label="Net cash burn (actual)" value={money(t.net_burn_actual, cur)} hint="spend − income" />
    </div>
  );
}
function Kpi({ label, value, tone, hint }) {
  return (
    <div className={`budget-kpi ${tone || ''}`}>
      <div className="budget-kpi-val">{value}</div>
      <div className="budget-kpi-lbl">{label}</div>
      {hint && <div className="budget-kpi-hint">{hint}</div>}
    </div>
  );
}

// Budget vs actual per month, as paired bars.
export function MonthlyTrend({ monthly, cur }) {
  const max = Math.max(1, ...monthly.map((m) => Math.max(m.budget, m.actual)));
  return (
    <div className="budget-trend">
      <div className="budget-trend-h">
        <span>Monthly budget vs actual</span>
        <span className="budget-legend"><i className="lg-b" /> Budget <i className="lg-a" /> Actual</span>
      </div>
      <div className="budget-bars">
        {monthly.map((m) => (
          <div className="budget-bar-col" key={m.month} title={`${m.label}: budget ${money(m.budget, cur)} · actual ${money(m.actual, cur)}`}>
            <div className="budget-bar-pair">
              <div className="budget-bar b" style={{ height: `${(m.budget / max) * 100}%` }} />
              <div className="budget-bar a" style={{ height: `${(m.actual / max) * 100}%` }} />
            </div>
            <div className="budget-bar-lbl">{m.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewBudgetModal({ clients, defaultClientId, onClose, onCreated }) {
  const thisApr = (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04`; })();
  const [name, setName] = useState('Product Development Budget');
  const [clientId, setClientId] = useState(defaultClientId || '');
  const [fyStart, setFyStart] = useState(thisApr);
  const [months, setMonths] = useState(12);
  const [demo, setDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const rep = await api('/budgets', { method: 'POST', body: { name: name.trim(), client_id: clientId ? Number(clientId) : null, fy_start: fyStart, months: Number(months), demo } });
      onCreated(rep);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxWidth: 460 }}>
        <div className="modal-header"><strong>New budget</strong><button type="button" className="icon-btn" onClick={onClose}>✕</button></div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="profile-label">Budget name
            <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="profile-label">Client
            <select className="auth-input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">— no client (internal) —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label className="profile-label" style={{ flex: 1 }}>Start month
              <input className="auth-input" type="month" value={fyStart} onChange={(e) => setFyStart(e.target.value)} required />
            </label>
            <label className="profile-label" style={{ width: 120 }}>Months
              <input className="auth-input" type="number" min="1" max="36" value={months} onChange={(e) => setMonths(e.target.value)} />
            </label>
          </div>
          <label className="settings-toggle">
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
            <span className="settings-toggle-label">Pre-fill with a manufacturing product-development demo (R&D, tooling/capex, operations)</span>
          </label>
          {err && <div className="form-error">{err}</div>}
          <div className="editor-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create budget'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
