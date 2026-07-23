import crypto from 'crypto';
import db from './db.js';

// The platform-owner workspace (KNAP) whose admins manage company-registration
// codes. Defaults to the first workspace created.
export const PLATFORM_WORKSPACE_ID = Number(process.env.PLATFORM_OWNER_WORKSPACE_ID || 1);
export function isPlatformAdmin(user) {
  return user?.role === 'admin' && user?.workspace_id === PLATFORM_WORKSPACE_ID;
}

// Human-friendly code: 8 chars from an unambiguous alphabet (no O/0/I/1/L),
// grouped as XXXX-XXXX. Regenerated until unique in the given table.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function raw(len = 8) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
function uniqueCode(table) {
  for (let i = 0; i < 20; i++) {
    const c = raw();
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(c)) return c;
  }
  return raw(12); // vanishingly unlikely fallback
}
const norm = (c) => (c || '').trim().toUpperCase();

// --- Workspace employee invite codes ---
export function createInviteCode(workspaceId, createdBy, label = '') {
  const code = uniqueCode('workspace_invite_codes');
  const info = db.prepare('INSERT INTO workspace_invite_codes (workspace_id, code, label, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, code, String(label || '').trim().slice(0, 60), createdBy);
  return db.prepare('SELECT * FROM workspace_invite_codes WHERE id = ?').get(info.lastInsertRowid);
}
export function listInviteCodes(workspaceId) {
  return db.prepare(`
    SELECT ic.*, u.name AS used_by_name
    FROM workspace_invite_codes ic LEFT JOIN users u ON u.id = ic.used_by
    WHERE ic.workspace_id = ? ORDER BY ic.used_at IS NOT NULL, ic.id DESC
  `).all(workspaceId);
}
export function revokeInviteCode(id, workspaceId) {
  return db.prepare('DELETE FROM workspace_invite_codes WHERE id = ? AND workspace_id = ? AND used_at IS NULL')
    .run(id, workspaceId).changes > 0;
}
// Returns the unused code row for this workspace, or null.
export function findUsableInvite(workspaceId, code) {
  return db.prepare('SELECT * FROM workspace_invite_codes WHERE workspace_id = ? AND code = ? AND used_at IS NULL')
    .get(workspaceId, norm(code)) || null;
}
export function consumeInvite(id, userId) {
  db.prepare(`UPDATE workspace_invite_codes SET used_by = ?, used_at = datetime('now') WHERE id = ?`).run(userId, id);
}

// --- Platform company-registration codes ---
export function createCompanyCode(createdBy, label = '') {
  const code = uniqueCode('company_registration_codes');
  const info = db.prepare('INSERT INTO company_registration_codes (code, label, created_by) VALUES (?, ?, ?)')
    .run(code, String(label || '').trim().slice(0, 60), createdBy);
  return db.prepare('SELECT * FROM company_registration_codes WHERE id = ?').get(info.lastInsertRowid);
}
export function listCompanyCodes() {
  return db.prepare(`
    SELECT cc.*, w.name AS used_by_workspace_name
    FROM company_registration_codes cc LEFT JOIN workspaces w ON w.id = cc.used_by_workspace
    ORDER BY cc.used_at IS NOT NULL, cc.id DESC
  `).all();
}
export function revokeCompanyCode(id) {
  return db.prepare('DELETE FROM company_registration_codes WHERE id = ? AND used_at IS NULL').run(id).changes > 0;
}
export function findUsableCompanyCode(code) {
  return db.prepare('SELECT * FROM company_registration_codes WHERE code = ? AND used_at IS NULL').get(norm(code)) || null;
}
export function consumeCompanyCode(id, workspaceId) {
  db.prepare(`UPDATE company_registration_codes SET used_by_workspace = ?, used_at = datetime('now') WHERE id = ?`).run(workspaceId, id);
}
