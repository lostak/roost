# Roost for Android

Roost's own dashboard on your phone, with no Claude account or Google sign-in needed. It is Roost Mobile
(`../mobile`, which bundles Roost's `index.html`, parser and math unchanged) running in an Android app.
`web/android-shim.js` backs it with the phone:

| Roost Mobile on claude.ai | Roost for Android |
|---|---|
| Private Claude database | A private file in the app's storage on the phone |
| Sync through the Google Drive connector | `roost-sync.json.gz` read through the Android file picker |
| Downloads | The phone's Downloads folder |
| Claude AI summary / ask | Not available (anomaly flags still work) |

## Getting your statements onto the phone
Roost on the computer (the Windows app or Start-Roost.bat) writes `roost-sync.json.gz` after every scan
into `mobile_sync_dir`, a cloud-synced folder. The file holds the statement numbers and settings, never the
PDFs.
1. On the computer: in the Windows app's tray menu choose **Set up phone sync…** and pick a Google Drive,
   OneDrive or Dropbox folder. (Or set `"mobile_sync_dir"` in `config.json`.)
2. On the phone: open Roost, tap the sync button (⇅) → **Sync from laptop**, and pick `roost-sync.json.gz`
   in that folder. You pick it once; after that Roost syncs every time you open it.
   On the computer, **⇅ Phone file** in Roost's top bar can also set that folder, or save a one-time
   copy of `roost-sync.json.gz` to send to the phone yourself (email, USB, Drive in a browser).
PDFs uploaded on the phone are parsed on the phone and only their numbers are kept. They don't flow back
to the computer.

## Install and updates
Download **Roost.apk** from https://github.com/lostak/roost/releases/tag/android on the phone and install
it (allow installs from your browser if asked). Every push to `main` that touches Roost builds a new APK;
the app checks for it when it opens and offers **Download**. Your statements stay on the phone.

## Signing key
`roost.keystore` signs every build so updates install over the previous version. It's committed because
the build runs on GitHub Actions without secrets. Anyone with the repo could sign an APK that installs
over Roost, so only install Roost from the release page above.

## Build locally
```
mkdir -p mobile/vendor && cd mobile/vendor
for p in pako@2.1.0 buffer@6.0.3 base64-js@1.5.1 ieee754@1.2.1 chart.js@4.4.1; do npm pack $p && d=${p/@/-} && mkdir -p $d && tar xzf $d.tgz -C $d; done
cd ../.. && node android/scripts/build-web.js
cd android && gradle :app:assembleDebug
```
