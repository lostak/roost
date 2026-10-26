'use strict';
/*
 * Roost - local Node server (zero external dependencies).
 *
 * Scans the year folders (2024, 2025, ...) next to this roost folder,
 * extracts + parses every statement PDF, and serves a Material Design dashboard
 * plus a JSON API and an Excel export. Uses only Node's built-in modules, so it
 * runs with `node server.js` -- no npm install required.
 *
 * Run:  node server.js    then open  http://127.0.0.1:5000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { extractText } = require('./pdftext.js');
const { buildXlsx } = require('./xlsxlite.js');
const { parseStatement } = require('./parser.js');
const { buildSummary, prepareRecords } = require('./aggregate.js');
const ai = require('./ai.js');
const { writeClientFolders } = require('./clients.js');

const HERE = __dirname;
const ROOT = path.dirname(HERE);              // the Commissions folder
const CACHE_FILE = path.join(HERE, '.parse_cache.json');
const CONFIG_FILE = path.join(HERE, 'config.json');
const CLIENTS_DIR = path.join(ROOT, 'Clients'); // ../Commissions/Clients
const PORT = process.env.PORT || 5000;
// Bump when parser.js output shape changes so cached records are re-parsed.
// (v5: expanded carrier detection.)
const PARSE_VERSION = 6;

// ---- user configuration (downline roster, MA thresholds) ----
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('config.json is not valid JSON — using defaults:', e.message);
    return {};
  }
}

// ---- where the year folders (2024/, 2025/, ...) live ----
// Configurable via config.json "statements_dir" (resolved relative to this app
// folder). We pick the first candidate that actually contains year folders, so
// the app works whether statements are nested under Statements/ or sit at the
// Commissions root (legacy layout).
function hasYearFolders(dir) {
  try {
    return fs.readdirSync(dir).some(n =>
      /^\d{4}$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory());
  } catch { return false; }
}
function statementsDir() {
  const cfg = loadConfig();
  const candidates = [];
  if (cfg.statements_dir) candidates.push(path.resolve(HERE, cfg.statements_dir));
  candidates.push(path.join(ROOT, 'Statements'));   // default nested layout
  candidates.push(ROOT);                            // legacy: years at root
  for (const dir of candidates) if (hasYearFolders(dir)) return dir;
  return path.join(ROOT, 'Statements');             // sensible default if empty
}

// ---- disk-backed mtime cache: path -> {mtime, rec} ----
let CACHE = {};
try { CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { CACHE = {}; }
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE)); } catch {} }

function yearFolders() {
  const base = statementsDir();
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names
    .filter(n => /^\d{4}$/.test(n))
    .filter(n => { try { return fs.statSync(path.join(base, n)).isDirectory(); } catch { return false; } })
    .sort()
    .map(n => path.join(base, n));
}

function loadStatements() {
  const records = [];
  const skipped = [];
  let dirty = false;
  for (const folder of yearFolders()) {
    let files = [];
    try { files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.pdf')); }
    catch { continue; }
    for (const f of files) {
      const full = path.join(folder, f);
      let mtime;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      const cached = CACHE[full];
      let rec;
      if (cached && cached.mtime === mtime && cached.v === PARSE_VERSION) {
        rec = cached.rec;
      } else {
        try {
          const text = extractText(fs.readFileSync(full));
          rec = parseStatement(text, f);
        } catch (e) {
          rec = { file: f, error: String((e && e.message) || e) };
        }
        CACHE[full] = { mtime, v: PARSE_VERSION, rec };
        dirty = true;
      }
      if (!rec.error && rec.date) records.push(rec);
      else skipped.push({ file: f, reason: rec.error ? 'parse error: ' + rec.error : 'no date found' });
    }
  }
  if (dirty) saveCache();
  if (dirty || !fs.existsSync(CLIENTS_DIR)) {
    try {
      // Use reclassified records so Medicare Advantage initials count as new business.
      const s = writeClientFolders(prepareRecords(records, loadConfig()), CLIENTS_DIR);
      console.log(`  Client folders: ${s.clients} clients, ${s.policies} policies -> ${CLIENTS_DIR}`);
    } catch (e) { console.warn('  Client folder generation failed:', e.message); }
  }
  if (skipped.length) {
    console.warn(`\n  ${skipped.length} statement(s) skipped:`);
    for (const s of skipped) console.warn(`   - ${s.file}  (${s.reason})`);
  }
  records.sort((a, b) => (a.date < b.date ? -1 : 1));
  return records;
}

// ---- Excel export ----
function buildWorkbook(summary) {
  const yrs = summary.all_years;
  const yCols = yrs.map(yr => ({ header: String(yr), key: String(yr), width: 12, money: true }));
  return buildXlsx([
    { name: 'Yearly', columns: [
      { header: 'Year', key: 'year', width: 10 },
      { header: 'Statements', key: 'statements', width: 12 },
      { header: 'New Business', key: 'advances', width: 16, money: true },
      { header: 'Residual', key: 'residual', width: 14, money: true },
      { header: 'Bonuses', key: 'bonus', width: 13, money: true },
      { header: 'Chargebacks', key: 'chargebacks', width: 14, money: true },
      { header: 'Net Paid', key: 'net', width: 14, money: true },
      { header: 'Avg/Statement', key: 'avg_per_statement', width: 15, money: true },
      { header: 'YTD Total', key: 'ytd_total', width: 14, money: true },
    ], rows: summary.years },
    { name: 'Monthly', columns: [
      { header: 'Month', key: 'label', width: 14 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Statements', key: 'statements', width: 12 },
      { header: 'New Business', key: 'advances', width: 16, money: true },
      { header: 'Residual', key: 'residual', width: 14, money: true },
      { header: 'Bonuses', key: 'bonus', width: 13, money: true },
      { header: 'Chargebacks', key: 'chargebacks', width: 14, money: true },
      { header: 'Net Paid', key: 'net', width: 14, money: true },
    ], rows: summary.monthly },
    { name: 'Residual by Carrier', columns: [
      { header: 'Carrier', key: 'carrier', width: 22 }, ...yCols,
      { header: 'Total', key: 'total', width: 14, money: true },
    ], rows: summary.residual_by_carrier },
    { name: 'Residual Policies', columns: [
      { header: 'Policy', key: 'policy', width: 18 },
      { header: 'Client', key: 'client', width: 22 },
      { header: 'Carrier', key: 'carrier', width: 18 },
      { header: 'Product', key: 'product', width: 26 },
      { header: 'Payments', key: 'payments', width: 10 }, ...yCols,
      { header: 'Total', key: 'total', width: 14, money: true },
    ], rows: summary.policies },
    { name: 'Statements', columns: [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'New Business', key: 'advances', width: 16, money: true },
      { header: 'Residual', key: 'residual', width: 14, money: true },
      { header: 'Bonuses', key: 'bonus', width: 13, money: true },
      { header: 'Chargebacks', key: 'chargebacks', width: 14, money: true },
      { header: 'Net Paid', key: 'net', width: 14, money: true },
    ], rows: summary.series },
    { name: 'Bonuses & Overrides', columns: [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Category', key: 'kind', width: 22 },
      { header: 'Carrier', key: 'carrier', width: 18 },
      { header: 'Client / Ref', key: 'client', width: 24 },
      { header: 'Product', key: 'product', width: 28 },
      { header: 'Amount', key: 'amount', width: 12, money: true },
    ], rows: (summary.bonuses ? summary.bonuses.items : []) },
    { name: 'Downline Agents', columns: [
      { header: 'Writing Agent', key: 'name', width: 26 },
      { header: 'Downline', key: 'dl', width: 10 },
      { header: 'Advances', key: 'advances', width: 14, money: true },
      { header: 'Residual', key: 'residual', width: 14, money: true },
      { header: 'Chargebacks', key: 'chargebacks', width: 14, money: true },
      { header: 'Total', key: 'total', width: 14, money: true },
      { header: 'Lines', key: 'count', width: 8 },
    ], rows: (summary.downline ? summary.downline.agents : []).map(a => ({ ...a, dl: a.downline ? 'yes' : '' })) },
    { name: 'Downline Detail', columns: [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Client', key: 'client', width: 22 },
      { header: 'Carrier', key: 'carrier', width: 16 },
      { header: 'Product', key: 'product', width: 28 },
      { header: 'Type', key: 'section', width: 12 },
      { header: 'Amount', key: 'amount', width: 12, money: true },
      { header: 'Writing Agents', key: 'agents', width: 32 },
    ], rows: (summary.downline ? summary.downline.policies : []) },
  ]);
}

// ---- HTTP server ----
function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
function sendJson(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }

// ---- statement upload ----
// Accepts a raw PDF body (Content-Type ignored) with the original filename in
// the ?name= query param. The statement date is read from the PDF's own content
// (the pay-period date), so the upload can be named anything; it's then filed into
// <statements>/<year>/<M-D-YY>.pdf, named from that date, in the right year folder.
// Existing statements for the same date are left untouched (reported as duplicates).
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB safety cap (statements are ~60 KB)
function handleUpload(req, res) {
  const qs = req.url.split('?')[1] || '';
  const nm = /(?:^|&)name=([^&]*)/.exec(qs);
  let origName = 'upload.pdf';
  try { origName = decodeURIComponent(nm ? nm[1] : origName); } catch {}
  origName = origName.replace(/[\r\n]/g, '').replace(/[\\/]/g, '_') || 'upload.pdf';

  const chunks = []; let size = 0; let aborted = false;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_UPLOAD) { aborted = true; req.destroy(); }
    else chunks.push(c);
  });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    if (aborted) return sendJson(res, 413, { status: 'error', name: origName, message: 'File too large' });
    try {
      const buf = Buffer.concat(chunks);
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-')
        return sendJson(res, 400, { status: 'error', name: origName, message: 'Not a PDF file' });

      let rec = null;
      try { rec = parseStatement(extractText(buf), origName); } catch {}
      if (!rec || !rec.date)
        return sendJson(res, 422, { status: 'error', name: origName,
          message: 'Could not read a statement date from this PDF. Make sure it’s a commission statement.' });

      const [Y, M, D] = rec.date.split('-').map(Number);
      const base = `${M}-${D}-${String(Y).slice(2)}`;
      const dir = path.join(statementsDir(), String(Y));
      fs.mkdirSync(dir, { recursive: true });

      // Agents who run an LLC get two statements per pay period (one to their name, one to the
      // LLC). Both must be kept, so de-duplicate by file CONTENT, not by date: an identical file
      // is a true duplicate; a different statement for the same date is filed under its own name.
      const sameBytes = (p) => { try { return Buffer.compare(fs.readFileSync(p), buf) === 0; } catch { return false; } };
      const existing = fs.readdirSync(dir).filter(n => n.startsWith(base) && n.toLowerCase().endsWith('.pdf'));
      for (const n of existing) if (sameBytes(path.join(dir, n)))
        return sendJson(res, 200, { status: 'duplicate', name: origName, filed: n, year: Y,
          message: `Already filed as ${Y}/${n}` });

      const safeHolder = String(rec.holder || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const candidates = [`${base}.pdf`];
      if (safeHolder) candidates.push(`${base} - ${safeHolder}.pdf`);
      for (let i = 2; i <= 20; i++) candidates.push(`${base} (${i}).pdf`);
      const name = candidates.find(n => !fs.existsSync(path.join(dir, n))) || `${base}-${Date.now()}.pdf`;

      fs.writeFileSync(path.join(dir, name), buf);
      return sendJson(res, 200, { status: 'filed', name: origName, filed: name, year: Y,
        message: `Filed as ${Y}/${name}${rec.holder ? ` (${rec.holder})` : ''}` });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', name: origName, message: String((e && e.message) || e) });
    }
  });
}

// ---- manual downline overrides ----
// Persists the user's add/remove choices into config.json (downline_include /
// downline_exclude) so the aggregation honours them. Body: {include:[], exclude:[]}.
function handleDownlineOverrides(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const clean = a => Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string' && x.trim()))] : [];
      const cfg = loadConfig();
      cfg.downline_include = clean(o.include);
      cfg.downline_exclude = clean(o.exclude);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', include: cfg.downline_include, exclude: cfg.downline_exclude });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// ---- downline hierarchy (drag-to-nest) ----
// Persists the parent-of map into config.json (downline_parents { child: parent }).
function handleDownlineHierarchy(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const parents = {};
      if (o.parents && typeof o.parents === 'object') {
        for (const [k, v] of Object.entries(o.parents)) {
          if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim() && k !== v) parents[k] = v;
        }
      }
      const cfg = loadConfig();
      cfg.downline_parents = parents;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', parents });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// ---- goals (annual net-paid target per year) ----
// Persists an optional Anthropic API key into config.json (ai_key) so AI insights can be enabled
// from the UI without editing files. Stays on this machine; only sent to the AI API when you ask.
function handleAiKey(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e5) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const cfg = loadConfig();
      const key = String(o.ai_key == null ? '' : o.ai_key).trim();
      if (key) cfg.ai_key = key.slice(0, 200); else delete cfg.ai_key;   // empty clears it
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', configured: !!cfg.ai_key || !!process.env.ANTHROPIC_API_KEY });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// Marks a cadence gap as "not missing" (or restores it) in config.dismissed_gaps ["after|before"].
function handleDismissGap(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e5) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const cfg = loadConfig();
      let list = Array.isArray(cfg.dismissed_gaps) ? cfg.dismissed_gaps.map(String) : [];
      const a = String(o.after || ''), b = String(o.before || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)) {
        const key = a + '|' + b;
        if (o.undismiss) list = list.filter(k => k !== key);
        else if (!list.includes(key)) list.push(key);
      }
      cfg.dismissed_gaps = list.slice(0, 1000);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', dismissed_gaps: cfg.dismissed_gaps });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// Persists the "teach the carrier" map into config.json as carrier_map [{kw,name}].
function handleCarrierMap(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const cfg = loadConfig();
      const map = Array.isArray(o.carrier_map) ? o.carrier_map
        .filter(m => m && m.kw && m.name)
        .map(m => ({ kw: String(m.kw).slice(0, 40), name: String(m.name).slice(0, 60) }))
        .slice(0, 100) : [];
      cfg.carrier_map = map;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', carrier_map: map });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// Persists into config.json as goals { "<year>": { net: <number> } }.
function handleGoals(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const cfg = loadConfig();
      const goals = (cfg.goals && typeof cfg.goals === 'object') ? cfg.goals : {};
      const year = String(parseInt(o.year, 10));
      const net = Number(o.net);
      if (!/^\d{4}$/.test(year)) throw new Error('invalid year');
      if (!isFinite(net) || net < 0) { delete goals[year]; }         // clearing the goal
      else { goals[year] = { net: Math.round(net) }; }
      cfg.goals = goals;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', goals });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// ---- expenses (business costs per year, for true-net / ROI / cost-per-acquisition) ----
// Persists into config.json as expenses { "<year>": { leads, marketing, eo, crm, staff, other } }.
function handleExpenses(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const cfg = loadConfig();
      const all = (cfg.expenses && typeof cfg.expenses === 'object') ? cfg.expenses : {};
      const year = String(parseInt(o.year, 10));
      if (!/^\d{4}$/.test(year)) throw new Error('invalid year');
      const KEYS = ['leads', 'marketing', 'eo', 'crm', 'staff', 'other'];
      const src = (o.expenses && typeof o.expenses === 'object') ? o.expenses : {};
      const clean = {}; let any = false;
      for (const k of KEYS) { const n = Number(src[k]); if (isFinite(n) && n > 0) { clean[k] = Math.round(n); any = true; } }
      if (any) all[year] = clean; else delete all[year];
      cfg.expenses = all;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', expenses: all });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

// ---- user profile (things that shouldn't be re-entered each launch: convention level, ...) ----
// Persists into config.json under profile { convention_level, ... }. Goals and expenses
// already persist in the same file, so config.json is the single saved profile.
function handleProfile(req, res) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('end', () => {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const cfg = loadConfig();
      const profile = (cfg.profile && typeof cfg.profile === 'object') ? cfg.profile : {};
      if ('convention_level' in o) {
        const lv = Number(o.convention_level);
        if (isFinite(lv) && lv >= 1 && lv <= 10) profile.convention_level = lv;
        else delete profile.convention_level;
      }
      if ('self_names' in o) {
        const arr = Array.isArray(o.self_names) ? o.self_names : String(o.self_names || '').split(',');
        const clean = [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
        if (clean.length) profile.self_names = clean; else delete profile.self_names;
      }
      if ('convention_pay_lag_days' in o) {
        const d = Number(o.convention_pay_lag_days);
        if (isFinite(d) && d >= 0 && d <= 180) profile.convention_pay_lag_days = Math.round(d);
        else delete profile.convention_pay_lag_days;
      }
      if ('tax' in o && o.tax && typeof o.tax === 'object') {
        profile.tax = Object.assign({}, profile.tax, o.tax);
      }
      for (const key of ['convention_exclude', 'convention_include']) {
        if (key in o) {
          const arr = Array.isArray(o[key]) ? o[key] : [];
          const clean = [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
          if (clean.length) profile[key] = clean; else delete profile[key];
        }
      }
      cfg.profile = profile;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return sendJson(res, 200, { status: 'ok', profile });
    } catch (e) {
      return sendJson(res, 400, { status: 'error', message: String((e && e.message) || e) });
    }
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'index.html')));
    }
    if (url === '/api/upload' && req.method === 'POST') {
      return handleUpload(req, res);
    }
    if (url === '/api/downline-overrides' && req.method === 'POST') {
      return handleDownlineOverrides(req, res);
    }
    if (url === '/api/downline-hierarchy' && req.method === 'POST') {
      return handleDownlineHierarchy(req, res);
    }
    if (url === '/api/goals' && req.method === 'POST') {
      return handleGoals(req, res);
    }
    if (url === '/api/carrier-map' && req.method === 'POST') {
      return handleCarrierMap(req, res);
    }
    if (url === '/api/dismiss-gap' && req.method === 'POST') {
      return handleDismissGap(req, res);
    }
    if (url === '/api/ai-key' && req.method === 'POST') {
      return handleAiKey(req, res);
    }
    if (url === '/api/expenses' && req.method === 'POST') {
      return handleExpenses(req, res);
    }
    if (url === '/api/profile' && req.method === 'POST') {
      return handleProfile(req, res);
    }
    if (url === '/api/data') {
      const records = loadStatements();
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      // Optional holder "view": combine the personal + LLC books (default) or show just one.
      // Not persisted — it's a per-request lens, so a shared config.json stays untouched.
      const cfg = { ...loadConfig(), holder: params.get('holder') || '__all__' };
      return send(res, 200, 'application/json', JSON.stringify(buildSummary(records, cfg)));
    }
    // AI insights (optional, local-by-default): rule-based anomalies always; LLM summary/chat only
    // if a key is set (ANTHROPIC_API_KEY env var or "ai_key" in config.json). The digest is built
    // server-side from your own statements — nothing leaves the machine unless a key is set.
    if (url === '/api/ai' && req.method === 'POST') {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
      req.on('error', () => {});
      req.on('end', async () => {
        let o = {}; try { o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        try {
          const cfg = loadConfig(); ai.setKey(cfg.ai_key);
          const summary = buildSummary(loadStatements(), cfg);
          if (o.mode === 'anomalies') return sendJson(res, 200, { configured: ai.isConfigured(), anomalies: ai.anomalies(summary) });
          if (o.mode === 'ask') return sendJson(res, 200, await ai.ask(summary, o.question));
          return sendJson(res, 200, await ai.summary(summary));
        } catch (e) { return sendJson(res, 200, { configured: ai.isConfigured(), error: String((e && e.message) || e), anomalies: [] }); }
      });
      return;
    }
    if (url === '/api/export') {
      const records = loadStatements();
      const buf = buildWorkbook(buildSummary(records, loadConfig()));
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="commissions-${stamp}.xlsx"`,
      });
      return res.end(buf);
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => {
  console.log('Roost running at  http://127.0.0.1:' + PORT);
  console.log('Scanning year folders under:', statementsDir());
  // Parse statements once at startup so the cache is warm and the per-client
  // spreadsheets under Commissions/Clients/ are generated right away.
  try { loadStatements(); } catch (e) { console.warn('  Startup scan failed:', e.message); }
});
