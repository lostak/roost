# Roost

*Commission & residual intelligence.*

A local, zero-dependency dashboard for insurance commission statement PDFs. It
scans the year folders next to this one (`2024/`, `2025/`, ...), extracts and
parses every statement, and serves an interactive dashboard plus an Excel
export. Everything runs on your machine — no data leaves it, and there is no
`npm install` step.

## Running it

Double-click **`Start-Roost.bat`** (Windows). It launches the server and
opens Roost in your browser.

Or from a terminal in this folder:

```
node server.js
```

Then open <http://127.0.0.1:5000>. Node.js (LTS) must be installed.

## Adding statements

Two ways to add a weekly statement:

- **In the browser** — click **Upload** in the top bar and drop one or more
  statement PDFs (or browse to them). Each file is read, dated, and filed into
  the correct `Statements/<year>/` folder automatically as `M-D-YY.pdf`, so the
  name it was downloaded with doesn't matter. Files whose date is already on
  file are reported as duplicates and left untouched, and the dashboard
  refreshes as soon as something new is added.
- **By hand** — drop the PDF straight into the matching year folder under
  `Statements/`, then click Refresh.

## Folder layout

Roost lives inside the **Commissions** folder, alongside your statements and
reference material:

```
Commissions/
  Statements/           commission statement PDFs, grouped by year:
    2024/  2025/  2026/   files named M-D-YY.pdf (e.g. 7-22-26.pdf)
                          — drop each new weekly statement into the matching year folder
  roost/                this app (see below)
  Reports/              account & production summary exports (e.g. the ASB account xlsx)
  Reference/            carrier compensation schedules and other reference docs
  _Archive/             retired / duplicate files kept for records, ignored by the app
```

Roost reads the year folders from the folder named by `statements_dir` in
`config.json` (default `../Statements`). Only four-digit year folders are
scanned; if `../Statements` has none, Roost falls back to looking for year
folders directly in the Commissions root (the older layout).

## How it works

```
roost/
  server.js       HTTP server + Excel export; scans the year folders
  pdftext.js      zero-dependency PDF text extractor
  parser.js       turns statement text into structured records (carriers, agents, amounts)
  aggregate.js    rolls records up into the dashboard JSON (yearly, carrier, policy, downline, projections)
  xlsxlite.js     minimal from-scratch .xlsx writer (the export)
  index.html      the dashboard UI
  config.json     user settings (see below)
  roost-logo.svg  the Roost logo
```

Parsed statements are cached in `.parse_cache.json`, keyed by file
mod/time and a `PARSE_VERSION`. The cache regenerates automatically when a PDF
changes or when the parser is updated, so it is safe to delete.

## Configuration — `config.json`

Edit `config.json` (not the `.js` source) and restart the server:

- **`downline_roster`** — writing-agent names you earn an override on. Matching
  is fuzzy on first/last name. Add each downline agent here.
- **`ma_reclass`** — Medicare Advantage new-business detection. A line in the
  residual section is treated as new business when its payable is at least
  `mult` times the policy's typical recurring payment and at least
  `max(floor_min, 3 x global median)`. Raise these to reclassify fewer lines.

## Notes

- Statements must be named with a date (`M-D-YY.pdf`); files that can't be dated
  or parsed are skipped and listed in the server console on load.
- Carrier detection lives in `parser.js` (`CARRIERS`). If new carriers land in
  the "Other" bucket, add a keyword there.
