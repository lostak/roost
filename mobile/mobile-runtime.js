/* Roost Mobile runtime.
 * Runs Roost's desktop UI unchanged and answers its fetch('/api/...') calls in the browser:
 * statements and settings live in this artifact's private (owner-only) database, the math is
 * Roost's own aggregate.js, PDFs are parsed with Roost's own parser and then dropped.
 * Sync pulls roost-sync.json.gz (written by Roost on the laptop into Google Drive). */
(function () {
  'use strict';
  var core = window.RoostCore;
  var Buffer = window.RoostBuffer;
  var COL = 'stmts', CFG_DOC = 'settings/roost-config', SYNC_DOC = 'settings/laptop-sync', FEEDBACK = 'feedback';
  var DRIVE = 'Google Drive', SYNC_NAME = 'roost-sync.json.gz';
  var CFG_KEYS = ['carrier_map', 'ma_reclass', 'downline_include', 'downline_exclude', 'downline_parents', 'goals', 'expenses', 'profile', 'dismissed_gaps'];
  var REC_KEYS = ['file', 'holder', 'date', 'year', 'pending', 'paid', 'no_pay_reason', 'pay_period_net', 'advances_total', 'residual_total',
    'chargebacks_total', 'pending_total', 'ytd_advances', 'ytd_commission', 'ytd_chargebacks', 'ytd_total', 'items', 'no_text'];

  var RM = window.RM = { db: null, col: null, recs: [], byId: {}, cfg: {}, syncMeta: null, ready: false, err: null, busy: 0 };
  var readyResolve; RM.readyP = new Promise(function (r) { readyResolve = r; });

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Key-order-independent JSON, so "same settings" compares equal however the store orders keys.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }
  function pickCfg(o) { var c = {}; CFG_KEYS.forEach(function (k) { if (o && o[k] !== undefined) c[k] = clone(o[k]); }); return c; }
  function isRoostConfig(o) { return o && !Array.isArray(o) && typeof o === 'object' && CFG_KEYS.concat(['statements_dir', 'ai_key']).some(function (k) { return k in o; }); }
  function recId(r) {
    var raw = [r.date || 'nodate', r.holder || '', r.pending ? 'P' : 'S', Math.round((r.pay_period_net || 0) * 100)].join('_');
    return ('s_' + raw.replace(/[^A-Za-z0-9_\-.~:@+]/g, '-')).slice(0, 190);
  }
  function cleanRec(r) {
    var o = {}; REC_KEYS.forEach(function (k) { if (r[k] !== undefined) o[k] = r[k]; });
    o.items = (o.items || []).map(function (it) {
      return { section: it.section, policy: it.policy, client: it.client, product: it.product, carrier: it.carrier,
        premium: it.premium, comm_pct: it.comm_pct, payable: it.payable, agents: it.agents || [] };
    });
    return JSON.parse(JSON.stringify(o));
  }
  function recSig(r) { return stable(cleanRec(r)); }   // storage may reorder keys; compare by content
  function niceWhen(iso) { if (!iso) return 'an unknown time'; var d = new Date(iso); if (isNaN(d)) return String(iso); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function shortDate(iso) { if (!iso) return '—'; var p = iso.split('-'); return +p[1] + '/' + (+p[2]) + '/' + p[0].slice(2); }
  function money2(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toast(msg, ms) {
    var t = $('rmToast'); if (!t) return; t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 3000);
  }
  RM.toast = toast;
  function sortedRecs() { return RM.recs.slice(); }

  // ---------- data layer ----------
  var reloadTimer = null, gotRecs = false, gotCfg = false;
  function scheduleReload() {
    if (!RM.ready || RM.busy) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () { if (!RM.busy && typeof window.loadData === 'function') window.loadData(false); }, 700);
  }
  function maybeReady() {
    if (RM.ready || !gotRecs || !gotCfg) return;
    RM.ready = true; readyResolve();
  }
  async function initDb() {
    var db = null;
    try { db = await claude.use('db'); } catch (e) {}
    if (!db) { RM.err = 'nostore'; RM.ready = true; readyResolve(); return; }
    RM.db = db; RM.col = db.collection(COL);
    var to = setTimeout(function () { if (!RM.ready) { RM.err = 'slow'; RM.ready = true; readyResolve(); } }, 15000);
    db.doc(CFG_DOC).onSnapshot(function (d) {
      var v = d.exists ? d.data() : null;
      var next = v && v.config ? v.config : {}, j = stable(next);
      RM.cfgMeta = v ? { saved_at: v.saved_at, source: v.source } : null;
      var changed = j !== RM.cfgJson;
      RM.cfg = next; RM.cfgJson = j;
      gotCfg = true; maybeReady(); if (changed) scheduleReload(); updateSyncUi();
    }, function () { gotCfg = true; maybeReady(); });
    db.doc(SYNC_DOC).onSnapshot(function (d) { RM.syncMeta = d.exists ? d.data() : null; updateSyncUi(); }, function () {});
    RM.col.onSnapshot(function (snap) {
      var byId = {}, list = [];
      snap.docs.forEach(function (d) { var r = d.data(); if (r && r.date) { byId[d.id] = r; list.push(r); } });
      list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      var sig = list.length + '|' + Object.keys(byId).sort().map(function (id) { return id + ':' + (byId[id].saved_at || ''); }).join(',');
      var changed = sig !== RM.recSig;
      RM.byId = byId; RM.recs = list; RM.recSig = sig;
      if (!snap.metadata.fromCache) clearTimeout(to);
      gotRecs = true; maybeReady(); if (changed) scheduleReload(); updateSyncUi();
    }, function (e) { RM.err = (e && e.code) || 'error'; gotRecs = true; maybeReady(); });
  }

  // One config write at a time; each applies a mutation to the latest config.
  var cfgQ = Promise.resolve();
  function saveCfg(mutate, source) {
    var p = cfgQ.then(async function () {
      if (!RM.db) throw new Error('Storage isn’t connected — open Roost Mobile signed in to Claude.');
      var c = clone(RM.cfg); var out = mutate(c);
      var j = stable(c);
      if (j === RM.cfgJson) return out === undefined ? c : out;   // nothing changed: don't write
      RM.cfg = c; RM.cfgJson = j;                                   // our own echo won't trigger a reload
      await RM.db.doc(CFG_DOC).set({ config: c, saved_at: new Date().toISOString(), source: source || 'mobile' });
      return out === undefined ? c : out;
    });
    cfgQ = p.catch(function () {});
    return p;
  }

  // Writes records (new or changed). Records carry origin 'laptop' or 'mobile'.
  async function putRecords(list, origin, opts) {
    opts = opts || {};
    var added = 0, updated = 0, same = 0, failed = 0, errMsg = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i], id = recId(r), cur = RM.byId[id];
      if (cur && recSig(cur) === recSig(r) && (cur.origin || 'laptop') === origin) { same++; continue; }
      if (cur && opts.keepExisting) { same++; continue; }
      var doc = cleanRec(r); doc.origin = origin; doc.saved_at = new Date().toISOString();
      try { await RM.col.doc(id).set(doc); RM.byId[id] = doc; cur ? updated++ : added++; }
      catch (e) {
        if (e && e.code === 'unavailable') {
          await new Promise(function (res) { setTimeout(res, 400 + Math.random() * 600); });
          try { await RM.col.doc(id).set(doc); RM.byId[id] = doc; cur ? updated++ : added++; continue; } catch (e2) { e = e2; }
        }
        failed++; errMsg = (e && (e.message || e.code)) || String(e);
        if (e && (e.code === 'quota_exceeded' || e.code === 'revoked' || e.code === 'permission_denied')) break;
      }
    }
    return { added: added, updated: updated, same: same, failed: failed, error: errMsg };
  }

  // ---------- the desktop API, answered in the browser ----------
  function body(init) { try { return JSON.parse(init && typeof init.body === 'string' ? init.body : '{}') || {}; } catch (e) { return {}; } }
  function summaryFor(holder) {
    var cfg = Object.assign({}, RM.cfg);
    if (holder) cfg.holder = holder;
    return core.buildSummary(sortedRecs(), cfg);
  }
  async function sampleFn() { try { return await claude.use('sample'); } catch (e) { return null; } }
  async function askClaude(system, userText) {
    var sample = await sampleFn();
    if (!sample) return { configured: false };
    try {
      var r = await sample([{ role: 'user', content: system + '\n\n' + userText }]);
      return { configured: true, text: (r && r.text) || '(no response)' };
    } catch (e) {
      if (e && e.code === 'not_granted') return { configured: false };
      return { configured: true, error: e && e.code === 'rate_limited' ? 'Too many requests just now — try again in a minute.' : ((e && e.message) || 'AI request failed') };
    }
  }

  var API = {
    '/api/data': async function (init, qs) {
      await RM.readyP;
      if (RM.err === 'nostore') throw new Error('Storage isn’t available. Open Roost Mobile on claude.ai, signed in.');
      var s = summaryFor(qs.get('holder') || '__all__');
      s.dev_unlocked = false;
      return s;
    },
    '/api/goals': function (init) {
      var o = body(init);
      return saveCfg(function (cfg) {
        var goals = (cfg.goals && typeof cfg.goals === 'object') ? cfg.goals : {};
        var year = String(parseInt(o.year, 10)), net = Number(o.net);
        if (!/^\d{4}$/.test(year)) throw new Error('invalid year');
        if (!isFinite(net) || net < 0) delete goals[year]; else goals[year] = { net: Math.round(net) };
        cfg.goals = goals; return { status: 'ok', goals: goals };
      });
    },
    '/api/expenses': function (init) {
      var o = body(init);
      return saveCfg(function (cfg) {
        var all = (cfg.expenses && typeof cfg.expenses === 'object') ? cfg.expenses : {};
        var year = String(parseInt(o.year, 10));
        if (!/^\d{4}$/.test(year)) throw new Error('invalid year');
        var src = (o.expenses && typeof o.expenses === 'object') ? o.expenses : {}, clean = {}, any = false;
        ['leads', 'marketing', 'eo', 'crm', 'staff', 'other'].forEach(function (k) { var n = Number(src[k]); if (isFinite(n) && n > 0) { clean[k] = Math.round(n); any = true; } });
        if (any) all[year] = clean; else delete all[year];
        cfg.expenses = all; return { status: 'ok', expenses: all };
      });
    },
    '/api/profile': function (init) {
      var o = body(init);
      return saveCfg(function (cfg) {
        var profile = (cfg.profile && typeof cfg.profile === 'object') ? cfg.profile : {};
        var uniq = function (arr) { var seen = {}, out = []; arr.forEach(function (x) { x = String(x).trim(); if (x && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; };
        if ('convention_level' in o) { var lv = Number(o.convention_level); if (isFinite(lv) && lv >= 1 && lv <= 10) profile.convention_level = lv; else delete profile.convention_level; }
        if ('self_names' in o) { var c1 = uniq(Array.isArray(o.self_names) ? o.self_names : String(o.self_names || '').split(',')); if (c1.length) profile.self_names = c1; else delete profile.self_names; }
        if ('convention_pay_lag_days' in o) { var d = Number(o.convention_pay_lag_days); if (isFinite(d) && d >= 0 && d <= 180) profile.convention_pay_lag_days = Math.round(d); else delete profile.convention_pay_lag_days; }
        if ('tax' in o && o.tax && typeof o.tax === 'object') profile.tax = Object.assign({}, profile.tax, o.tax);
        ['convention_exclude', 'convention_include'].forEach(function (key) {
          if (key in o) { var c2 = uniq(Array.isArray(o[key]) ? o[key] : []); if (c2.length) profile[key] = c2; else delete profile[key]; }
        });
        cfg.profile = profile; return { status: 'ok', profile: profile };
      });
    },
    '/api/carrier-map': function (init) {
      var o = body(init);
      return saveCfg(function (cfg) {
        var map = Array.isArray(o.carrier_map) ? o.carrier_map.filter(function (m) { return m && m.kw && m.name; })
          .map(function (m) { return { kw: String(m.kw).slice(0, 40), name: String(m.name).slice(0, 60) }; }).slice(0, 100) : [];
        cfg.carrier_map = map; return { status: 'ok', carrier_map: map };
      });
    },
    '/api/dismiss-gap': function (init) {
      var o = body(init);
      return saveCfg(function (cfg) {
        var list = Array.isArray(cfg.dismissed_gaps) ? cfg.dismissed_gaps.map(String) : [];
        var a = String(o.after || ''), b = String(o.before || '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)) {
          var key = a + '|' + b;
          if (o.undismiss) list = list.filter(function (k) { return k !== key; });
          else if (list.indexOf(key) < 0) list.push(key);
        }
        cfg.dismissed_gaps = list.slice(0, 1000); return { status: 'ok', dismissed_gaps: cfg.dismissed_gaps };
      });
    },
    '/api/downline-overrides': function (init) {
      var o = body(init);
      var clean = function (a) { if (!Array.isArray(a)) return []; var seen = {}, out = []; a.forEach(function (x) { if (typeof x === 'string' && x.trim() && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; };
      return saveCfg(function (cfg) {
        cfg.downline_include = clean(o.include); cfg.downline_exclude = clean(o.exclude);
        return { status: 'ok', include: cfg.downline_include, exclude: cfg.downline_exclude };
      });
    },
    '/api/downline-hierarchy': function (init) {
      var o = body(init);
      return saveCfg(function (cfg) {
        var parents = {};
        if (o.parents && typeof o.parents === 'object') Object.keys(o.parents).forEach(function (k) {
          var v = o.parents[k]; if (typeof v === 'string' && k.trim() && v.trim() && k !== v) parents[k] = v;
        });
        cfg.downline_parents = parents; return { status: 'ok', parents: parents };
      });
    },
    '/api/ai-key': async function () { return { status: 'ok', configured: !!(await sampleFn()) }; },
    '/api/ai': async function (init) {
      var o = body(init); await RM.readyP;
      var s = summaryFor(null), A = core.ai, anoms = A.anomalies(s);
      if (o.mode === 'anomalies') return { configured: !!(await sampleFn()), anomalies: anoms };
      if (o.mode === 'ask') return askClaude(A.SYSTEM_ASK, 'My book:\n\n' + A.bookFacts(s) + '\n\nMy question: ' + String(o.question || '').slice(0, 500));
      var r = await askClaude(A.SYSTEM_SUMMARY, 'Here is my book:\n\n' + A.bookFacts(s) +
        '\n\nGive me a 2-3 sentence plain-English summary of where my book stands, then 3 short bullet insights (what\'s going well, what to watch, the single best next move). Be specific with my numbers.');
      r.anomalies = anoms; return r;
    },
    '/api/upload': async function (init, qs) {
      var name = qs.get('name') || 'upload.pdf';
      if (!RM.col) return { _status: 503, status: 'error', name: name, message: 'Storage isn’t connected — open Roost Mobile signed in to Claude.' };
      var bytes = new Uint8Array(await init.body.arrayBuffer());
      var head = String.fromCharCode.apply(null, bytes.subarray(0, 5));
      if (head !== '%PDF-') return { _status: 400, status: 'error', name: name, message: 'Not a PDF file' };
      var rec = null; try { rec = core.parsePdfBuffer(Buffer.from(bytes), name); } catch (e) {}
      bytes = null; // the PDF itself is never stored
      if (rec && rec.no_text) return { _status: 422, status: 'error', name: name, message: 'No readable text — this looks like a scanned image.' };
      if (!rec || !rec.date) return { _status: 422, status: 'error', name: name, message: 'Could not read a statement date from this PDF. Make sure it’s a commission statement.' };
      var id = recId(rec);
      if (RM.byId[id]) return { status: 'duplicate', name: name, message: 'Already in Roost (' + shortDate(rec.date) + (rec.holder ? ', ' + rec.holder : '') + ')' };
      RM.busy++;
      try {
        var r = await putRecords([rec], 'mobile');
        if (r.failed) return { _status: 500, status: 'error', name: name, message: 'Couldn’t save: ' + r.error };
      } finally { RM.busy--; }
      return { status: 'filed', name: name, year: rec.year, message: 'Saved ' + shortDate(rec.date) + ' · ' + money2(rec.pay_period_net) + (rec.holder ? ' (' + rec.holder + ')' : '') };
    },
    '/api/organize': async function () { return { scanned: 0, renamed: [], moved: [], duplicates: [], errors: [] }; },
    '/api/contact': async function (init) {
      var o = body(init), kind = o.kind === 'feature' ? 'feature' : 'bug';
      var message = String(o.message || '').slice(0, 5000).trim();
      if (message.length < 3) return { _status: 400, status: 'error', message: 'Please include a short description.' };
      if (!RM.db) return { _status: 503, status: 'error', message: 'Storage isn’t connected.' };
      await RM.db.collection(FEEDBACK).doc('f_' + Date.now()).set({ at: new Date().toISOString(), kind: kind, message: message, from_email: String(o.email || '').slice(0, 200).trim(), from: 'Roost Mobile' });
      return { status: 'ok', message: 'Saved in Roost Mobile. Your phone can’t send it on — Claude can forward it, or send it from Roost on the laptop.' };
    },
    '/api/dev-unlock': async function () { return { status: 'ok', unlocked: false, message: 'Developer mode is only in Roost on the laptop.' }; }
  };

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var path = url.split('?')[0];
    if (path.indexOf('/api/') !== 0) return realFetch(input, init);
    var qs = new URLSearchParams(url.split('?')[1] || '');
    var h = API[path];
    var mk = function (status, obj) { return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } }); };
    if (!h) return Promise.resolve(mk(404, { status: 'error', message: 'Not available in Roost Mobile' }));
    return Promise.resolve().then(function () { return h(init || {}, qs); }).then(function (res) {
      var st = (res && res._status) || 200; if (res && res._status) delete res._status; return mk(st, res);
    }, function (e) { return mk(400, { status: 'error', message: String((e && e.message) || e) }); });
  };

  // ---------- Excel export (Roost's own workbook) ----------
  RM.exportXlsx = async function () {
    await RM.readyP;
    var dl = null; try { dl = await claude.use('downloads'); } catch (e) {}
    if (!dl) { toast('Downloads aren’t available in this view'); return; }
    try {
      var buf = core.buildWorkbook(summaryFor(null));
      var u8 = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      await dl.save({ filename: 'commissions-' + new Date().toISOString().slice(0, 10) + '.xlsx', data: u8 });
    } catch (e) {
      if (e && e.code === 'declined') return;
      toast(e && e.code === 'rate_limited' ? 'A save is already open' : 'Export failed: ' + ((e && e.message) || e));
    }
  };

  // ---------- Sync from laptop (Google Drive) ----------
  function b64ToBytes(b64) { var bin = atob(String(b64).replace(/\s+/g, '')), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function driveErrText(e) {
    var c = e && e.code;
    if (c === 'server_not_connected' || c === 'selection_required') return 'Google Drive isn’t connected. Add it in claude.ai Settings → Connectors, then try again.';
    if (c === 'needs_reauth') return 'Google Drive needs reconnecting in claude.ai Settings → Connectors.';
    if (c === 'not_in_manifest' || c === 'approval_required' || c === 'consent_required') return 'Roost Mobile needs your OK to read Google Drive. Tap Sync again and choose Allow.';
    if (c === 'blocked_by_policy') return 'Your organization blocks Google Drive here.';
    if (c === 'server_unavailable' || c === 'upstream_error') return 'Google Drive didn’t answer. Try again in a moment.';
    if (c === 'not_granted' || c === 'capability_disabled' || c === 'capability_removed') return 'Sync isn’t available in this view. Open Roost Mobile on claude.ai.';
    return (e && e.message) ? 'Sync failed: ' + e.message : 'Sync failed.';
  }
  // Three-way merge per settings section: take the laptop's value only where the laptop changed it
  // since the last sync, so settings edited on the phone aren't overwritten.
  function mergeCfg(mobile, laptopNow, laptopLast) {
    var out = clone(mobile), changed = [];
    CFG_KEYS.forEach(function (k) {
      var now = stable(laptopNow[k]), last = laptopLast ? stable(laptopLast[k]) : undefined;
      if (laptopLast && now === last) return;                 // laptop didn't touch it
      if (stable(out[k]) === now) return;                      // already the same
      if (laptopNow[k] === undefined) { if (laptopLast) { delete out[k]; changed.push(k); } return; }
      out[k] = clone(laptopNow[k]); changed.push(k);
    });
    return { cfg: out, changed: changed };
  }
  RM.sync = async function () {
    if (RM.syncing) return;
    var say = function (t, bad) { RM.syncStatus = { text: t, bad: !!bad }; updateSyncUi(); };
    await RM.readyP;
    if (!RM.col) { say('Storage isn’t connected — open Roost Mobile signed in to Claude.', true); return; }
    RM.syncing = true; RM.busy++; updateSyncUi();
    var changedAnything = false;
    try {
      var mcp = await claude.use('mcp');
      if (!mcp) throw { code: 'not_granted' };
      say('Looking in Google Drive…');
      var found = await mcp.callTool(DRIVE, 'search_files', { query: "title = '" + SYNC_NAME + "' and trashed = false", excludeContentSnippets: true, pageSize: 10 }, { cache: false });
      var files = ((found && found.payload && found.payload.files) || []).slice();
      if (!files.length) { say('No ' + SYNC_NAME + ' in your Google Drive yet. Set "mobile_sync_dir" in Roost’s config.json to a Google Drive folder, then open Roost on the laptop once.', true); return; }
      files.sort(function (a, b) { return (b.modifiedTime || '') < (a.modifiedTime || '') ? -1 : 1; });
      var f = files[0];
      say('Downloading…');
      var dl = await mcp.callTool(DRIVE, 'download_file_content', { fileId: f.id }, { cache: false });
      var b64 = dl && dl.payload && dl.payload.content;
      if (!b64) throw { message: 'the file came back empty' };
      var obj = JSON.parse(pako.ungzip(b64ToBytes(b64), { to: 'string' }));
      if (!obj || !Array.isArray(obj.records)) throw { message: 'that file isn’t a Roost sync file' };
      var meta = RM.syncMeta || {};

      // settings
      var cfgChanged = [];
      if (obj.config && typeof obj.config === 'object') {
        var laptopNow = pickCfg(obj.config);
        var m = mergeCfg(RM.cfg || {}, laptopNow, meta.laptop_cfg || null);
        cfgChanged = m.changed;
        if (cfgChanged.length) { await saveCfg(function (c) { CFG_KEYS.forEach(function (k) { if (m.cfg[k] === undefined) delete c[k]; else c[k] = m.cfg[k]; }); }, 'laptop sync'); changedAnything = true; }
      }

      // statements: add new, update changed, remove laptop statements the laptop no longer has
      say('Saving…');
      var recs = obj.records.filter(function (r) { return r && !r.error && r.date && Array.isArray(r.items); });
      var r = await putRecords(recs, 'laptop');
      var keep = {}; recs.forEach(function (x) { keep[recId(x)] = 1; });
      var gone = Object.keys(RM.byId).filter(function (id) { return !keep[id] && (RM.byId[id].origin || 'laptop') === 'laptop'; });
      var removed = 0, held = 0;
      var laptopCount = Object.keys(RM.byId).filter(function (id) { return (RM.byId[id].origin || 'laptop') === 'laptop'; }).length;
      if (gone.length && (gone.length <= 10 || gone.length <= laptopCount * 0.2)) {
        for (var i = 0; i < gone.length; i++) { try { await RM.col.doc(gone[i]).delete(); delete RM.byId[gone[i]]; removed++; } catch (e) {} }
      } else held = gone.length;
      if (r.added || r.updated || removed) changedAnything = true;

      if (!r.failed) {
        try { await RM.db.doc(SYNC_DOC).set({ fileId: f.id, modifiedTime: f.modifiedTime || null, made: obj.made || null, synced_at: new Date().toISOString(),
          added: r.added, updated: r.updated, removed: removed, total: recs.length, laptop_cfg: pickCfg(obj.config || {}) }); } catch (e) {}
      }
      var parts = [];
      if (r.added) parts.push(r.added + ' new');
      if (r.updated) parts.push(r.updated + ' updated');
      if (removed) parts.push(removed + ' removed');
      if (cfgChanged.length) parts.push('settings updated');
      var msg = parts.length ? parts.join(' · ') : 'Already up to date';
      if (r.failed) msg += ' · ' + r.failed + ' couldn’t be saved — tap Sync to retry';
      if (held) msg += ' · ' + held + ' statements missing from the laptop file were kept (too many to remove automatically)';
      say(msg + '. Laptop data from ' + niceWhen(obj.made || f.modifiedTime) + '.', !!r.failed);
      toast(parts.length ? 'Synced: ' + parts.join(', ') : 'Up to date');
    } catch (e) { say(driveErrText(e), true); }
    finally {
      RM.syncing = false; RM.busy--; updateSyncUi();
      if (changedAnything && typeof window.loadData === 'function') window.loadData(false);
    }
  };

  // ---------- manual import (cache / config.json) and data controls ----------
  function recordsFromJson(obj) {
    var out = [];
    if (Array.isArray(obj)) out = obj;
    else if (obj && Array.isArray(obj.records)) out = obj.records;
    else if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { var v = obj[k]; if (v && v.rec) out.push(v.rec); else if (v && v.date && v.items) out.push(v); });
    return out.filter(function (r) { return r && !r.error && r.date && Array.isArray(r.items); });
  }
  RM.importFiles = async function (files) {
    var say = function (t, bad) { RM.syncStatus = { text: t, bad: !!bad }; updateSyncUi(); };
    await RM.readyP;
    if (!RM.col) { say('Storage isn’t connected.', true); return; }
    RM.busy++; var notes = [], changed = false;
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        try {
          var obj = JSON.parse(await f.text());
          if (isRoostConfig(obj)) { var c = pickCfg(obj); await saveCfg(function (x) { CFG_KEYS.forEach(function (k) { if (c[k] !== undefined) x[k] = c[k]; }); }, f.name); notes.push(f.name + ': settings imported'); changed = true; continue; }
          var recs = recordsFromJson(obj);
          var r = await putRecords(recs, 'laptop', { keepExisting: true });
          notes.push(f.name + ': ' + r.added + ' added' + (r.failed ? ', ' + r.failed + ' failed' : ''));
          if (r.added) changed = true;
        } catch (e) { notes.push(f.name + ': not a Roost file'); }
      }
    } finally { RM.busy--; }
    say(notes.join(' · '));
    if (changed && typeof window.loadData === 'function') window.loadData(false);
  };
  RM.copyJson = function () {
    var txt = JSON.stringify({ exported: new Date().toISOString(), records: RM.recs, config: RM.cfg });
    navigator.clipboard.writeText(txt).then(function () { toast('Copied ' + RM.recs.length + ' statements'); }, function () { toast('Copy was blocked'); });
  };
  RM.wipe = async function () {
    var btn = $('rmWipeYes'); if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    RM.busy++; var n = 0;
    try {
      var ids = Object.keys(RM.byId);
      for (var i = 0; i < ids.length; i++) { try { await RM.col.doc(ids[i]).delete(); n++; } catch (e) {} }
      try { await RM.db.doc(CFG_DOC).delete(); } catch (e) {}
      try { await RM.db.doc(SYNC_DOC).delete(); } catch (e) {}
    } finally { RM.busy--; }
    toast('Deleted ' + n + ' statements'); RM.closeSync(); if (typeof window.loadData === 'function') window.loadData(true);
  };

  // ---------- Sync & data dialog ----------
  function countText() {
    var mob = RM.recs.filter(function (r) { return r.origin === 'mobile'; }).length;
    return RM.recs.length + ' statements' + (RM.recs.length ? ' (' + shortDate(RM.recs[0].date) + ' – ' + shortDate(RM.recs[RM.recs.length - 1].date) + ')' : '') + (mob ? ' · ' + mob + ' added on this phone' : '');
  }
  function updateSyncUi() {
    var b = $('rmSyncGo'); if (b) { b.disabled = !!RM.syncing; b.textContent = RM.syncing ? 'Syncing…' : 'Sync from laptop'; }
    var hb = $('rmSyncBtn'); if (hb) hb.classList.toggle('rm-spin', !!RM.syncing);
    var st = $('rmSyncStatus');
    if (st) {
      var t = RM.syncStatus ? RM.syncStatus.text : (RM.syncMeta ? 'Last synced ' + niceWhen(RM.syncMeta.synced_at) + ' · laptop data from ' + niceWhen(RM.syncMeta.made || RM.syncMeta.modifiedTime) : 'Pulls the latest statements and settings Roost saved to your Google Drive.');
      st.textContent = t; st.style.color = RM.syncStatus && RM.syncStatus.bad ? 'var(--error,#b3261e)' : '';
    }
    var c = $('rmCount'); if (c) c.textContent = countText();
  }
  RM.openSync = function () { var m = $('rmSyncModal'); if (!m) return; RM.syncStatus = null; updateSyncUi(); m.classList.add('open'); var w = $('rmWipeC'); if (w) w.style.display = 'none'; };
  RM.closeSync = function () { var m = $('rmSyncModal'); if (m) m.classList.remove('open'); };
  RM.syncNow = function () { RM.openSync(); RM.sync(); };

  document.addEventListener('DOMContentLoaded', function () {
    var inp = $('rmImport'); if (inp) inp.addEventListener('change', function () { if (inp.files.length) RM.importFiles([].slice.call(inp.files)).then(function () { inp.value = ''; }); });
    var m = $('rmSyncModal'); if (m) m.addEventListener('keydown', function (e) { if (e.key === 'Escape') RM.closeSync(); });
    // File organizing works on the laptop's folders; on the phone, say so instead.
    var org = $('organizeResult'); var card = org && org.closest('.card');
    if (card) card.innerHTML = '<h3>Organize files</h3><p class="hint">Renaming and re-filing statement PDFs runs in Roost on the laptop, where the files are. Statements added on this phone keep only their numbers.</p>';
    updateSyncUi();
  });

  initDb();
})();
