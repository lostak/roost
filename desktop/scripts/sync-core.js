// Copies Roost's app files from the repo root into desktop/core so the Windows app ships the exact same
// server, parser and dashboard as Start-Roost.bat. Run before `npm start` or `npm run dist` (both do it).
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const out = path.resolve(__dirname, "..", "core");
const FILES = ["server.js", "parser.js", "aggregate.js", "ai.js", "clients.js", "pdftext.js", "xlsxlite.js", "index.html", "roost-logo.svg"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of FILES) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) { console.error("missing " + f); process.exit(1); }
  fs.copyFileSync(src, path.join(out, f));
}
console.log(`synced ${FILES.length} files into desktop/core`);
