// Budgeting + Actual-vs-Budget for a client, tuned for a pre-revenue
// manufacturing unit still developing its product (R&D, tooling/capex,
// operations; only nominal grant/pilot income). Provides the report shape the
// team console and the client portal both render, plus a realistic demo seed.
import db from './db.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** The list of 'YYYY-MM' periods a budget spans, from fy_start for `months`. */
export function monthList(fyStart, months) {
  const [y, m] = String(fyStart || '').split('-').map(Number);
  if (!y || !m) return [];
  const out = [];
  for (let i = 0; i < Math.max(1, Math.min(36, months || 12)); i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  }
  return out;
}

const MONTH_LABEL = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

/** Full Actual-vs-Budget report for a budget: lines, sections, totals, trend. */
export function budgetReport(budgetId) {
  const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId);
  if (!budget) return null;
  const client = budget.client_id ? db.prepare('SELECT id, name FROM clients WHERE id = ?').get(budget.client_id) : null;
  const months = monthList(budget.fy_start, budget.months);
  const monthMeta = months.map((m) => ({ key: m, label: MONTH_LABEL(m) }));
  const lineRows = db.prepare('SELECT * FROM budget_lines WHERE budget_id = ? ORDER BY sort, id').all(budgetId);
  const cellRows = db.prepare(
    'SELECT c.* FROM budget_cells c JOIN budget_lines l ON l.id = c.line_id WHERE l.budget_id = ?',
  ).all(budgetId);
  const cellsByLine = new Map();
  for (const c of cellRows) {
    if (!cellsByLine.has(c.line_id)) cellsByLine.set(c.line_id, {});
    cellsByLine.get(c.line_id)[c.month] = { budget: c.budget, actual: c.actual };
  }

  const monthlyTotals = Object.fromEntries(months.map((m) => [m, { budget: 0, actual: 0 }]));
  const byKind = { expense: { budget: 0, actual: 0 }, capex: { budget: 0, actual: 0 }, revenue: { budget: 0, actual: 0 } };

  const lines = lineRows.map((l) => {
    const cells = cellsByLine.get(l.id) || {};
    let tb = 0; let ta = 0;
    const perMonth = months.map((m) => {
      const b = cells[m]?.budget || 0; const a = cells[m]?.actual || 0;
      tb += b; ta += a;
      monthlyTotals[m].budget += b; monthlyTotals[m].actual += a;
      return { month: m, budget: b, actual: a };
    });
    const kind = byKind[l.kind] ? l.kind : 'expense';
    byKind[kind].budget += tb; byKind[kind].actual += ta;
    return {
      id: l.id, section: l.section, category: l.category, kind, sort: l.sort,
      months: perMonth, total_budget: tb, total_actual: ta,
      variance: tb - ta, variance_pct: tb ? ((tb - ta) / tb) * 100 : 0,
    };
  });

  // Group lines into their sections, preserving first-seen order.
  const sectionOrder = [];
  const sectionMap = new Map();
  for (const l of lines) {
    if (!sectionMap.has(l.section)) { sectionMap.set(l.section, { name: l.section, lines: [], total_budget: 0, total_actual: 0 }); sectionOrder.push(l.section); }
    const s = sectionMap.get(l.section);
    s.lines.push(l); s.total_budget += l.total_budget; s.total_actual += l.total_actual;
  }
  const sections = sectionOrder.map((name) => {
    const s = sectionMap.get(name);
    return { ...s, variance: s.total_budget - s.total_actual };
  });

  // Spend = expenses + capex; revenue is tracked separately (nominal pre-launch).
  const spendBudget = byKind.expense.budget + byKind.capex.budget;
  const spendActual = byKind.expense.actual + byKind.capex.actual;
  const totals = {
    budget: spendBudget, actual: spendActual, variance: spendBudget - spendActual,
    pct_spent: spendBudget ? (spendActual / spendBudget) * 100 : 0,
    by_kind: byKind,
    net_burn_budget: spendBudget - byKind.revenue.budget,
    net_burn_actual: spendActual - byKind.revenue.actual,
    monthly: months.map((m) => ({ month: m, label: MONTH_LABEL(m), budget: monthlyTotals[m].budget, actual: monthlyTotals[m].actual })),
  };

  return {
    budget: { id: budget.id, name: budget.name, fy_start: budget.fy_start, months: budget.months, currency: budget.currency, notes: budget.notes, client },
    period: monthMeta,
    lines, sections, totals,
  };
}

// A pre-revenue manufacturing product-development budget. Monthly budgeted spend
// ramps as the build progresses; actuals are filled for the months already
// elapsed (YTD) with small over/under variances, the rest left at 0.
const DEMO_LINES = [
  // section, category, kind, monthly budget (₹), variance factor for actuals
  ['Research & Development', 'Product design & engineering', 'expense', 450000, 1.06],
  ['Research & Development', 'Prototype materials & components', 'expense', 280000, 1.15],
  ['Research & Development', 'Lab testing & quality assurance', 'expense', 160000, 0.92],
  ['Capex — Machinery & Tooling', 'Manufacturing equipment', 'capex', 350000, 1.0],
  ['Capex — Machinery & Tooling', 'Tooling, jigs & moulds', 'capex', 220000, 1.18],
  ['Operations', 'Salaries & wages', 'expense', 900000, 1.0],
  ['Operations', 'Factory rent & utilities', 'expense', 240000, 1.03],
  ['Operations', 'Software & subscriptions', 'expense', 60000, 0.95],
  ['Operations', 'Travel & logistics', 'expense', 90000, 1.22],
  ['Regulatory & IP', 'Certification & compliance', 'expense', 120000, 0.8],
  ['Regulatory & IP', 'Patent & IP filing', 'expense', 80000, 1.1],
  ['Pre-launch Marketing', 'Branding & website', 'expense', 70000, 1.05],
  ['Pre-launch Marketing', 'Market research', 'expense', 50000, 0.9],
  ['Income', 'Grant / pilot income', 'revenue', 100000, 0.6],
];

/** Fill a budget with the demo manufacturing dataset. `elapsed` = months of actuals. */
export function seedDemoManufacturing(budgetId, { elapsed = 6 } = {}) {
  const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId);
  if (!budget) return;
  // Start clean so re-seeding is idempotent.
  db.prepare('DELETE FROM budget_lines WHERE budget_id = ?').run(budgetId);
  const months = monthList(budget.fy_start, budget.months);
  const insLine = db.prepare('INSERT INTO budget_lines (budget_id, section, category, kind, sort) VALUES (?, ?, ?, ?, ?)');
  const insCell = db.prepare('INSERT INTO budget_cells (line_id, month, budget, actual) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    DEMO_LINES.forEach(([section, category, kind, monthly, factor], i) => {
      const lineId = insLine.run(budgetId, section, category, kind, i).lastInsertRowid;
      months.forEach((m, mi) => {
        // Budget ramps gently over the first half of the year, then steadies.
        const ramp = 0.6 + Math.min(1, (mi + 1) / 6) * 0.4;
        const b = Math.round((monthly * ramp) / 1000) * 1000;
        // Actuals only for elapsed months, nudged by the line's variance factor
        // plus a small deterministic wobble so the report looks lived-in.
        let a = 0;
        if (mi < elapsed) {
          const wobble = 1 + (((mi * 7 + i * 3) % 11) - 5) / 100; // ±5%
          a = Math.round((b * factor * wobble) / 1000) * 1000;
        }
        insCell.run(lineId, m, b, a);
      });
    });
  });
  tx();
}

/** Create a client budget and (optionally) seed the demo data. Returns its id. */
export function createBudget(workspaceId, { client_id = null, name, fy_start, months = 12, currency = 'INR', created_by = null, demo = false } = {}) {
  const info = db.prepare(
    'INSERT INTO budgets (workspace_id, client_id, name, fy_start, months, currency, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(workspaceId, client_id || null, name, fy_start, Math.max(1, Math.min(36, months)), currency, created_by);
  const id = info.lastInsertRowid;
  if (demo) seedDemoManufacturing(id);
  return id;
}
