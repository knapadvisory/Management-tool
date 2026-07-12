import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
export const AVATAR_COLORS = ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e', '#7c3aed', '#f97316', '#0ea5e9', '#db2777'];

export function publicUser(u) {
  if (!u) return null;
  const { id, name, email, avatar_color, title, role, active, approved, theme, accent, workspace_id } = u;
  return {
    id, name, email, avatar_color, title, role: role || 'member', active: active ?? 1, approved: approved ?? 1,
    theme: theme || 'light', accent: accent || '#4f46e5', workspace_id,
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// External guests are scoped to their collab chats only — they may not reach
// tasks, projects, the directory, files, the dashboard, or any internal area.
export function blockGuests(req, res, next) {
  if (req.user?.role === 'guest') return res.status(403).json({ error: 'This area is not available to guests' });
  next();
}

export function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verifyToken(token);
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!req.user) return res.status(401).json({ error: 'Unknown user' });
    if (!req.user.active) return res.status(403).json({ error: 'Account deactivated' });
    // Every downstream query scopes to this — the caller's workspace.
    req.workspaceId = req.user.workspace_id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Creating a NEW workspace can be gated by a global platform code (env
// WORKSPACE_SIGNUP_CODE) so the deployment isn't wide open. Empty = anyone.
export const workspaceSignupCodeRequired = () => !!(process.env.WORKSPACE_SIGNUP_CODE || '').trim();

// A workspace admin restricts who can JOIN their workspace to one or more work
// email domains (comma/space separated, stored without '@'). Empty = any email.
export function allowedSignupDomains(workspace) {
  return (workspace?.allowed_signup_domains || '')
    .split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}
export function emailDomainAllowed(workspace, email) {
  const domains = allowedSignupDomains(workspace);
  if (!domains.length) return true; // no restriction configured
  const at = (email || '').trim().toLowerCase().split('@')[1] || '';
  return domains.includes(at);
}

// Register a new MEMBER into an existing workspace (the "join your company"
// flow). Gated by that workspace's email-domain policy.
export function register(workspace, { name, email, password }) {
  if (!workspace) throw Object.assign(new Error('Workspace not found'), { status: 404 });
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    throw Object.assign(new Error('Name, email and a password of 6+ characters are required'), { status: 400 });
  }
  if (!emailDomainAllowed(workspace, email)) {
    const domains = allowedSignupDomains(workspace);
    throw Object.assign(new Error(
      `Please join with your work email (${domains.map((d) => '@' + d).join(' or ')}). If you're an external collaborator, ask a team member to invite you to a collab instead.`
    ), { status: 403 });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) throw Object.assign(new Error('An account with this email already exists'), { status: 409 });

  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  // Self-registered members start unapproved — an admin must let them in.
  const info = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color, role, workspace_id, approved) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), color, 'member', workspace.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  // They join #general only once approved (see approveUser), so nothing to do here.
  return user;
}

// Create the FIRST admin user of a freshly-created workspace.
export function createWorkspaceAdmin(workspace, { name, email, password }) {
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    throw Object.assign(new Error('Name, email and a password of 6+ characters are required'), { status: 400 });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase())) {
    throw Object.assign(new Error('An account with this email already exists'), { status: 409 });
  }
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color, role, workspace_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), color, 'admin', workspace.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  joinGeneral(workspace.id, user.id);
  return user;
}

// Add a user to their workspace's #general channel.
export function joinGeneral(workspaceId, userId) {
  const general = db.prepare(`SELECT id FROM channels WHERE name = 'general' AND is_dm = 0 AND workspace_id = ?`).get(workspaceId);
  if (general) db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(general.id, userId);
}

// Self-service profile edit: a user updates their own name, title and avatar
// colour. Only the provided fields change.
export function updateOwnProfile(userId, { name, title, avatar_color, theme, accent }) {
  const sets = [], vals = [];
  if (name !== undefined) {
    if (!String(name).trim()) throw Object.assign(new Error('Name is required'), { status: 400 });
    sets.push('name = ?'); vals.push(String(name).trim());
  }
  if (title !== undefined) { sets.push('title = ?'); vals.push(String(title).trim() || null); }
  if (avatar_color !== undefined) {
    if (!AVATAR_COLORS.includes(avatar_color)) throw Object.assign(new Error('Invalid avatar colour'), { status: 400 });
    sets.push('avatar_color = ?'); vals.push(avatar_color);
  }
  if (theme !== undefined) {
    if (!['light', 'dark', 'system'].includes(theme)) throw Object.assign(new Error('Invalid theme'), { status: 400 });
    sets.push('theme = ?'); vals.push(theme);
  }
  if (accent !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw Object.assign(new Error('Invalid accent colour'), { status: 400 });
    sets.push('accent = ?'); vals.push(accent);
  }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

// Self-service password change: verify the current password before setting a new one.
export function changeOwnPassword(userId, current, next) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || !bcrypt.compareSync(current || '', u.password_hash)) {
    throw Object.assign(new Error('Your current password is incorrect'), { status: 403 });
  }
  if (!next || next.length < 6) {
    throw Object.assign(new Error('New password must be at least 6 characters'), { status: 400 });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), userId);
}

// Create an external guest account (used when someone joins via a collab
// invite link). Guests have no real email, so we mint a synthetic unique one.
export function createGuest({ name, password, workspaceId }) {
  if (!name?.trim() || !password || password.length < 6) {
    throw Object.assign(new Error('A name and a password of 6+ characters are required'), { status: 400 });
  }
  const email = `guest+${crypto.randomBytes(8).toString('hex')}@teamhub.guest`;
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color, role, workspace_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), email, bcrypt.hashSync(password, 10), color, 'guest', workspaceId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// A returning guest signs back in with the same name + password they chose
// when they first joined. We match against the guest members already in the
// collab so a repeat join doesn't mint a duplicate account.
export function findReturningGuest({ channelId, name, password }) {
  if (!name?.trim() || !password) return null;
  const candidates = db.prepare(`
    SELECT u.* FROM channel_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.channel_id = ? AND u.role = 'guest' AND LOWER(u.name) = LOWER(?)
  `).all(channelId, name.trim());
  return candidates.find((u) => u.active && bcrypt.compareSync(password, u.password_hash)) || null;
}

export function login({ email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }
  if (!user.approved) {
    throw Object.assign(new Error('Your account is still awaiting approval from your workspace admin.'), { status: 403 });
  }
  if (!user.active) {
    throw Object.assign(new Error('This account has been deactivated. Contact your administrator.'), { status: 403 });
  }
  return user;
}
