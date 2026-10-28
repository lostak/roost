'use strict';
// Parser tests — zero dependencies, no real statements (synthetic input only, so no PII).
// Run: node test/parser.test.js
const assert = require('assert');
const { parseStatement, parseStatementNew, isNewFormat } = require('../parser.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---- 1. Old single-line statement format ---------------------------------
const OLD = [
  'Commission Statement',
  'Jane Agent',
  'Pay Period (10/14/2026): $450.00',
  'Deposit ( 1234): 100%',
  'YTD Advances & Initial Annuity Payouts: $1,000.00',
  'YTD Commission Earnings: $500.00',
  'YTD Chargebacks & Expense Adjustments: $-50.00',
  'YTD Total: $ 1,450.00',
  'Advances & Initial Annuity Payouts',
  'Policy # Client Name Product Eff Date Prem Due Mode Premium Comm % Writing Agent',
  'A1001 SMITH, JOHN AIG GIWL 10/03/2026 10/14/2026 M $100.00 30.000 $300.00 JANE AGENT (100)',
  'Commission Earnings Year To Date',
  'B2002 DOE, MARY HUMANA MEDADVANTAGE 09/01/2026 10/01/2026 M $0.00 0.000 $200.00 JANE AGENT (100)',
  'Chargebacks & Expense Adjustments',
  'A1001 SMITH, JOHN AIG GIWL 10/03/2026 10/14/2026 M $-100.00 30.000 $-50.00 JANE AGENT (100)',
].join('\n');

const r = parseStatement(OLD, '10-14-26.pdf');
eq(r.holder, 'Jane Agent', 'old: holder read from the line after the title');
eq(r.date, '2026-10-14', 'old: date read from the pay-period line, not the filename');
eq(r.advances_total, 300, 'old: advances section total');
eq(r.residual_total, 200, 'old: commission section total');
eq(r.chargebacks_total, -50, 'old: chargebacks section total');
eq(r.pay_period_net, 450, 'old: net read from the statement');
ok(Math.abs((r.advances_total + r.residual_total + r.chargebacks_total) - r.pay_period_net) < 0.01,
  'old: net identity (advances + residual + chargebacks = net)');
eq(r.items.length, 3, 'old: one item per statement row');
eq(r.items[0].carrier, 'AIG', 'old: carrier detected from product text');
eq(r.paid, true, 'old: a normal positive-net statement is paid');

// ---- 2. "Issued but unpaid" pending statements ---------------------------
const PEND = [
  'Pending Commission Statement', 'Jane Agent', '01/15/2026',
  'Pay Period: $ 42.00', 'Year To Date: $ 0',
  'C3003 LEE, SAM UNL HOSP INDEMNITY 01/01/2026 01/15/2026 M $10.00 2.0 $42.00 JANE AGENT (100)',
].join('\n');
const p = parseStatement(PEND, '1-15-26.pdf');
eq(p.date, '2026-01-15', 'pending: date read from the statement, not the filename');
eq(p.pending, true, 'pending: flagged pending');
eq(p.paid, false, 'pending: nothing was paid');
eq(p.no_pay_reason, 'below_minimum', 'pending: $42 is below the weekly payout minimum');

const PEND_NEG = ['Pending Commission Statement', 'Jane Agent', '02/01/2026',
  'Pay Period: $ -30.00', 'Year To Date: $ 0'].join('\n');
eq(parseStatement(PEND_NEG, '2-1-26.pdf').no_pay_reason, 'chargebacks',
  'pending: a negative net is a chargeback-driven no-pay week');

// ---- 3. New column format (synthetic glyph runs) -------------------------
// A minimal page of {x,y,size,t} runs at the real ASB column x-positions, with a
// section header, a column header, and one data row whose client ("WELLS, AMY")
// and product wrap onto extra y-lines in their columns.
const run = (x, y, t) => ({ x, y, size: 10, t });
const page = [
  run(21.7, 332, 'Advances &'),
  run(21.7, 320, 'Policy #'), run(96.9, 320, 'Client Name'), run(172, 320, 'Product'),
  run(247.2, 320, 'Eff Date'), run(472.6, 320, 'Premium'), run(547.7, 320, 'Comm %'),
  run(622.9, 320, 'Payable Comm'), run(725.5, 320, 'Agent'),
  run(172, 305, 'ATHENE PERF'),
  run(21.7, 300, 'Z9001'), run(96.9, 300, 'WELLS,'), run(172, 300, 'ELITE 10 AGES 76-'),
  run(247.2, 300, '03/01/2026'), run(322.3, 300, '03/12/2026'), run(397.5, 300, 'M'),
  run(472.6, 300, '$1000.00'), run(547.7, 300, '2.000'), run(622.9, 300, '$120.00'), run(698, 300, 'JANE AGENT (100)'),
  run(96.9, 295, 'AMY'), run(172, 295, '78'),
];
const NTEXT = ['Commission Statement', 'Jane Agent', 'Pay Period (03/12/2026): $120.00',
  'YTD Advances & Initial Annuity Payouts: $0.00', 'Advances &',
  'Policy # Client Name Product Eff Date Prem Due Mode Premium Comm % Payable Comm Writing Agent'].join('\n');

ok(isNewFormat(NTEXT), 'new: format detected from the column header / split section title');
ok(!isNewFormat(OLD), 'old: not misdetected as the new format');

const nr = parseStatementNew([page], NTEXT, '3-12-26.pdf');
eq(nr.date, '2026-03-12', 'new: date read from the statement');
eq(nr.items.length, 1, 'new: one item parsed from the data row');
eq(nr.items[0].policy, 'Z9001', 'new: policy from the policy column');
eq(nr.items[0].client, 'WELLS, AMY', 'new: split client name reassembled from two y-lines');
eq(nr.items[0].carrier, 'Athene', 'new: carrier detected from the product column');
eq(nr.items[0].premium, 1000, 'new: premium from the numeric band');
eq(nr.items[0].payable, 120, 'new: payable from the numeric band');
eq(nr.advances_total, 120, 'new: section total from the data row');

// ---- 4. Adaptive columns: a shifted/stretched grid still parses ----------
const shifted = page.map(p => ({ ...p, x: p.x * 1.15 + 40 }));
const sr = parseStatementNew([shifted], NTEXT, '3-12-26.pdf');
eq(sr.advances_total, 120, 'adaptive: totals unchanged when the column grid shifts');
eq(sr.items[0] && sr.items[0].client, 'WELLS, AMY', 'adaptive: client still reassembled after shift');

console.log('parser: ' + n + ' checks passed');
