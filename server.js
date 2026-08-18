'use strict';
// ============================================================================
// Roost — HOSTED (multi-tenant) server.  Zero external dependencies.
// Accounts are admin-provisioned (see admin-cli.js). Each signed-in user uploads
// their own statement PDFs; the server parses and stores them per-account (PDFs on
// disk under data/users/<id>/, parsed data + settings in SQLite via node:sqlite),
// and serves each user only their own dashboard. Shared parsing/aggregation logic
// (parser.js, aggregate.js, pdftext.js, xlsxlite.js) is identical to the localhost
// edition on `main`.
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { extractText } = require('./pdftext.js');
const { buildXlsx } = require('./xlsxlite.js');
const { parseStatement } = require('./parser.js');
const { buildSummary } = require('./aggregate.js');
const { db, userDir } = require('./db.js');
const auth = require('./auth.js');

const HERE = __dirname;
const PORT = process.env.PORT || 5000;
const PARSE_VERSION = 6;
const MAX_UPLOAD = 25 * 1024 * 1024;
const DEFAULT_CONFIG = { ma_reclass: { mult: 3.5, floor_min: 80 } };

// ---- per-user settings (the old config.json, now one JSON blob per account) ----
function loadUserConfig(userId) {
  const row = db.prepare('SELECT json FROM settings WHERE user_id=?').get(userId);
  let cfg = {};
  if (row) { try { cfg = JSON.parse(row.json) || {}; } catch {} }
  if (!cfg.ma_reclass) cfg.ma_reclass = DEFAULT_CONFIG.ma_reclass;
  return cfg;
}
function saveUserConfig(userId, cfg) {
  db.prepare('INSERT INTO settings(user_id, json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json')
    .run(userId, JSON.stringify(cfg));
}

// ---- per-user statements: parsed records, re-parsed on disk if PARSE_VERSION changed ----
function loadUserRecords(userId) {
  const rows = db.prepare('SELECT id, sha256, orig_name, rec_json, parse_version FROM statements WHERE user_id=?').all(userId);
  const records = [];
  for (const row of rows) {
    let rec = null;
    if (row.parse_version === PARSE_VERSION && row.rec_json) { try { rec = JSON.parse(row.rec_json); } catch {} }
    if (!rec) {
      try {
        const buf = fs.readFileSync(path.join(userDir(userId), row.sha256 + '.pdf'));
        rec = parseStatement(extractText(buf), row.orig_name || 'upload.pdf');
        db.prepare('UPDATE statements SET rec_json=?, parse_version=?, date=?, year=? WHERE id=?')
          .run(JSON.stringify(rec), PARSE_VERSION, (rec && rec.date) || null, (rec && rec.year) || null, row.id);
      } catch {}
    }
    if (rec) records.push(rec);
  }
  records.sort((a, b) => (a.date < b.date ? -1 : 1));
  return records;
}

// ---- Excel export (same layout as localhost) ----
function buildWorkbook(summary) {
  const yrs = summary.all_years;
  const yCols = yrs.map(yr => ({ header: String(yr), key: String(yr), width: 12, money: true }));
  return buildXlsx([
    { name: 'Yearly', columns: [
      { header: 'Year', key: 'year', width: 10 }, { header: 'Statements', key: 'statements', width: 12 },
      { header: 'New Business', key: 'advances', width: 16, money: true }, { header: 'Residual', key: 'residual', width: 14, money: true },
      { header: 'Bonuses', key: 'bonus', width: 13, money: true }, { header: 'Chargebacks', key: 'chargebacks', width: 14, money: true },
      { header: 'Net Paid', key: 'net', width: 14, money: true }, { header: 'Avg/Statement', key: 'avg_per_statement', width: 15, money: true },
      { header: 'YTD Total', key: 'ytd_total', width: 14, money: true } ], rows: summary.years },
    { name: 'Statements', columns: [
      { header: 'Date', key: 'date', width: 14 }, { header: 'Year', key: 'year', width: 8 },
      { header: 'New Business', key: 'advances', width: 16, money: true }, { header: 'Residual', key: 'residual', width: 14, money: true },
      { header: 'Bonuses', key: 'bonus', width: 13, money: true }, { header: 'Chargebacks', key: 'chargebacks', width: 14, money: true },
      { header: 'Net Paid', key: 'net', width: 14, money: true } ], rows: summary.series },
    { name: 'Residual by Carrier', columns: [
      { header: 'Carrier', key: 'carrier', width: 22 }, ...yCols, { header: 'Total', key: 'total', width: 14, money: true } ],
      rows: summary.residual_by_carrier },
    { name: 'Residual Policies', columns: [
      { header: 'Policy', key: 'policy', width: 18 }, { header: 'Client', key: 'client', width: 22 },
      { header: 'Carrier', key: 'carrier', width: 18 }, { header: 'Product', key: 'product', width: 26 },
      { header: 'Payments', key: 'payments', width: 10 }, ...yCols, { header: 'Total', key: 'total', width: 14, money: true } ],
      rows: summary.policies },
  ]);
}

// ---- helpers ----
function send(res, code, type, body, headers) { res.writeHead(code, Object.assign({ 'Content-Type': type }, headers || {})); res.end(body); }
function sendJson(res, code, obj, headers) { send(res, code, 'application/json', JSON.stringify(obj), headers); }
function readBody(req, cb) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => {});
  req.on('end', () => { let o = {}; try { o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {} cb(o); });
}

// ---- statement upload (raw PDF body, filename in ?name=) ----
function handleUpload(req, res, user) {
  const qs = req.url.split('?')[1] || '';
  const nm = /(?:^|&)name=([^&]*)/.exec(qs);
  let origName = 'upload.pdf';
  try { origName = decodeURIComponent(nm ? nm[1] : origName); } catch {}
  origName = origName.replace(/[\r\n]/g, '').replace(/[\\/]/g, '_') || 'upload.pdf';
  const chunks = []; let size = 0, aborted = false;
  req.on('data', c => { size += c.length; if (size > MAX_UPLOAD) { aborted = true; req.destroy(); } else chunks.push(c); });
  req.on('error', () => {});
  req.on('end', () => {
    if (aborted) return sendJson(res, 413, { status: 'error', name: origName, message: 'File too large' });
    try {
      const buf = Buffer.concat(chunks);
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return sendJson(res, 400, { status: 'error', name: origName, message: 'Not a PDF file' });
      let rec = null; try { rec = parseStatement(extractText(buf), origName); } catch {}
      if (!rec || !rec.date) return sendJson(res, 422, { status: 'error', name: origName,
        message: 'Could not read a statement date — rename the file like M-D-YY.pdf and retry.' });
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (db.prepare('SELECT id FROM statements WHERE user_id=? AND sha256=?').get(user.id, sha))
        return sendJson(res, 200, { status: 'duplicate', name: origName, message: 'Already uploaded' });
      fs.writeFileSync(path.join(userDir(user.id), sha + '.pdf'), buf);
      const [Y, M, D] = rec.date.split('-').map(Number);
      const canonical = `${M}-${D}-${String(Y).slice(2)}.pdf`;
      db.prepare('INSERT INTO statements(user_id, sha256, orig_name, canonical, date, year, bytes, uploaded, rec_json, parse_version) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(user.id, sha, origName, canonical, rec.date, Y, buf.length, new Date().toISOString(), JSON.stringify(rec), PARSE_VERSION);
      return sendJson(res, 200, { status: 'filed', name: origName, filed: `${Y}/${canonical}`, year: Y, message: `Filed statement for ${rec.date}` });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', name: origName, message: String((e && e.message) || e) });
    }
  });
}

// ---- per-user settings endpoints (goals / expenses / profile / downline) ----
function updateConfig(req, res, user, mutate) {
  readBody(req, o => {
    try { const cfg = loadUserConfig(user.id); const ret = mutate(cfg, o) || {}; saveUserConfig(user.id, cfg); sendJson(res, 200, Object.assign({ status: 'ok' }, ret)); }
    catch (e) { sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) }); }
  });
}
const cleanArr = a => Array.isArray(a) ? [...new Set(a.map(x => String(x).trim()).filter(Boolean))] : [];

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  try {
    const url = req.url.split('?')[0];
    const cookies = auth.parseCookies(req.headers.cookie);
    const user = auth.userForToken(cookies.roost_session);

    // ---- public routes ----
    if (url === '/' || url === '/index.html')
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'index.html')));
    if (url === '/api/login' && req.method === 'POST')
      return readBody(req, o => { const r = auth.login(o.username, o.password);
        if (!r) return sendJson(res, 401, { status: 'error', message: 'Invalid username or password' });
        sendJson(res, 200, { status: 'ok', user: r.user }, { 'Set-Cookie': auth.sessionCookie(r.token) }); });
    if (url === '/api/logout' && req.method === 'POST') { auth.logout(cookies.roost_session);
      return sendJson(res, 200, { status: 'ok' }, { 'Set-Cookie': auth.sessionCookie('', true) }); }
    if (url === '/api/me')
      return user ? sendJson(res, 200, { user }) : sendJson(res, 401, { error: 'not signed in' });

    // ---- everything below requires a signed-in user ----
    if (!user) return sendJson(res, 401, { error: 'sign in required' });

    if (url === '/api/data') {
      const records = loadUserRecords(user.id);
      return send(res, 200, 'application/json', JSON.stringify(buildSummary(records, loadUserConfig(user.id))));
    }
    if (url === '/api/upload' && req.method === 'POST') return handleUpload(req, res, user);
    if (url === '/api/export') {
      const buf = buildWorkbook(buildSummary(loadUserRecords(user.id), loadUserConfig(user.id)));
      return res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="commissions-${new Date().toISOString().slice(0, 10)}.xlsx"` }), res.end(buf);
    }
    if (url === '/api/goals' && req.method === 'POST')
      return updateConfig(req, res, user, (cfg, o) => { const g = (cfg.goals && typeof cfg.goals === 'object') ? cfg.goals : {};
        const year = String(parseInt(o.year, 10)); const net = Number(o.net); if (!/^\d{4}$/.test(year)) throw new Error('invalid year');
        if (!isFinite(net) || net < 0) delete g[year]; else g[year] = { net: Math.round(net) }; cfg.goals = g; return { goals: g }; });
    if (url === '/api/expenses' && req.method === 'POST')
      return updateConfig(req, res, user, (cfg, o) => { const all = (cfg.expenses && typeof cfg.expenses === 'object') ? cfg.expenses : {};
        const year = String(parseInt(o.year, 10)); if (!/^\d{4}$/.test(year)) throw new Error('invalid year');
        const KEYS = ['leads', 'marketing', 'eo', 'crm', 'staff', 'other']; const src = o.expenses || {}; const clean = {}; let any = false;
        for (const k of KEYS) { const n = Number(src[k]); if (isFinite(n) && n > 0) { clean[k] = Math.round(n); any = true; } }
        if (any) all[year] = clean; else delete all[year]; cfg.expenses = all; return { expenses: all }; });
    if (url === '/api/profile' && req.method === 'POST')
      return updateConfig(req, res, user, (cfg, o) => { const p = (cfg.profile && typeof cfg.profile === 'object') ? cfg.profile : {};
        if ('convention_level' in o) { const lv = Number(o.convention_level); if (isFinite(lv) && lv >= 1 && lv <= 10) p.convention_level = lv; else delete p.convention_level; }
        if ('self_names' in o) { const c = cleanArr(o.self_names); if (c.length) p.self_names = c; else delete p.self_names; }
        if ('convention_pay_lag_days' in o) { const d = Number(o.convention_pay_lag_days); if (isFinite(d) && d >= 0 && d <= 180) p.convention_pay_lag_days = Math.round(d); else delete p.convention_pay_lag_days; }
        if ('tax' in o && o.tax && typeof o.tax === 'object') p.tax = Object.assign({}, p.tax, o.tax);
        for (const key of ['convention_exclude', 'convention_include']) if (key in o) { const c = cleanArr(o[key]); if (c.length) p[key] = c; else delete p[key]; }
        cfg.profile = p; return { profile: p }; });
    if (url === '/api/downline-overrides' && req.method === 'POST')
      return updateConfig(req, res, user, (cfg, o) => { cfg.downline_include = cleanArr(o.include); cfg.downline_exclude = cleanArr(o.exclude);
        return { include: cfg.downline_include, exclude: cfg.downline_exclude }; });
    if (url === '/api/downline-hierarchy' && req.method === 'POST')
      return updateConfig(req, res, user, (cfg, o) => { const parents = {};
        if (o.parents && typeof o.parents === 'object') for (const [k, v] of Object.entries(o.parents))
          if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim() && k !== v) parents[k] = v;
        cfg.downline_parents = parents; return { parents }; });

    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    try { sendJson(res, 500, { error: String((e && e.message) || e) }); } catch {}
  }
});

server.listen(PORT, () => {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  console.log(`Roost (hosted) on http://127.0.0.1:${PORT}`);
  if (!n) console.log('No accounts yet — create one:  node admin-cli.js add <username>');
  else console.log(`${n} account(s). Manage with: node admin-cli.js list`);
});
