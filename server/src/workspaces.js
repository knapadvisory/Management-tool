import db, { seedWorkspace } from './db.js';

// Turn a company name into a URL-safe slug, guaranteeing uniqueness.
export function slugify(name) {
  const base = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
  let slug = base, n = 2;
  while (db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function workspaceBySlug(slug) {
  return db.prepare('SELECT * FROM workspaces WHERE slug = ?').get((slug || '').trim().toLowerCase()) || null;
}
export function workspaceById(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
}

// Public-safe view of a workspace (for the client).
export function publicWorkspace(w) {
  if (!w) return null;
  return { id: w.id, name: w.name, slug: w.slug };
}

// Create a brand-new workspace and seed its starter content (#general + a
// default workflow). Returns the workspace row.
export function createWorkspace({ name }) {
  if (!name?.trim()) throw Object.assign(new Error('Workspace name is required'), { status: 400 });
  const slug = slugify(name);
  const info = db.prepare('INSERT INTO workspaces (name, slug) VALUES (?, ?)').run(name.trim(), slug);
  seedWorkspace(info.lastInsertRowid);
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(info.lastInsertRowid);
}
