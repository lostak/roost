// Builds the page the Android app shows: Roost Mobile (../../mobile/build.js, i.e. Roost's own
// dashboard and modules) plus android-shim.js, with Chart.js bundled so charts work offline.
//   node android/scripts/build-web.js        (needs mobile/vendor: see mobile/README.md)
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const mobile = path.join(root, "mobile");
const tmp = path.join(mobile, "dist", "android-base.html");
execFileSync(process.execPath, [path.join(mobile, "build.js"), root, tmp], { stdio: "inherit" });

let html = fs.readFileSync(tmp, "utf8");
const shim = fs.readFileSync(path.join(__dirname, "..", "web", "android-shim.js"), "utf8");
const chartSrc = path.join(mobile, "vendor", "chart.js-4.4.1", "package", "dist", "chart.umd.js");
if (!fs.existsSync(chartSrc)) throw new Error("missing " + chartSrc + " (npm pack chart.js@4.4.1 into mobile/vendor)");

// The shim must run before any of the page's scripts.
const head = html.indexOf("<head>");
if (head < 0) throw new Error("no <head> in the Roost Mobile build");
html = html.slice(0, head + 6) + "\n<script>\n" + shim.replace(/<\/script/gi, "<\\/script") + "\n</script>\n" + html.slice(head + 6);

// Chart.js from the app instead of the CDN.
const cdn = /<script[^>]*src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"]+"[^>]*><\/script>/;
if (!cdn.test(html)) throw new Error("Chart.js CDN tag not found in Roost's index.html");
html = html.replace(cdn, '<script src="chart.umd.js"></script>');

const out = path.join(__dirname, "..", "app", "src", "main", "assets", "www");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
fs.copyFileSync(chartSrc, path.join(out, "chart.umd.js"));
fs.rmSync(tmp, { force: true });
console.log(`android web assets: ${(html.length / 1024).toFixed(0)} KB -> ${path.relative(root, out)}`);
