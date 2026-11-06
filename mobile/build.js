// Builds Roost Mobile from Roost's own source files.
//   node build.js <roost-src-dir> <out.html>
// Roost's index.html, aggregate/parser/pdftext/clients/xlsxlite/ai modules and server.js helpers
// are used unchanged; a small runtime answers the page's /api/* calls in the browser.
const fs = require('fs'), path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..');
const OUT = process.argv[3] || path.join(__dirname, 'dist', 'index.html');
const V = path.join(__dirname, 'vendor');
const read = p => fs.readFileSync(p, 'utf8');
const src = f => read(path.join(SRC, f));

// ---------- module bundle ----------
const mods = [];
const def = (name, code) => mods.push(`__def(${JSON.stringify(name)}, function (module, exports, require, Buffer) {\n${code}\n});`);
def('base64-js', read(path.join(V, 'base64-js-1.5.1/package/index.js')));
def('ieee754', read(path.join(V, 'ieee754-1.2.1/package/index.js')));
def('buffer', read(path.join(V, 'buffer-6.0.3/package/index.js')));
def('zlib', `
const u8 = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
module.exports = {
  inflateSync: b => Buffer.from(pako.inflate(u8(b))),
  inflateRawSync: b => Buffer.from(pako.inflateRaw(u8(b))),
  deflateRawSync: b => Buffer.from(pako.deflateRaw(u8(b))),
  gzipSync: b => Buffer.from(pako.gzip(u8(b))),
  gunzipSync: b => Buffer.from(pako.ungzip(u8(b))),
};`);
def('fs', `const no = () => { throw new Error('No file system in Roost Mobile'); };
module.exports = { readFileSync: no, writeFileSync: no, mkdirSync: no, existsSync: () => false, readdirSync: () => [], statSync: no };`);
def('path', `module.exports = { join: (...a) => a.join('/'), resolve: (...a) => a.join('/'), dirname: p => String(p).replace(/\\/[^/]*$/, ''), basename: p => String(p).split('/').pop() };`);
def('https', `module.exports = { request() { throw new Error('No direct network in Roost Mobile'); } };`);
for (const f of ['pdftext.js', 'parser.js', 'xlsxlite.js', 'clients.js', 'aggregate.js']) def(f, src(f));
def('ai.js', src('ai.js') + '\nmodule.exports.SYSTEM_SUMMARY = SYSTEM_SUMMARY; module.exports.SYSTEM_ASK = SYSTEM_ASK;\n');

// parsePdfBuffer + buildWorkbook come straight out of server.js so they stay in step with Roost.
const server = src('server.js');
const grab = name => {
  const i = server.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`server.js: ${name} not found`);
  const j = server.indexOf('\n}\n', i);
  return server.slice(i, j + 3);
};
def('server-bits.js', `
const { extractText, extractPages } = require('./pdftext.js');
const { buildXlsx } = require('./xlsxlite.js');
const { parseStatement, parseStatementNew, isNewFormat } = require('./parser.js');
${grab('parsePdfBuffer')}
${grab('buildWorkbook')}
module.exports = { parsePdfBuffer, buildWorkbook };`);

const bundle = `(function (global) {
var __defs = {}, __cache = {}, __Buffer;
var process = { env: {}, platform: 'browser', cwd: function () { return '/'; } };
function __def(name, fn) { __defs[name] = fn; }
function __req(name) {
  name = String(name).replace(/^\\.\\//, '');
  if (__cache[name]) return __cache[name].exports;
  if (!__defs[name]) throw new Error('Roost Mobile: missing module ' + name);
  var m = { exports: {} }; __cache[name] = m;
  __defs[name].call(m.exports, m, m.exports, __req, __Buffer);
  return m.exports;
}
${mods.join('\n')}
__Buffer = __req('buffer').Buffer;
global.RoostBuffer = __Buffer;
var A = __req('aggregate.js'), S = __req('server-bits.js');
global.RoostCore = { buildSummary: A.buildSummary, prepareRecords: A.prepareRecords,
  parsePdfBuffer: S.parsePdfBuffer, buildWorkbook: S.buildWorkbook, ai: __req('ai.js') };
})(window);`;

// ---------- page ----------
let html = src('index.html');
const swaps = [];
const rep = (a, b, label) => { if (!html.includes(a)) throw new Error('index.html changed — cannot find: ' + (label || a.slice(0, 80))); html = html.split(a).join(b); swaps.push(label || a.slice(0, 40)); };

// Runtime goes before Roost's own script so fetch('/api/...') is answered from the first call.
const runtime = [
  '<script>\n' + read(path.join(V, 'pako-2.1.0/package/dist/pako.min.js')) + '\n</script>',
  '<script>\n' + bundle + '\n</script>',
  '<script>\n' + read(path.join(__dirname, 'mobile-runtime.js')) + '\n</script>',
].join('\n');
const firstInline = html.indexOf('<script>');
if (firstInline < 0) throw new Error('no inline <script> in index.html');
html = html.slice(0, firstInline) + runtime + '\n' + html.slice(firstInline);

// Header: Sync button, export through the downloads capability.
rep('<button class="btn" onclick="openUpload()"><span>&#8613;</span> Upload</button>',
  '<button class="btn" id="rmSyncBtn" onclick="RM.syncNow()" title="Sync from laptop" aria-label="Sync from laptop"><span class="rm-ic">&#8645;</span><span class="rm-lbl"> Sync</span></button>\n  <button class="btn tonal" onclick="openUpload()" title="Upload statements" aria-label="Upload statements"><span>&#8613;</span><span class="rm-lbl"> Upload</span></button>', 'appbar upload');
rep('<button class="btn tonal" onclick="loadData(true)"><span>&#8635;</span> Refresh</button>',
  '<button class="btn tonal rm-desk" onclick="loadData(true)"><span>&#8635;</span> Refresh</button>', 'appbar refresh');
rep('<a class="btn tonal" href="/api/export"><span>&#8681;</span> Export Excel</a>',
  '<button class="btn tonal rm-desk" onclick="RM.exportXlsx()"><span>&#8681;</span> Export Excel</button>\n  <button class="btn ghost" onclick="RM.openSync()" title="Sync, export &amp; more" aria-label="Sync, export and more">&#9881;</button>', 'appbar export');
rep('<button class="btn ghost" onclick="startTour()" title="Take the tour" aria-label="Take the tour">',
  '<button class="btn ghost rm-desk" onclick="startTour()" title="Take the tour" aria-label="Take the tour">', 'appbar tour');
rep('<div style="position:relative;display:inline-flex">', '<div class="rm-desk" style="position:relative;display:inline-flex">', 'appbar palette');
rep('<button class="btn ghost" id="themeBtn" onclick="toggleTheme()"', '<button class="btn ghost rm-desk" id="themeBtn" onclick="toggleTheme()"', 'appbar theme');
rep("{type:'action',label:'Upload statements',ic:'&#8613;',run:openUpload}",
  "{type:'action',label:'Sync from laptop',ic:'&#8645;',run:()=>RM.syncNow()},{type:'action',label:'Sync, export & data settings',ic:'&#9881;',run:()=>RM.openSync()},{type:'action',label:'Upload statements',ic:'&#8613;',run:openUpload}", 'palette sync');
rep("run:()=>location.href='/api/export'", "run:()=>RM.exportXlsx()", 'palette export');

// Wording that only fits the laptop.
rep('each PDF is read and filed into the right year automatically',
  'each PDF is read right here &mdash; only the numbers are saved, never the file', 'upload hint');
rep('or drop PDFs into your Statements folder and click Refresh',
  'or tap <a href="#" onclick="RM.syncNow();return false" style="color:var(--accent);font-weight:600">Sync</a> to bring over everything Roost has on your laptop', 'first-run hint');
rep('Optional and local by default &mdash; nothing leaves this machine unless you set an API key and ask.',
  'In Roost Mobile the summary and chat are answered by Claude, only when you ask, using your book&rsquo;s numbers.', 'ai banner');

// Sync & data dialog + toast, placed with Roost's other dialogs.
const dialog = `
<div class="modal-overlay" id="rmSyncModal" onclick="if(event.target===this)RM.closeSync()">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Sync and data">
    <div class="modal-head"><h3>Sync &amp; data</h3><button class="modal-x" onclick="RM.closeSync()" aria-label="Close">&times;</button></div>
    <button class="btn" id="rmSyncGo" style="width:100%;justify-content:center" onclick="RM.sync()">Sync from laptop</button>
    <p class="hint" id="rmSyncStatus" style="margin:10px 2px 0"></p>
    <details style="margin-top:14px"><summary class="hint" style="cursor:pointer">How sync works</summary>
      <p class="hint" style="margin:8px 2px 0">Roost on the laptop saves <code>roost-sync.json.gz</code> to the Google Drive folder set as <code>mobile_sync_dir</code> in its config.json. Sync reads the newest copy through your Google Drive connector &mdash; the laptop doesn&rsquo;t need to be on. Statements added on this phone stay here; settings you change here are kept unless you change the same setting on the laptop.</p></details>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
      <button class="btn tonal" onclick="RM.closeSync();RM.exportXlsx()"><span>&#8681;</span> Export Excel</button>
      <button class="btn tonal" onclick="toggleTheme()">&#9680; Dark / light</button>
      <button class="btn ghost" onclick="RM.closeSync();startTour()">&#63; Take the tour</button>
    </div>
    <h4 style="margin:20px 0 6px">Import Roost files</h4>
    <p class="hint" style="margin:0 0 8px">No Google Drive set up? Pick <code>.parse_cache.json</code> and/or <code>config.json</code> from your Roost folder.</p>
    <label class="btn tonal" style="display:inline-flex;cursor:pointer">Choose files<input type="file" id="rmImport" accept=".json,application/json,text/plain" multiple hidden></label>
    <h4 style="margin:20px 0 6px">Your data</h4>
    <p class="hint" style="margin:0 0 8px"><span id="rmCount"></span>. Stored privately with Roost Mobile (only you can read it) and available on any device you&rsquo;re signed in to Claude on.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn ghost" onclick="RM.copyJson()">Copy data as JSON</button>
      <button class="btn ghost" style="color:var(--error,#b3261e)" onclick="document.getElementById('rmWipeC').style.display='block'">Delete all saved data</button>
    </div>
    <div id="rmWipeC" style="display:none;margin-top:10px" class="card">
      <p class="hint" style="margin:0 0 10px">Delete every statement and setting saved in Roost Mobile, on every device? Your laptop and its PDFs aren&rsquo;t touched.</p>
      <div style="display:flex;gap:8px"><button class="btn" id="rmWipeYes" style="background:var(--error,#b3261e)" onclick="RM.wipe()">Delete everything</button>
      <button class="btn ghost" onclick="document.getElementById('rmWipeC').style.display='none'">Cancel</button></div>
    </div>
  </div>
</div>
<div id="rmToast" role="status" aria-live="polite"></div>
<style>
#rmToast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;
  background:var(--on-surface,#111);color:var(--surface,#fff);padding:10px 16px;border-radius:12px;font-size:14px;z-index:9999;transition:.2s;max-width:90vw}
#rmToast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:640px){
  .appbar{flex-wrap:nowrap!important;gap:6px!important;padding:8px 10px!important}
  .appbar .rm-desk{display:none!important}
  .appbar .rm-lbl{display:none}
  .appbar .btn{padding-left:11px;padding-right:11px}
  .appbar .cmdk-trigger{flex:1 1 auto;min-width:0}
  .appbar .cmdk-trigger kbd{display:none}
  #rmSyncModal .modal{max-height:88vh;overflow:auto}
}
.rm-spin .rm-ic{display:inline-block;animation:rmspin 1s linear infinite}
@keyframes rmspin{to{transform:rotate(360deg)}}
</style>
`;
rep('<!-- guided tour -->', dialog + '<!-- guided tour -->', 'dialog');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`Built ${OUT} (${(html.length / 1024).toFixed(0)} KB) · patches: ${swaps.length}`);
