# 🪺 Roost

**Commission & residual intelligence for insurance agents — 100% local, zero dependencies.**

Roost turns a folder of weekly commission-statement PDFs into an interactive
dashboard: earnings over time, new business vs. recurring residual, carrier and
policy breakdowns, downline overrides, retention analytics, and forward
projections. It runs entirely on your own machine as a small Node server — no
accounts, no cloud, no `npm install`, and your statements never leave your
computer.

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
- [Configuration](#configuration)
- [Folder layout](#folder-layout)
- [How it works](#how-it-works)
- [The dashboard, view by view](#the-dashboard-view-by-view)
- [Excel export](#excel-export)
- [Privacy & security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Design principles](#design-principles)
- [License](#license)

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
- **In-browser upload** — drag statement PDFs onto the page and they're dated,
  named, and filed into the right year folder automatically. Duplicates are
  detected and skipped.
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
- **Downline / override reporting** — rolls up production written by agents on
  your roster so you can see the override income you earn on your downline,
  broken out over time and by carrier.
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

**Requirements:** [Node.js](https://nodejs.org/) LTS (any recent version). That's
it — Roost uses only Node's built-in modules.

**Windows (easiest):** double-click **`Start-Roost.bat`**. It starts the server
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
  and filed into the correct `Statements/<year>/` folder as `M-D-YY.pdf`, so the
  name it was downloaded with doesn't matter. Files whose date is already on file
  are reported as duplicates and left untouched, and the dashboard refreshes as
  soon as something new is added.
- **By hand** — drop the PDF straight into the matching year folder under
  `Statements/`, then click **Refresh**.

## Configuration

All user settings live in **`config.json`** (edit it, then restart the server).
You never have to touch the code.

| Setting | Default | What it does |
|---|---|---|
| `statements_dir` | `"../Statements"` | Folder holding the year subfolders (`2024/`, `2025/`, …), relative to the `roost/` app folder. Falls back to the parent folder if it has no year folders. |
| `downline_roster` | `["Michael Schwab"]` | Writing-agent names you earn an override on. First/last-name matching is fuzzy; add each downline agent here. |
| `ma_reclass.mult` | `3.5` | Medicare Advantage new-business detection. A residual-section line is treated as new business when its payable is at least this multiple of the policy's typical recurring payment. |
| `ma_reclass.floor_min` | `80` | Floor (in dollars) below which residual lines are never reclassified, guarding small recurring amounts. |

## Folder layout

Roost lives inside your **Commissions** folder, alongside your statements and
reference material:

```
Commissions/
  Statements/           commission statement PDFs, grouped by year:
    2024/  2025/  2026/   files named M-D-YY.pdf (e.g. 7-22-26.pdf)
  roost/                the app (this repository)
  Reports/              account & production summary exports
  Reference/            carrier compensation schedules and other reference docs
  _Archive/             retired / duplicate files kept for records, ignored by the app
```

Only four-digit year folders under `statements_dir` are scanned; everything else
is ignored.

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
| `index.html` | The entire front end — a Material-Design single-page dashboard rendered with Chart.js (loaded from a CDN). |
| `config.json` | User settings (see [Configuration](#configuration)). |

### HTTP endpoints

| Method & path | Purpose |
|---|---|
| `GET /` | The dashboard UI. |
| `GET /api/data` | The full aggregated summary as JSON. |
| `GET /api/export` | Download the multi-sheet Excel workbook. |
| `POST /api/upload?name=<filename>` | Upload one statement PDF (raw body). It's validated, dated, and filed automatically. |

### Caching

Parsed statements are stored in `.parse_cache.json`, keyed by file path,
modification time, and a `PARSE_VERSION`. Only new or changed files are
re-parsed; the cache regenerates automatically when a PDF changes or the parser
is updated, so it is always safe to delete.
Parsed statements are stored in `.parse_cache.json`, keyed by file path,
modification time, and a `PARSE_VERSION`. Only new or changed files are
re-parsed; the cache regenerates automatically when a PDF changes or the parser
is updated, so it is always safe to delete.

## The dashboard, view by view

| View | What it shows |
|---|---|
| **Overview** | Headline KPIs (latest YTD total, all-years residual, new business, pending pipeline) and an income-over-time chart with a YTD running total. |
| **New Business** | Up-front advance commissions over time and by carrier. |
| **Residual Income** | Recurring renewal income — the book that keeps paying without new sales. |
| **Comparison** | Flexible side-by-side comparison across dimensions, types, and metrics. |
| **Cumulative** | Year-over-year cumulative curves overlaid by day-of-year to compare pace. |
| **By Carrier** | Residual and new business broken out per carrier, ranked by total. |
| **Downline** | Override production from agents on your roster, over time and by carrier. |
| **Projections** | Annualized run-rates plus interactive sliders for retention, growth, conversion, renewals, and chargebacks to model future income. |
| **Policies** | Searchable per-policy residual tracker with year-by-year payment history. |

## Excel export

Clicking **Export Excel** builds a workbook with these sheets: **Yearly**,
**Monthly**, **Residual by Carrier**, **Residual Policies**, **Statements**,
**Downline Agents**, and **Downline Detail** — currency-formatted, with frozen
header rows.

## Privacy & security

- **Everything is local.** Roost runs on `127.0.0.1` and only ever reads files
  from your own folders. No statement, client name, or commission figure is sent
  anywhere.
- **No external code at runtime**, except the Chart.js library the dashboard
  loads from a CDN to draw charts. The server itself has zero dependencies.
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
Statements are dated from their contents, or from a `M-D-YY.pdf` filename as a
fallback. If a file can't be dated or parsed it's skipped and listed in the
server console on load. Rename it like `M-D-YY.pdf` and re-add it.

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

## License

Personal project — add a license of your choice (e.g. [MIT](https://choosealicense.com/licenses/mit/))
before sharing publicly.

## Setup from scratch

- Install Git
  - Go to [this](https://git-scm.com/install/) link to download Git
  - Click on the downloaded file and use all default suggestions to install

- Install Node.js
  - Got [this](https://nodejs.org/en/download) link to download Node.js
  - Click on the downloaded file and use all default suggestions to install

- Download/Move Statements
  - Create a the following directories
  ```
  Commisions/
    Statements/
      2024/ 2025/ 2026/ ...
    roost/
  ```
- Pull Repository
  - Open **../Commission/roost** Powershell/Terminal by right clicking in the File Explorer
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
  