// Configurable lead pipeline stages. Each workspace gets its own ordered list;
// the five defaults are seeded the first time a workspace touches the pipeline.
import db from './db.js';

export const DEFAULT_STAGES = [
  { key: 'new', label: 'New', outcome: 'open' },
  { key: 'contacted', label: 'Contacted', outcome: 'open' },
  { key: 'qualified', label: 'Qualified', outcome: 'open' },
  { key: 'won', label: 'Won', outcome: 'won' },
  { key: 'lost', label: 'Lost', outcome: 'lost' },
];

/** Seed the default columns for a workspace that has none yet. */
export function ensureStages(workspaceId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM lead_stages WHERE workspace_id = ?').get(workspaceId).n;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO lead_stages (workspace_id, key, label, position, outcome) VALUES (?, ?, ?, ?, ?)');
    DEFAULT_STAGES.forEach((s, i) => insert.run(workspaceId, s.key, s.label, i, s.outcome));
  }
  return listStages(workspaceId);
}

export function listStages(workspaceId) {
  return db.prepare('SELECT id, key, label, position, auto_task, auto_reminder_days, outcome FROM lead_stages WHERE workspace_id = ? ORDER BY position, id').all(workspaceId);
}

export function stageKeys(workspaceId) {
  return ensureStages(workspaceId).map((s) => s.key);
}

/** The entry column new leads land in (the first by position). */
export function firstStageKey(workspaceId) {
  const stages = ensureStages(workspaceId);
  return stages[0]?.key || 'new';
}

/** Build a unique slug for a new stage from its label. */
export function makeStageKey(workspaceId, label) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'stage';
  let key = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM lead_stages WHERE workspace_id = ? AND key = ?').get(workspaceId, key)) {
    key = `${base}-${n++}`;
  }
  return key;
}
