'use strict';
// Zero-dependency auth: scrypt password hashing + random session tokens, all via node:crypto.
const crypto = require('crypto');
const { db } = require('./db.js');

const SESSION_DAYS = 30;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ---- accounts (admin-provisioned) ----
function createUser(username, password, isAdmin) {
  username = String(username || '').trim().toLowerCase();
  if (!username) throw new Error('username required');
  if (!password || String(password).length < 6) throw new Error('password must be at least 6 characters');
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users(username, pass_hash, salt, is_admin, created) VALUES(?,?,?,?,?)')
    .run(username, hash, salt, isAdmin ? 1 : 0, new Date().toISOString());
  const u = getUserByName(username);
  db.prepare('INSERT OR IGNORE INTO settings(user_id, json) VALUES(?, ?)').run(u.id, '{}');
  return u;
}
function setPassword(username, password) {
  const u = getUserByName(username); if (!u) throw new Error('no such user');
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hash, salt, u.id);
}
function deleteUser(username) {
  const u = getUserByName(username); if (!u) return;
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM statements WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM settings WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
}
function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim().toLowerCase());
}
function listUsers() { return db.prepare('SELECT id, username, is_admin, created FROM users ORDER BY username').all(); }

// ---- login / sessions ----
function login(username, password) {
  const u = getUserByName(username);
  if (!u || !verifyPassword(password, u.salt, u.pass_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date(), exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions(token, user_id, created, expires) VALUES(?,?,?,?)')
    .run(token, u.id, now.toISOString(), exp.toISOString());
  return { token, user: publicUser(u) };
}
function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); }
function userForToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  if (new Date(s.expires) < new Date()) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return null; }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  return u ? publicUser(u) : null;
}
function publicUser(u) { return { id: u.id, username: u.username, is_admin: !!u.is_admin }; }

// ---- cookies ----
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function sessionCookie(token, clear) {
  const base = `roost_session=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/`;
  return clear ? base + '; Max-Age=0' : base + `; Max-Age=${SESSION_DAYS * 86400}`;
}

module.exports = { createUser, setPassword, deleteUser, getUserByName, listUsers,
  login, logout, userForToken, parseCookies, sessionCookie, publicUser };
