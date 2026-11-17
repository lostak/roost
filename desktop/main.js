// Roost for Windows: runs the same Roost server (server.js) in the background and shows the dashboard in its
// own window. No Node install, no console window, no browser tab. Data stays in your Roost folder on this PC;
// the server only listens on 127.0.0.1.
const { app, BrowserWindow, Tray, Menu, dialog, shell, utilityProcess, nativeImage, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

const APP_ID = app.isPackaged ? "com.lostak.roost.desktop" : "com.lostak.roost.dev";
app.setAppUserModelId(APP_ID); // must match build.appId so notifications and taskbar pins line up
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const ICON = path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
// core/ is unpacked from app.asar in the installed app so the server runs from real files on disk
const CORE = path.join(__dirname, "core").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

// ---------- settings (which Roost folder to use) ----------
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const settings = {
  get() { try { return JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { return {}; } },
  set(s) { fs.mkdirSync(app.getPath("userData"), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); },
};
const isRoostFolder = (d) => { try { return ["config.json", ".parse_cache.json", "Start-Roost.bat"].some(f => fs.existsSync(path.join(d, f))); } catch { return false; } };
function guessRoostFolder() {
  const h = os.homedir();
  const c = [
    process.env.ROOST_HOME,
    path.join(h, "OneDrive", "Desktop", "HRG", "Commissions", "roost"),
    path.join(h, "Desktop", "HRG", "Commissions", "roost"),
    path.join(h, "OneDrive", "Desktop", "Commissions", "roost"),
    path.join(h, "Desktop", "Commissions", "roost"),
    path.join(h, "OneDrive", "Documents", "Commissions", "roost"),
    path.join(h, "Documents", "Commissions", "roost"),
    path.join(h, "Documents", "Roost", "roost"),
  ].filter(Boolean);
  return c.find(isRoostFolder) || null;
}
// Roost keeps its own files (config, cache) in the "roost" folder and statements beside it in ../Statements.
async function chooseRoostFolder(parent, firstRun) {
  const r = await dialog.showMessageBox(parent, {
    type: "question", title: "Roost folder", noLink: true,
    message: firstRun ? "Where's your Roost folder?" : "Change Roost folder",
    detail: "Pick the folder that has Roost's config.json and .parse_cache.json (the one Start-Roost.bat is in). Your statements go in the Statements folder next to it.\n\nNew to Roost? Choose Start fresh and it makes Documents\\Roost for you.",
    buttons: ["Choose folder…", "Start fresh", "Cancel"], defaultId: 0, cancelId: 2,
  });
  if (r.response === 2) return null;
  if (r.response === 1) {
    const d = path.join(os.homedir(), "Documents", "Roost", "roost");
    fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(path.join(d, "..", "Statements"), { recursive: true });
    return d;
  }
  const pick = await dialog.showOpenDialog(parent, { title: "Choose your Roost folder", properties: ["openDirectory", "createDirectory"], defaultPath: guessRoostFolder() || os.homedir() });
  if (pick.canceled || !pick.filePaths[0]) return null;
  let d = pick.filePaths[0];
  // picked the Commissions folder instead of the roost folder inside it
  if (!isRoostFolder(d) && isRoostFolder(path.join(d, "roost"))) d = path.join(d, "roost");
  return d;
}

// ---------- the Roost server, in its own background process ----------
let server = null, port = null, quitting = false, dataDir = null;
const logPath = () => path.join(app.getPath("userData"), "server.log");
function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer();
      s.once("error", () => (p < start + 20 ? tryPort(p + 1) : resolve(0)));
      s.once("listening", () => s.close(() => resolve(p)));
      s.listen(p, "127.0.0.1");
    };
    tryPort(start);
  });
}
function buildCommit() { try { return JSON.parse(fs.readFileSync(path.join(CORE, "build-info.json"), "utf8")).commit || ""; } catch { return ""; } }
async function startServer() {
  // Same port as Start-Roost.bat when it's free, so saved page settings carry over between restarts.
  port = await freePort(5000);
  if (!port) throw new Error("No free port between 5000 and 5020.");
  const log = fs.createWriteStream(logPath(), { flags: "w" });
  const child = utilityProcess.fork(path.join(CORE, "server.js"), [], {
    serviceName: "Roost server", stdio: "pipe", cwd: dataDir,
    env: { ...process.env, ROOST_HOME: dataDir, PORT: String(port), ROOST_HOST: "127.0.0.1",
      ROOST_APP_VERSION: app.getVersion(), ROOST_APP_COMMIT: buildCommit() },
  });
  server = child;
  child.stdout?.on("data", (b) => log.write(b));
  child.stderr?.on("data", (b) => log.write(b));
  child.on("exit", (code) => {
    if (server !== child) return; // stopped on purpose (restart, folder change, quit)
    server = null;
    if (quitting) return;
    dialog.showMessageBox(win, { type: "error", title: "Roost", message: "Roost's background server stopped.", detail: `Exit code ${code}. Details are in ${logPath()}`, buttons: ["Restart Roost", "Quit"] })
      .then((r) => (r.response === 0 ? restartServer() : app.quit()));
  });
  // The server scans every statement before it answers, so wait for the first page to come back.
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 600; i++) {
    try { const r = await fetch(url); if (r.ok) return url; } catch {}
    if (!server) throw new Error("The server stopped while starting. See " + logPath());
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Roost didn't start within 2.5 minutes. See " + logPath());
}
function stopServer() { if (server) { const s = server; server = null; s.kill(); } }
async function restartServer() {
  stopServer();
  await loadRoost();
}

// ---------- window ----------
let win = null, tray = null;
const origin = () => `http://127.0.0.1:${port}`;
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 380, minHeight: 560, show: false, title: "Roost", autoHideMenuBar: true, icon: ICON,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => { if (!process.argv.includes("--hidden")) win.show(); });
  if (process.platform === "win32") {
    const ico = app.isPackaged ? process.execPath : ICON;
    const cmd = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${path.resolve(__dirname)}"`;
    try { win.setAppDetails({ appId: APP_ID, appIconPath: ico, appIconIndex: 0, relaunchCommand: cmd, relaunchDisplayName: "Roost" }); } catch {}
  }
  // The year-end report opens a blank window and prints from it: keep those in the app. Real links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url === "" || (port && url.startsWith(origin()))) {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, width: 900, height: 1000 } };
    }
    shell.openExternal(url); return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!(port && url.startsWith(origin())) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });
  win.on("closed", () => { win = null; });
  win.loadFile(path.join(__dirname, "renderer", "loading.html"));
}
function show() { if (!win) createWindow(); win.show(); win.focus(); }

async function loadRoost() {
  if (!dataDir || !fs.existsSync(dataDir)) {
    const d = await chooseRoostFolder(win, true);
    if (!d) { app.quit(); return; }
    dataDir = d; settings.set({ ...settings.get(), dataDir });
  }
  refreshTrayMenu();
  try {
    const url = await startServer();
    if (win) await win.loadURL(url);
  } catch (e) {
    const r = await dialog.showMessageBox(win, { type: "error", title: "Roost", message: "Roost couldn't start.", detail: String(e.message || e), buttons: ["Try again", "Change Roost folder…", "Quit"] });
    if (r.response === 0) return restartServer();
    if (r.response === 1) return changeFolder();
    app.quit();
  }
}
async function changeFolder() {
  const d = await chooseRoostFolder(win, false);
  if (!d || d === dataDir) return;
  dataDir = d; settings.set({ ...settings.get(), dataDir });
  if (win) win.loadFile(path.join(__dirname, "renderer", "loading.html"));
  await restartServer();
}

// ---------- phone sync (Roost for Android) ----------
// Roost writes roost-sync.json.gz into config.json's mobile_sync_dir after every scan. Point it at a
// cloud-synced folder (Google Drive, OneDrive, Dropbox) and the Android app reads that file.
function readConfig() { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")); } catch { return {}; } }
function phoneSyncLabel() {
  const d = dataDir && readConfig().mobile_sync_dir;
  return d ? `Phone sync folder: ${path.resolve(dataDir, d)}…` : "Set up phone sync…";
}
async function choosePhoneSync() {
  const cur = readConfig().mobile_sync_dir;
  const pick = await dialog.showOpenDialog(win, {
    title: "Choose a Google Drive, OneDrive or Dropbox folder for your phone",
    message: "Roost saves your statement numbers and settings here (never the PDFs) for Roost on Android.",
    properties: ["openDirectory", "createDirectory"], defaultPath: cur ? path.resolve(dataDir, cur) : os.homedir(),
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const file = path.join(dataDir, "config.json");
  let raw = {}; try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  raw.mobile_sync_dir = pick.filePaths[0];
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  refreshTrayMenu();
  if (win && port) win.webContents.reload();   // a scan writes the file right away
  dialog.showMessageBox(win, { type: "info", title: "Phone sync", message: "Phone sync is on.",
    detail: `Roost will keep roost-sync.json.gz up to date in:\n${pick.filePaths[0]}\n\nOn your phone, open Roost, tap Sync and pick that file once.` });
}

// ---------- tray ----------
function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "build", "tray.png")));
  tray.setToolTip("Roost");
  tray.on("click", show);
  refreshTrayMenu();
}
let updateReady = null;
function refreshTrayMenu() {
  if (!tray) return;
  const statements = dataDir ? path.join(dataDir, "..", "Statements") : null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Roost", click: show },
    { label: "Reload statements", enabled: !!port, click: () => win && win.webContents.reload() },
    { type: "separator" },
    { label: "Open Statements folder", enabled: !!statements, click: () => shell.openPath(fs.existsSync(statements) ? statements : path.join(dataDir, "..")) },
    { label: dataDir ? `Roost folder: ${dataDir}` : "Roost folder: not set", enabled: false },
    { label: "Change Roost folder…", click: changeFolder },
    { label: phoneSyncLabel(), enabled: !!dataDir, click: choosePhoneSync },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--hidden"] }) },
    { type: "separator" },
    ...(updateReady ? [{ label: `Restart to update (v${updateReady})`, click: () => { quitting = true; require("electron-updater").autoUpdater.quitAndInstall(true, true); } }] : []),
    { label: "Server log", click: () => shell.openPath(logPath()) },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- self-updates (same setup as My Life) ----------
function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater; try { ({ autoUpdater } = require("electron-updater")); } catch { return; }
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = info.version; refreshTrayMenu();
    const n = new Notification({ title: "Roost updated", body: `Version ${info.version} is ready. Click to restart now, or it installs next time Roost starts.`, icon: path.join(__dirname, "build", "icon.png") });
    n.on("click", () => { quitting = true; autoUpdater.quitAndInstall(true, true); }); n.show();
    if (win && !win.isVisible()) { quitting = true; setTimeout(() => autoUpdater.quitAndInstall(true, false), 5000); }
  });
  autoUpdater.on("error", (e) => console.log("update check failed:", e?.message || e));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 30 * 60e3);
}

if (gotLock) {
  app.on("second-instance", show);
  app.whenReady().then(async () => {
    dataDir = settings.get().dataDir || guessRoostFolder();
    if (dataDir) settings.set({ ...settings.get(), dataDir });
    createWindow();
    buildTray();
    setupUpdates();
    await loadRoost();
  });
  app.on("before-quit", () => { quitting = true; stopServer(); });
  app.on("window-all-closed", () => app.quit()); // closing the window quits, like My Life
}
