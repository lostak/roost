# Roost Mobile

Roost's own dashboard (`../index.html`) running as a Claude artifact on a phone. Nothing in the
UI is rewritten: `build.js` inlines Roost's modules (aggregate, parser, pdftext, clients, xlsxlite,
ai, plus `parsePdfBuffer`/`buildWorkbook` lifted from `server.js`) and `mobile-runtime.js`, which
answers the page's `fetch('/api/...')` calls in the browser:

| Desktop API | Roost Mobile |
|---|---|
| `/api/data` | `buildSummary` over statements in the artifact's owner-only database |
| goals, expenses, profile, carrier-map, dismiss-gap, downline-* | same validation as server.js, saved to the database |
| `/api/upload` | PDF parsed in the browser; only the numbers are saved |
| `/api/export` | Roost's workbook, saved through the downloads capability |
| `/api/ai` | anomalies as on desktop; summary/ask answered by Claude (no API key) |
| `/api/organize`, `/api/dev-unlock` | laptop only |
| `/api/contact` | saved in the database (phones can't reach the webhook) |

**Sync:** set `mobile_sync_dir` in `config.json` to a Google Drive for desktop folder. Each scan
writes `roost-sync.json.gz` there; the Sync button reads it through the Google Drive connector.
Settings merge per section (the laptop wins only for sections changed on the laptop since the
last sync); statements added on the phone are kept.

## Rebuild after changing Roost

    cd mobile
    mkdir -p vendor && cd vendor
    for p in pako@2.1.0 buffer@6.0.3 base64-js@1.5.1 ieee754@1.2.1; do npm pack $p && mkdir -p ${p/@/-} && tar xzf ${p/@/-}.tgz -C ${p/@/-}; done
    cd .. && node build.js        # -> dist/index.html, then publish it to the Roost Mobile artifact

The build stops with a clear error if Roost's `index.html` changed in a spot it patches.
