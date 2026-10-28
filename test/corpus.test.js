'use strict';
// Corpus smoke test — runs against the user's real Statements folder when present
// (e.g. on their own machine). Skips cleanly on a fresh checkout that has none, so
// it never fails in CI or for someone without the private statements.
// Run: node test/corpus.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { extractText, extractPages } = require('../pdftext.js');
const { parseStatement, parseStatementNew, isNewFormat } = require('../parser.js');
const { buildSummary } = require('../aggregate.js');

function findStatementsDir() {
  const here = __dirname;
  const candidates = [
    path.join(here, '..', '..', 'Statements'), // Commissions/Statements (default)
    path.join(here, '..', '..'),               // years at the Commissions root (legacy)
  ];
  const hasYears = d => { try { return fs.readdirSync(d).some(x => /^\d{4}$/.test(x)
    && fs.statSync(path.join(d, x)).isDirectory()); } catch { return false; } };
  return candidates.find(hasYears) || null;
}

const base = findStatementsDir();
if (!base) {
  console.log('corpus: skipped (no Statements folder found — nothing to smoke-test)');
  process.exit(0);
}

function parse(f) {
  const buf = fs.readFileSync(f);
  const text = extractText(buf);
  return isNewFormat(text) ? parseStatementNew(extractPages(buf), text, f) : parseStatement(text, f);
}

let n = 0, scanned = 0, errors = 0, netFails = 0;
const recs = [];
for (const y of fs.readdirSync(base).filter(x => /^\d{4}$/.test(x)).sort()) {
  const dir = path.join(base, y);
  for (const f of fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.pdf'))) {
    scanned++;
    let r;
    try { r = parse(path.join(dir, f)); } catch { errors++; continue; }
    if (!r.date) continue;
    recs.push(r);
    if (!r.pending) {
      const sum = Math.round((r.advances_total + r.residual_total + r.chargebacks_total) * 100) / 100;
      if (Math.abs(sum - r.pay_period_net) > 0.02) netFails++;
    }
  }
}

assert.ok(scanned > 0, 'corpus: found statements to parse'); n++;
assert.strictEqual(errors, 0, 'corpus: every statement parses without throwing'); n++;
assert.strictEqual(netFails, 0, 'corpus: net identity holds for every non-pending statement'); n++;

// The whole book aggregates without error and the chargeback split reconciles.
const s = buildSummary(recs, {});
assert.ok(s && s.chargebacks, 'corpus: buildSummary returns a summary'); n++;
assert.ok(Math.abs(s.chargebacks.true_chargebacks.amount + s.chargebacks.rewrites.amount
  - s.chargebacks.total) < 0.01, 'corpus: chargeback true + rewrite = total'); n++;

console.log('corpus: ' + n + ' checks passed (' + recs.length + ' statements, ' + scanned + ' files)');
