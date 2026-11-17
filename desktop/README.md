# Roost for Windows

Roost as its own app: double-click it and the dashboard opens in a window. No Node.js install, no console
window to keep open, no browser tab. It's the same server, parser and dashboard as `Start-Roost.bat`, so the
numbers are identical.

## Install
1. Download **Roost-Setup.exe** from https://github.com/lostak/roost/releases/tag/desktop and run it.
   Windows SmartScreen will warn because the installer isn't code-signed: **More info → Run anyway**.
2. On first launch Roost looks for your Roost folder (the one with `config.json` and `.parse_cache.json`,
   e.g. `OneDrive\Desktop\HRG\Commissions\roost`). If it can't find one it asks: pick yours, or choose
   **Start fresh** to get a new one in `Documents\Roost`.
3. Pin it: right-click its taskbar icon → **Pin to taskbar**. To open it at login, tick **Start with
   Windows** in the tray icon's menu.

## Where your data lives
Nothing moves. The app reads and writes the same files the .bat version does: `config.json`,
`.parse_cache.json` and `.env` in your Roost folder, statements in `..\Statements`, client sheets in
`..\Clients`. You can switch between the app and `Start-Roost.bat` freely; just don't run both at once.
The app's server only listens on `127.0.0.1`, so nothing is reachable from other computers on the network.

## Tray menu
Open Roost, reload statements, open the Statements folder, see or change the Roost folder, Start with
Windows, restart to update, the server log, and quit. Closing the window quits Roost.

## Updates
Installed copies check the `desktop` release every 30 minutes, download only what changed, and install on
restart (a notification offers to restart now). Any push to `main` that touches the app files runs
`.github/workflows/desktop.yml`, which runs the tests, builds the installer and publishes it.
No extra steps to ship.

## Developing
```
cd desktop
npm install
npm start        # copies the root app files into desktop/core, then runs it
npm run dist     # builds dist\Roost-Setup.exe locally
```
Set `ROOST_HOME` to point a dev copy at a test folder instead of your real data.
