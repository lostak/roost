# 🪺 Roost

**Commission & residual intelligence for insurance agents — 100% local, zero dependencies.**

Roost turns a folder of weekly commission-statement PDFs into an interactive
dashboard: earnings over time, new business vs. recurring residual, carrier and
policy breakdowns, downline overrides, convention-trip progress, retention
analytics, and forward projections. It runs entirely on your own machine as a
small Node server — no accounts, no `npm install`, and your statement PDFs never
leave your computer.

Three ways to use it, all running the same code and showing the same numbers:

| | What it is | Get it |
|---|---|---|
| **Windows app** | Roost in its own window, with a tray icon, Start-with-Windows and automatic updates. No Node install. | [`Roost-Setup.exe`](https://github.com/lostak/roost/releases/tag/desktop) |
| **Android app** | Roost on your phone, synced from your computer through a cloud folder. No Claude or Google sign-in needed. | [`Roost.apk`](https://github.com/lostak/roost/releases/tag/android) |
| **Local server** | `Start-Roost.bat` / `node server.js`, viewed in your browser. For development. | this repo |

<!-- Add a screenshot here once you have one, e.g.:
![Roost overview](docs/screenshot.png)
-->

---

## Table of contents

- [Why Roost](#why-roost)
- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Adding statements](#adding-statements)
- [Roost on your phone](#roost-on-your-phone)
- [Configuration](#configuration)
- [Convention points](#convention-points)
- [Folder layout](#folder-layout)
- [How it works](#how-it-works)
- [The dashboard, view by view](#the-dashboard-view-by-view)
- [Excel export](#excel-export)
- [Releases & updates](#releases--updates)
- [Privacy & security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Design principles](#design-principles)
- [Testing](#testing)
- [License](#license)
- [Setup from scratch](#setup-from-scratch)

---

## Why Roost

Carriers and FMOs hand you commission statements one PDF at a time. Individually
they tell you what you got paid this week; together they tell you how your book
is actually doing — but nobody gives you that view. Spreadsheets go stale, and
portals only show their own slice.

Roost reads **every statement you've ever saved**, understands the structure of
each one (new business, residual, chargebacks, pending, writing agents), and
rolls them up into a single picture of your business that updates the moment you
drop in a new statement. Because it's a self-contained local app, it works
offline, costs nothing to run, and keeps sensitive client and commission data on
your machine.

## Features

- **Reads statement PDFs directly** — a custom, dependency-free PDF text
  extractor pulls the data out of each statement; no copy-paste, no manual entry.
  Handles both the older single-line statement layout and the newer (2026) ASB
  column layout, and the parser reads each statement's own column header so it
  adapts if the grid shifts in a future format.
- **In-browser upload** — drag statement PDFs onto the page and they're dated,
  named, and filed into the right year folder automatically. Duplicates are
  detected and skipped.
- **File organizer** — the Review page can re-read every statement and rename /
  re-file any that were named wrong or dropped in by hand (e.g. a Nov-2024
  statement saved as `11-14-25.pdf`), filing each as `<year>/M-D-YY - Agent Name.pdf` from the
  date inside the PDF. Preview first, then apply; true duplicates are removed and
  nothing else is deleted.
- **Guided tour** — a short, skippable walkthrough teaches the app on first run
  and can be reopened anytime from the **?** button in the top bar.
- **Color themes** — six hand-tuned accent themes (picker in the top bar), each
  readable in both light and dark; the logo adopts the chosen theme.
- **Policy type drill-down** — every policy is classified by line of business
  (Medicare Advantage, Med Supp, Annuity, Life/Final Expense, etc.); click a type
  or product in the Policies view to see all policies of that kind.
- **Little things** — download any chart as a PNG (hover the chart), click a
  summary KPI to jump to its detail section, a mobile back-to-top button, and a
  Contact / feedback form (bug reports & feature requests).
- **Earnings over time** — new business, residual, chargebacks, and net pay by
  week, month, quarter, or year, with a year-to-date running total.
- **New business vs. residual** — separates up-front commissions from the
  recurring renewal income that keeps paying, including automatic reclassification
  of Medicare Advantage initial payments that book inside the residual section.
- **Carrier intelligence** — residual and new business broken out by carrier,
  with 30+ carriers recognized from statement text (UnitedHealthcare, Humana,
  Aetna, Devoted, Cigna, Mutual of Omaha, Americo, Medico, and many more).
- **Per-policy residual tracker** — every policy that pays residual, with its
  client, carrier, product, payment count, and year-by-year totals.
- **Downline / override reporting** — auto-detects your downline from your
  commissions (any writing agent who ever appears at level 100 is flagged as your
  downline) and rolls up all of their production as your override income — over
  time and by carrier, with the date each agent first joined your downline.
- **Chargebacks vs. rewrites** — clawbacks are split into true chargebacks (the
  client is gone) and rewrites (the policy was reissued as a comparable product in
  the same line of business, e.g. a 10-year annuity reissued as a 15-year), so the
  real loss rate is clear. A residual line that stops with no comparable
  replacement is counted as a lapse; one replaced by a fresh initial commission is
  a rewrite. The Chargebacks page lists every rewrite (from → to product/carrier).
- **"Issued but unpaid" weeks** — when a weekly check is negative after
  chargebacks, or a positive amount below the carrier's payout minimum, a statement
  is still issued but nothing is paid. Roost recognizes these, shows them on the
  Review page with the reason, and does **not** flag their week as a missing
  statement.
- **Convention tracker** — personal and combined (personal + downline) points toward the ASB
  incentive trip, scored by the official rules and checked against ASB's own dashboard, with your
  level's targets, the 25-app and 50%-non-MA rules, per-policy credit, and a "what will it take"
  planner. See [Convention points](#convention-points).
- **Windows and Android apps** — the same dashboard as a self-updating Windows app and an Android
  app that syncs from your computer. See [Roost on your phone](#roost-on-your-phone).
- **Projections & insights** — annualized run-rates, retention/persistence
  estimates, book-growth, carrier concentration risk, chargeback drag, AEP
  seasonality, and quarter-over-quarter momentum, surfaced as plain-language
  callouts plus interactive projection sliders.
- **One-click Excel export** — a multi-sheet `.xlsx` workbook of everything, built
  from scratch with no spreadsheet library.
- **Fast** — parsed statements are cached by modification time, so only new or
  changed files are re-read.

## Screenshots

> Drop a screenshot or two into a `docs/` folder and link them here. The
> **Overview** tab and the **By Carrier** tab make good first impressions.

## Quick start

### Windows app (recommended)

1. Download **`Roost-Setup.exe`** from the
   [Roost for Windows release](https://github.com/lostak/roost/releases/tag/desktop) and run it
   (SmartScreen: **More info → Run anyway**, since the installer isn't code-signed).
2. On first launch Roost finds your Roost folder (the one with `config.json` and
   `.parse_cache.json`, e.g. `OneDrive\Desktop\HRG\Commissions\roost`) or asks where it is.
   New to Roost? Choose **Start fresh** and it creates `Documents\Roost`.
3. Right-click its taskbar icon → **Pin to taskbar**. The tray icon's menu has Start with Windows,
   the Statements folder, phone sync setup, and the server log.

It updates itself (see [Releases & updates](#releases--updates)). More in
[`desktop/README.md`](desktop/README.md).

### Android app

Download **`Roost.apk`** on your phone from the
[Roost for Android release](https://github.com/lostak/roost/releases/tag/android) and install it,
then follow [Roost on your phone](#roost-on-your-phone).

### Local server (development)

**Requirements:** [Node.js](https://nodejs.org/) LTS (any recent version). That's
it — Roost uses only Node's built-in modules.

**Windows:** double-click **`Start-Roost.bat`**. It starts the server
and opens the dashboard in your browser.

**Any platform (terminal):**

```bash
cd roost
node server.js
```

Then open <http://127.0.0.1:5000>.

The server scans your statement folders, parses anything new, and serves the
dashboard. Leave the console window open while you use it; closing it stops the
server.

## Adding statements

Two ways to add a weekly statement:

- **In the browser** — click **Upload** in the top bar and drop one or more
  statement PDFs (or browse to them). Each file is read, dated from its contents,
  and filed into the correct `Statements/<year>/` folder as `M-D-YY - Agent Name.pdf`, so the
  name it was downloaded with doesn't matter. Files whose date is already on file
  are reported as duplicates and left untouched, and the dashboard refreshes as
  soon as something new is added.
- **By hand** — drop the PDF straight into the matching year folder under
  `Statements/`, then click **Refresh**. If you're not sure a hand-dropped file is
  named or filed correctly, use **Review → Organize files** to re-file everything
  by the date inside each PDF.

## Roost on your phone

The Android app runs Roost's own dashboard and math on the phone. It gets your statements from your
computer through a file in a cloud-synced folder, with no Claude account and no Google sign-in setup.

1. **On the computer:** in the Windows app's tray menu choose **Set up phone sync…** and pick a folder
   in Google Drive for desktop, OneDrive or Dropbox (or set `mobile_sync_dir` in `config.json`). After
   every scan Roost writes `roost-sync.json.gz` there: the statement numbers and the settings the math
   uses, never PDFs, file paths or API keys.
2. **On the phone:** install the same cloud app, open Roost, tap **⇅ → Sync from laptop**, and pick
   `roost-sync.json.gz` in that folder. You pick it once; after that Roost syncs every time it opens.

Statements live in the app's private storage on the phone. PDFs uploaded on the phone are parsed there
and only their numbers are kept; they don't flow back to the computer. The AI summary/ask isn't
available on the phone (anomaly flags still work). Details in [`android/README.md`](android/README.md).

`mobile/` also builds **Roost Mobile**, the same page as a Claude artifact that syncs through Claude's
Google Drive connector (see [`mobile/README.md`](mobile/README.md)).

## Configuration

All user settings live in **`config.json`** (edit it, then restart the server).
You never have to touch the code.

On a fresh checkout there is no `config.json` — copy the tracked template first:
`cp config.example.json config.json` (Windows: `copy config.example.json config.json`).
`config.json` is gitignored because the app also saves your goals, expenses, tax
figures, and agent names into it; keeping it out of git means that personal data is
never committed or pushed. The server also runs fine with no `config.json` at all,
falling back to the built-in defaults.

| Setting | Default | What it does |
|---|---|---|
| `statements_dir` | `"../Statements"` | Folder holding the year subfolders (`2024/`, `2025/`, …), relative to the `roost/` app folder. Falls back to the parent folder if it has no year folders. |
| `ma_reclass.mult` | `3.5` | Medicare Advantage new-business detection. A residual-section line is treated as new business when its payable is at least this multiple of the policy's typical recurring payment. |
| `ma_reclass.floor_min` | `80` | Floor (in dollars) below which residual lines are never reclassified, guarding small recurring amounts. |
| `mobile_sync_dir` | unset | Optional. A cloud-synced folder (e.g. `G:\My Drive\Roost Mobile`) where each scan writes `roost-sync.json.gz` for the Android app and Roost Mobile. Holds only extracted statement numbers and calculation settings — no PDFs, paths or API key. Unset = nothing is written. The Windows app sets it from **Set up phone sync…** in the tray. |
| `profile.convention_level` | unset | Your ASB contract level (1–10), which sets the convention targets. Set it on the Convention page. |
| `profile.self_names` | `[]` | Names/LLCs you're paid under, so they count as you rather than a split partner. Set on the Convention page. |
| `profile.convention_pay_lag_days` | `0` | Shifts the convention window by this many days. Leave at 0 to match ASB's dashboard (credit on first payment). |
| `profile.convention_include` / `convention_exclude` | `[]` | Policy numbers you force-count or force-exclude for the convention (e.g. a replacement Roost missed). |

**Environment variables** (optional, or in a local `.env`): `PORT` (default 5000), `ROOST_HOST`
(set to `127.0.0.1` to keep the server off your network; the Windows app does this), and `ROOST_HOME`
(data folder for `config.json` / `.parse_cache.json`, if it differs from the code folder; the Windows
app sets this to your Roost folder).

### Contact / feedback

The in-app Contact form sends bug reports and feature requests to the Roost
project (so issues reach the maintainer). Roost ships **no webhook secret** — a
public repo can't safely hold one (GitHub blocks it and Slack auto-revokes leaked
webhooks) — so it relays submissions to a no-code catch-hook (a Make webhook) that
forwards them to the project's Slack. The catch-hook URL isn't a secret; the real
Slack URL lives inside Make. If you'd rather keep feedback on your own side, copy
`.env.example` to `.env` (gitignored) and either point `FEEDBACK_RELAY_BUG` /
`FEEDBACK_RELAY_FEATURE` at your own catch-hooks, or set your own Slack/Discord
Incoming Webhook directly via `CONTACT_WEBHOOK_BUG` / `CONTACT_WEBHOOK_FEATURE`
(or a single `CONTACT_WEBHOOK` for both). Either way, submissions are also saved
locally to `feedback.jsonl`.

## Convention points

The Convention page scores your production by the
**2027 American Senior Benefits Incentive Trip official rules** (qualification period
Feb 1, 2026 – Jan 31, 2027), as reconciled against ASB's own dashboard:

| Line of business | Credit |
|---|---|
| Medicare Advantage | 2,000 points per issued policy |
| Med Supp | 125% of annualized premium; AARP/UHC Med Supp a flat 1,500 |
| Annuities, single-premium life/LTC | 15% of premium |
| Life (lifetime or limited pay), LTC, hospital/supplemental, dental/vision | 250% of annualized premium |
| Part D, under-65 medical | Not counted |

How Roost applies them to your statements:

- **Credit date = first payment.** ASB credits a policy once it's issued *and* paid, so a policy
  counts when it first pays on a statement inside the window, whether that's an advance or an
  as-earned commission line.
- **Personal vs. combined.** Personal is your listed share of each policy (100% minus every other
  writing agent's listed cut). Combined adds your **downline's** share. A policy your downline wrote
  alone counts toward combined only; a split partner who isn't your downline counts toward neither.
- **Replacements don't count.** A new policy in the same line for the same client counts as a
  replacement only when the earlier policy stopped paying around then; buying a second policy isn't a
  replacement. Force-count or force-exclude any policy on the Convention page.
- **Short histories.** If your statements only go back a few months, older business can look new the
  first time it pays. Roost ignores as-earned policies that first pay within 45 days of your earliest
  statement, and never counts annuity trail commissions as new business. Results are most accurate
  with a year or more of statements.
- The page also tracks the 25-issued-app minimum and the 50%-from-non-MA rule.

## Folder layout

Roost lives inside your **Commissions** folder, alongside your statements and
reference material:

```
Commissions/
  Statements/           commission statement PDFs, grouped by year:
    2024/  2025/  2026/   files named M-D-YY - Agent Name.pdf
  roost/                the app (this repository)
  Reports/              account & production summary exports
  Reference/            carrier compensation schedules and other reference docs
  _Archive/             retired / duplicate files kept for records, ignored by the app
```

Only four-digit year folders under `statements_dir` are scanned; everything else
is ignored.

Inside the repository:

```
roost/
  server.js  parser.js  pdftext.js  aggregate.js  clients.js  ai.js  xlsxlite.js  index.html
  test/                 zero-dependency test suites (npm test)
  desktop/              the Windows app (Electron wrapper around server.js)
  android/              the Android app (WebView around the Roost Mobile build)
  mobile/               builds Roost Mobile: index.html + modules bundled to run in a browser
  .github/workflows/    builds and publishes the Windows and Android releases
```

## How it works

Roost is a single small Node process with a five-stage pipeline. Every piece is
written from scratch using only Node built-ins (`http`, `fs`, `path`, `zlib`), so
there are no third-party packages to install or keep up to date.

```
PDF  ──▶  pdftext.js  ──▶  parser.js  ──▶  aggregate.js  ──▶  server.js  ──▶  browser
        extract text     structure it     roll it up        serve JSON       index.html
```

| File | Role |
|---|---|
| `pdftext.js` | Zero-dependency PDF text extractor. Parses the PDF object table, inflates content streams, decodes `ToUnicode` CMaps, replays the text-drawing operators, and reconstructs lines from glyph positions. |
| `parser.js` | Turns a statement's text into a structured record: pay-period and YTD totals, and line items with policy, client, product, carrier, premium, commission %, payable, and writing agents — split into advances / residual / chargebacks / pending sections. |
| `aggregate.js` | Rolls parsed records into the dashboard payload: yearly and monthly rollups, per-statement series, carrier and per-policy tables, downline overrides, cumulative-by-year curves, residual run-rate, projections, and plain-language insights. Also reclassifies Medicare Advantage initial payments out of residual. |
| `xlsxlite.js` | A minimal OOXML `.xlsx` writer — builds the workbook, styles, and a ZIP container by hand for the Excel export. |
| `server.js` | The HTTP server. Scans the statement folders, caches parses by file mtime, and serves the dashboard, the JSON API, the Excel export, and the upload endpoint. |
| `index.html` | The entire front end — a Material-Design single-page dashboard rendered with Chart.js (loaded from a CDN; bundled in the Android app). |
| `desktop/` | Windows app. Runs `server.js` in a background process against your Roost folder (`ROOST_HOME`), bound to `127.0.0.1`, and shows the dashboard in its own window. Adds the tray menu, phone-sync setup and self-updates. |
| `mobile/` | Bundles `index.html` and the modules with a small runtime that answers the page's `/api/*` calls in the browser (Roost Mobile). |
| `android/` | Android app around the `mobile/` build. `web/android-shim.js` stores data on the phone, reads the sync file through the Android file picker, and saves exports to Downloads. |
| `config.example.json` | Tracked template. Copy to `config.json` on first run (see [Configuration](#configuration)). |
| `config.json` | Your local settings — gitignored (holds personal data). |

### HTTP endpoints

| Method & path | Purpose |
|---|---|
| `GET /` | The dashboard UI. |
| `GET /api/data` | The full aggregated summary as JSON. |
| `GET /api/export` | Download the multi-sheet Excel workbook. |
| `POST /api/upload?name=<filename>` | Upload one statement PDF (raw body). It's validated, dated, and filed automatically. |
| `GET /api/organize` | Dry-run plan of files to rename / re-file by parsed date. Add `?apply=1` to perform it. |

### Caching

Parsed statements are stored in `.parse_cache.json`, keyed by file path,
modification time, and a `PARSE_VERSION`. Only new or changed files are
re-parsed; the cache regenerates automatically when a PDF changes or the parser
is updated, so it is always safe to delete.

## The dashboard, view by view

Everything on the **Home** page is reactive: the book-value hero, the convention trip card, the
summary KPIs, and the "money on the table" cards all click through to the relevant view. In-page
KPI jumps scroll the target into view *below* the sticky header (not hidden under it), and
switching views lands at the top of the new one.

| View | What it shows |
|---|---|
| **Home** | A narrated landing: your book value, what's "money on the table," convention-trip progress, and headline numbers — each clickable to the detail view. Adapts to how much history you have: a new agent sees earnings, a tax set-aside, convention pace, and "start here" actions instead of a $0 book value; Projections and Retention carry a caveat until there's enough history to trust. |
| **Overview** | Headline KPIs (latest YTD total, all-years residual, new business, pending pipeline) and an income-over-time chart with a YTD running total. |
| **New Business** | Up-front advance commissions over time and by carrier. |
| **Residual Income** | Recurring renewal income — the book that keeps paying without new sales. |
| **Comparison** | Flexible side-by-side comparison across dimensions, types, and metrics. |
| **Cumulative** | Year-over-year cumulative curves overlaid by day-of-year to compare pace. |
| **By Carrier** | Residual and new business broken out per carrier, ranked by total. |
| **Downline** | Override production from agents on your roster, over time and by carrier. |
| **Projections** | Annualized run-rates plus interactive sliders for retention, growth, conversion, renewals, and chargebacks to model future income. |
| **Policies** | Searchable per-policy residual tracker with year-by-year payment history. |
| **Convention** | Personal and combined points toward the ASB incentive trip against your level's targets, the app-count and non-MA rules, points by product line, every credited policy (with force-include/exclude), and a "what will it take" planner. |

## Excel export

Clicking **Export Excel** builds a workbook with these sheets: **Yearly**,
**Monthly**, **Residual by Carrier**, **Residual Policies**, **Statements**,
**Downline Agents**, and **Downline Detail** — currency-formatted, with frozen
header rows.

## Releases & updates

Every push to `main` builds and publishes both apps with GitHub Actions; the tests run first, and a
failing test stops the release.

| Workflow | Builds when | Publishes | How installed copies update |
|---|---|---|---|
| `.github/workflows/desktop.yml` | Roost's code, `index.html` or `desktop/` changes | `Roost-Setup.exe` + update feed to the [`desktop`](https://github.com/lostak/roost/releases/tag/desktop) release | Checks every 30 minutes, downloads in the background, installs on restart (a notification offers to restart now) |
| `.github/workflows/android.yml` | Roost's code, `index.html`, `mobile/` or `android/` changes | `Roost.apk` + `version.json` to the [`android`](https://github.com/lostak/roost/releases/tag/android) release | Offers the new APK in a popup when the app opens; tap **Download**, then install |

Updates only download from these public releases, so users never need GitHub after the first
install. If this repo is made private, the update feeds stop working and need a public home.

## Privacy & security

- **Your data stays on your devices.** Roost reads files only from your own folders. No statement,
  client name, or commission figure is sent anywhere, except the optional phone sync file below.
- **Network exposure.** The Windows app's server listens only on `127.0.0.1`. `Start-Roost.bat` /
  `node server.js` listens on all network interfaces unless you set `ROOST_HOST=127.0.0.1` (e.g. in
  `.env`), which keeps other computers on your network out.
- **Phone sync.** If you set `mobile_sync_dir`, `roost-sync.json.gz` (statement numbers, client
  names, and settings; no PDFs, paths or API key) is written to that folder and synced by your cloud
  provider. On the phone it's stored in Roost's private app storage.
- **Android signing key.** `android/roost.keystore` is committed so GitHub Actions can sign builds
  that install over each other. Only install Roost from the release page.
- **No external code at runtime**, except the Chart.js library the browser dashboard loads from a
  CDN (the Android app bundles it). The server itself has zero dependencies.
- **The upload endpoint** accepts only local requests, validates that each upload
  is a real PDF, derives the destination filename itself (so uploads can't be
  used to write outside the statements folders), and caps file size.
- **Don't commit your data.** The included `.gitignore` excludes the parse cache;
  keep your `Statements/` PDFs out of any public repository.

## Troubleshooting

**The dashboard shows "0 statements" or looks empty.**
The Node server loads its code once at startup, but the dashboard page is re-read
on every request — so after moving folders or updating the code, the running
server can be out of date even though the page looks new. Stop the server (close
its console window or press `Ctrl+C`) and start it again with `Start-Roost.bat`
or `node server.js`, then refresh the browser.

**A statement didn't import.**
Statements are dated from the pay-period date printed inside the PDF, so the file can
be named anything (a date in the filename is only used as a fallback). If a file can't
be dated or parsed it's skipped and listed in the server console on load — check it's an
actual commission statement.

**The Windows app won't start or shows an error.**
Right-click the tray icon → **Server log** for the background server's output. If it can't find your
data, use **Change Roost folder…**. Don't run `Start-Roost.bat` at the same time.

**The phone says it can't read the sync file, or it's out of date.**
Check that `roost-sync.json.gz` exists in your sync folder on the computer and that the cloud app has
finished uploading it. If the phone shows an error, tap **Sync from laptop** again and re-pick the file.

**Convention points don't match ASB's dashboard.**
ASB counts everything paid through today; Roost counts the statements it has. Add the latest
statements first. Then check your contract level and self names on the Convention page, and
force-include/exclude any policy Roost classified differently.

**A carrier shows up as "Other."**
Carrier detection is a keyword list in `parser.js` (`CARRIERS`). Add the carrier's
keyword there and restart to pull it out of the "Other" bucket.

## Design principles

- **Local-first.** Your data stays on your machine.
- **Zero dependencies.** Only Node built-ins, so nothing to install, audit, or
  patch. The app should still run years from now.
- **Self-healing.** Caches rebuild themselves; the statements folder is
  auto-detected with a fallback; bad files are skipped, not fatal.
- **Config over code.** Everything you'd want to tune lives in `config.json`.

> **Maintainers:** when you add a feature or a view, update this README's
> **Features** / dashboard sections, the in-app guided tour (`TOUR_STEPS` in
> `index.html`), *and* the tests — in the **same** change — so docs, tour, and
> checks never drift from what the app does.

## Testing

```bash
npm test
```

Zero-dependency suites: `parser` and `corpus` (statement parsing against fixtures),
`aggregate` (roll-up math, including the convention rules: first-payment window, as-earned
credit, split shares, downline-only-in-combined, and existing business on short histories),
and `ui-wiring` — static checks over `index.html` that every click target resolves to a real
view/element, in-page scrolling is header-aware, and the home page's hero, trip card, and KPIs
navigate. Both release workflows run `npm test` before building.

## License

Personal project — add a license of your choice (e.g. [MIT](https://choosealicense.com/licenses/mit/))
before sharing publicly.

## Setup from scratch

**Just using Roost?** Install the [Windows app](#windows-app-recommended) and point it at (or let it
create) your Roost folder; put your statement PDFs in the `Statements` folder next to it, or upload
them in the app. No Git or Node needed. The steps below are for running from source.

- Install Git
  - Go to [this](https://git-scm.com/install/) link to download Git
  - Click on the downloaded file and use all default suggestions to install

- Install Node.js
  - Go to [this](https://nodejs.org/en/download) link to download Node.js
  - Click on the downloaded file and use all default suggestions to install

- Download/Move Statements
  - Create the following directories
  ```
  Commissions/
    Statements/
      2024/ 2025/ 2026/ ...
    roost/
  ```
- Pull Repository
  - Open **../Commissions/roost** Powershell/Terminal by right-clicking in the File Explorer
  - Type the following
  ```
  git init
  git remote add origin https://github.com/lostak/roost.git
  git pull origin main
  ```
    This will download the code to your computer

- Start Roost
  - Open **../Commissions/roost/Start-Roost** to start the local server and open the web app in your browser

- Stop Roost
  - Close Terminal/Powershell
  