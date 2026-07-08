import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const AVATAR_COLORS = ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e', '#7c3aed', '#f97316', '#0ea5e9', '#db2777'];

export function publicUser(u) {
  if (!u) return null;
  const { id, name, email, avatar_color, title, role, active } = u;
  return { id, name, email, avatar_color, title, role: role || 'member', active: active ?? 1 };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
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
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// When SIGNUP_CODE is set, registration requires that shared code — so a
// public link can be shared safely with only the people who have it.
export const signupCodeRequired = () => !!(process.env.SIGNUP_CODE || '').trim();

export function register({ name, email, password, code }) {
  if (signupCodeRequired() && (code || '').trim() !== process.env.SIGNUP_CODE.trim()) {
    throw Object.assign(new Error('Invalid or missing access code'), { status: 403 });
  }
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    throw Object.assign(new Error('Name, email and a password of 6+ characters are required'), { status: 400 });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) throw Object.assign(new Error('An account with this email already exists'), { status: 409 });

  // The first person to register the workspace becomes the super admin.
  const isFirstUser = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const role = isFirstUser ? 'admin' : 'member';

  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color, role) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), color, role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Everyone joins #general automatically.
  const general = db.prepare(`SELECT id FROM channels WHERE name = 'general' AND is_dm = 0`).get();
  if (general) {
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(general.id, user.id);
  }
  return user;
}

export function login({ email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }
  if (!user.active) {
    throw Object.assign(new Error('This account has been deactivated. Contact your administrator.'), { status: 403 });
  }
  return user;
}
