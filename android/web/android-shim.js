/* Roost for Android: stands in for the Claude artifact runtime that Roost Mobile was built for.
 * window.claude.use(...) answers with phone-side versions of the same capabilities:
 *   db        -> statements and settings saved privately in the app on this phone
 *   mcp       -> "Google Drive" sync reads roost-sync.json.gz through the Android file picker
 *   downloads -> saves to the phone's Downloads folder
 *   sample    -> not available (no Claude inside the app), so AI summary/ask stay off
 * window.RoostAndroid is the native bridge (MainActivity.Bridge). */
(function () {
  'use strict';
  var B = window.RoostAndroid;
  if (!B) return;

  // ---------- db: a small document store, persisted by the app ----------
  var store = {};
  try { store = JSON.parse(B.load() || '{}') || {}; } catch (e) { store = {}; }
  var listeners = [];
  var saveTimer = null, notifyTimer = null;
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400); }
  function flush() { clearTimeout(saveTimer); saveTimer = null; try { B.save(JSON.stringify(store)); } catch (e) {} }
  document.addEventListener('visibilitychange', function () { if (document.hidden && saveTimer) flush(); });
  window.addEventListener('pagehide', function () { if (saveTimer) flush(); });
  function copy(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function docSnap(path) {
    var has = Object.prototype.hasOwnProperty.call(store, path);
    return { id: path.split('/').pop(), exists: has, data: function () { return has ? copy(store[path]) : undefined; } };
  }
  function colSnap(col) {
    var pre = col + '/', docs = [];
    Object.keys(store).forEach(function (p) { if (p.indexOf(pre) === 0 && p.indexOf('/', pre.length) < 0) docs.push(docSnap(p)); });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function emit(l) { try { l.cb(l.kind === 'doc' ? docSnap(l.path) : colSnap(l.path)); } catch (e) { console.error(e); } }
  var dirty = {};
  function changed(path) {
    dirty[path] = 1;
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(function () {
      var d = dirty; dirty = {};
      listeners.forEach(function (l) {
        var hit = Object.keys(d).some(function (p) { return l.kind === 'doc' ? p === l.path : p.indexOf(l.path + '/') === 0; });
        if (hit) emit(l);
      });
    }, 30);
  }
  function listen(kind, path, cb) {
    var l = { kind: kind, path: path, cb: cb }; listeners.push(l);
    setTimeout(function () { emit(l); }, 0);
    return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path: path,
      get: function () { return Promise.resolve(docSnap(path)); },
      set: function (obj) { store[path] = copy(obj); persist(); changed(path); return Promise.resolve(); },
      update: function (obj) { store[path] = Object.assign({}, store[path] || {}, copy(obj)); persist(); changed(path); return Promise.resolve(); },
      delete: function () { delete store[path]; persist(); changed(path); return Promise.resolve(); },
      onSnapshot: function (cb) { return listen('doc', path, cb); }
    };
  }
  function colRef(name) {
    return {
      id: name, path: name,
      doc: function (id) { return docRef(name + '/' + id); },
      get: function () { return Promise.resolve(colSnap(name)); },
      onSnapshot: function (cb) { return listen('col', name, cb); }
    };
  }
  var db = { doc: docRef, collection: colRef };

  // ---------- "Google Drive" sync via the Android file picker ----------
  var cbs = {}, cbN = 0;
  window.__roostCb = function (id, result) { var f = cbs[id]; delete cbs[id]; if (f) f(result); };
  function nativeAsync(method) {
    return new Promise(function (resolve) { var id = 'c' + (++cbN); cbs[id] = resolve; B[method](id); });
  }
  var mcp = {
    callTool: async function (server, tool) {
      if (server !== 'Google Drive') throw { code: 'server_not_connected', message: server + ' isn’t available in the Android app' };
      if (tool === 'search_files') {
        var info = null; try { info = JSON.parse(B.syncFileInfo() || 'null'); } catch (e) {}
        if (!info) {
          if (window.RM && RM.toast) RM.toast('Pick roost-sync.json.gz in your Google Drive (Roost Mobile folder)', 5000);
          try { info = JSON.parse((await nativeAsync('pickSyncFile')) || 'null'); } catch (e) { info = null; }
        }
        return { payload: { files: info ? [{ id: 'android-sync-file', name: info.name, modifiedTime: info.modified || null }] : [] } };
      }
      if (tool === 'download_file_content') {
        var b64 = B.readSyncFile();
        if (!b64) { B.clearSyncFile(); throw { code: 'upstream_error', message: 'couldn’t read the sync file. Tap Sync again to pick it.' }; }
        if (b64.slice(0, 3) !== 'H4s') { B.clearSyncFile(); throw { code: 'upstream_error', message: 'that isn’t roost-sync.json.gz. Tap Sync again and pick that file.' }; } // not gzip
        return { payload: { content: b64 } };
      }
      throw { code: 'not_in_manifest', message: tool + ' isn’t available' };
    },
    invalidate: async function () {}
  };

  // ---------- downloads -> phone's Downloads folder ----------
  function bytesToB64(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  var downloads = {
    save: async function (o) {
      var data = o.data instanceof Uint8Array ? o.data : new Uint8Array(o.data && o.data.buffer ? o.data.buffer : o.data);
      var r = B.saveDownload(String(o.filename || 'roost-export'), bytesToB64(data));
      if (r !== 'ok') throw { code: 'error', message: r };
      if (window.RM && RM.toast) RM.toast('Saved to Downloads: ' + o.filename, 4000);
      return { ok: true };
    }
  };

  window.claude = {
    use: async function (name) {
      if (name === 'db') return db;
      if (name === 'mcp') return mcp;
      if (name === 'downloads') return downloads;
      return null;   // 'sample' (Claude AI) isn't available outside claude.ai
    }
  };
  window.RoostAndroidInfo = { version: B.version() };
})();
