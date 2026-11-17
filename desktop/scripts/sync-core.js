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
// Record which commit this build came from, so bug reports from the app name the exact code.
let commit = process.env.GITHUB_SHA || "";
if (!commit) { try { commit = require("node:child_process").execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {} }
fs.writeFileSync(path.join(out, "build-info.json"), JSON.stringify({ commit: commit || "unknown" }));
console.log(`synced ${FILES.length} files into desktop/core (${(commit || "unknown").slice(0, 7)})`);
