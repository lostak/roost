# Branch strategy

Roost has two product lines that evolve in parallel:

## `main` — Localhost edition
The single-user, runs-on-your-own-machine version. Reads PDFs from a local folder,
stores everything in local files (config.json, .parse_cache.json, Clients/). This is
the version you run today.

- New localhost features → branch off `main` (e.g. `feature/xyz`), verify, merge back to `main`.

## `server` — Hosted / multi-tenant edition (the sellable product)
A proper client/server split: users sign in, upload their commission PDFs to the
**server**, which stores them per-account, parses them, and serves each user only
their own data. Same dashboard UI as the localhost edition.

- New server/product features → branch off `server` (e.g. `server/xyz`), verify, merge back to `server`.
- Shared logic (parser.js, aggregate.js, clients.js, pdftext.js, xlsxlite.js, index.html)
  is kept in sync between the two lines; cherry-pick or merge across when a change applies to both.

## Rule of thumb
- Change belongs only to the desktop/localhost app → base it on `main`.
- Change belongs to the hosted product → base it on `server`.
- Change belongs to both (e.g. a parser fix or a new chart) → land it on `main`, then
  merge/cherry-pick into `server` (or vice-versa) so both stay current.
