'use strict';
// Zero-dependency data layer for the hosted (multi-tenant) edition. Uses Node's built-in
// SQLite (node:sqlite, Node 22.5+). Accounts, sessions, per-user settings, and parsed
// statement metadata live in SQLite; the raw PDF bytes live on disk under data/users/<id>/.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ROOST_DATA || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'roost.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created TEXT NOT NULL,
    expires TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    orig_name TEXT,
    canonical TEXT,
    date TEXT,
    year INTEGER,
    bytes INTEGER,
    uploaded TEXT,
    rec_json TEXT,
    parse_version INTEGER,
    UNIQUE(user_id, sha256)
  );
  CREATE INDEX IF NOT EXISTS idx_stmt_user ON statements(user_id);
  CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions(user_id);
`);

// per-user PDF directory
function userDir(userId) {
  const d = path.join(DATA_DIR, 'users', String(userId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { db, DATA_DIR, userDir };
