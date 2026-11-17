'use strict';
// Aggregate tests — zero dependencies, synthetic records only (no PII).
// Run: node test/aggregate.test.js
const assert = require('assert');
const { buildSummary } = require('../aggregate.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const item = (section, policy, client, product, carrier, payable, premium) =>
  ({ section, policy, client, product, carrier, premium: premium || 0, comm_pct: 0, payable,
     agents: [{ name: 'JANE AGENT', level: 100 }] });

const mk = (date, items, opts = {}) => {
  const sum = s => items.filter(i => i.section === s).reduce((a, i) => a + i.payable, 0);
  const adv = sum('advances'), res = sum('commission'), cb = sum('chargebacks');
  return { file: date + '.pdf', holder: 'Jane Agent', date, year: +date.slice(0, 4),
    pending: !!opts.pending, paid: opts.pending ? false : true,
    no_pay_reason: opts.pending ? 'below_minimum' : null,
    pay_period_net: opts.pending ? res : (adv + res + cb),
    advances_total: adv, residual_total: res, chargebacks_total: cb,
    pending_total: opts.pending ? res : 0,
    ytd_advances: 0, ytd_commission: 0, ytd_chargebacks: 0, ytd_total: 0, items };
};

// Six consecutive weekly statements. ALICE buys an annuity (P1), it's clawed back
// and reissued as a longer annuity (P2) = a rewrite. BOB's policy (Q9) is a true
// chargeback. The 4th week is an "issued but unpaid" pending statement. The last
// week also carries an office-expense FEE in the chargeback section (not a clawback).
const recs = [
  mk('2026-01-07', [item('advances', 'P1', 'TEST, ALICE', 'ATHENE PERF ELITE 10', 'Athene', 500, 1000)]),
  mk('2026-01-14', [item('commission', 'P1', 'TEST, ALICE', 'ATHENE PERF ELITE 10', 'Athene', 20)]),
  mk('2026-01-21', [item('advances', 'Q9', 'OTHER, BOB', 'HUMANA MEDADVANTAGE', 'Humana', 300)]),
  mk('2026-01-28', [item('commission', 'P1', 'TEST, ALICE', 'ATHENE PERF ELITE 10', 'Athene', 20)], { pending: true }),
  mk('2026-02-04', [item('chargebacks', 'P1', 'TEST, ALICE', 'ATHENE PERF ELITE 10', 'Athene', -100),
                    item('advances', 'P2', 'TEST, ALICE', 'ATHENE PERF ELITE 15', 'Athene', 600, 1200)]),
  mk('2026-02-11', [item('chargebacks', 'Q9', 'OTHER, BOB', 'HUMANA MEDADVANTAGE', 'Humana', -80),
                    item('chargebacks', '', '', 'Office Expense Fee 25/350', 'Fees', -25)]),
];
const s = buildSummary(recs, {});

// ---- rewrites ------------------------------------------------------------
eq(s.rewrites.count, 1, 'rewrites: one rewrite detected');
eq(s.rewrites.from_chargeback, 1, 'rewrites: it came from the initial-commission window');
const ev = s.rewrites.events[0];
ok(ev && ev.from_product === 'ATHENE PERF ELITE 10' && ev.to_product === 'ATHENE PERF ELITE 15',
  'rewrites: 10-yr annuity reissued as a 15-yr is captured as from -> to');

// ---- chargebacks: MISC/fees excluded, split reconciles -------------------
eq(s.chargebacks.total, -180, 'chargebacks: only policy clawbacks counted (-100 + -80); the -25 fee is excluded');
ok(!s.chargebacks.top.some(t => t.carrier === 'Fees'), 'chargebacks: no fee lines in the clawback list');
eq(s.chargebacks.true_chargebacks.amount, -80, 'chargebacks: BOB is a true chargeback');
eq(s.chargebacks.rewrites.amount, -100, 'chargebacks: ALICE\'s clawback is a rewrite');
ok(Math.abs(s.chargebacks.true_chargebacks.amount + s.chargebacks.rewrites.amount - s.chargebacks.total) < 0.01,
  'chargebacks: true + rewrite = total');

// ---- chargeback figures stay in sync across the app ----------------------
// The insights chargeback-rate must also exclude the fee: policy clawbacks are
// -180 on 1400 advanced = ~0.129 (not 205/1400 if the -25 fee leaked in).
ok(Math.abs(s.insights.stats.chargeback_rate - 0.129) < 0.005,
  'sync: insights chargeback rate uses policy clawbacks only (fee excluded)');
// Book Health's chargeback component scores off TRUE chargebacks (rewrites excluded).
const cbComp = s.health.components.find(c => c.key === 'chargebacks');
ok(cbComp && /rewrites.*excluded|excluded/.test(cbComp.detail),
  'sync: Book Health chargeback control is based on true chargebacks (rewrites/fees excluded)');

// ---- no-pay weeks counted, not flagged missing ---------------------------
eq(s.review.counts.gaps, 0, 'review: the pending (no-pay) week counts as covered, so no false gap');
eq(s.review.counts.no_pay, 1, 'review: the pending week is surfaced as a no-pay week');

// ---- trips / 1099 incentives: carved out of income AND chargebacks (net $0) ----
// ASB books a trip as an imputed-value income line plus an offsetting reversal the same week.
// It's taxable value you won, not cash — so it must not inflate bonus income, must not count
// as a chargeback, and must leave net untouched. The imputed value surfaces under trips.
const tripRecs = [
  mk('2026-03-06', [
    item('advances', 'A1', 'SMITH, JO', 'HUMANA MEDADVANTAGE', 'Humana', 300),
    item('commission', '1099MISC_TRIPS', 'TRIPS, 1099MISC', 'MISC', 'Bonus / Adjustment', 7000),
    item('chargebacks', '1099MISC_TRIPS', 'TRIPS, 1099MISC', 'MISC', 'Bonus / Adjustment', -7000),
  ]),
];
const st = buildSummary(tripRecs, {});
eq(st.trips.total, 7000, 'trips: imputed value = the positive 1099 leg');
eq(st.trips.count, 1, 'trips: one trip earned');
ok(!(st.bonuses.by_kind || []).some(k => /trip|1099/i.test(k.kind)), 'trips: not counted as a bonus kind');
eq(st.bonuses.total, 0, 'trips: bonus income excludes the trip');
eq(st.chargebacks.total, 0, 'trips: the offsetting reversal is NOT counted as a chargeback');
eq((st.years.find(y => y.year === 2026) || {}).net, 300, 'trips: net is cash only (300) — the trip nets to zero');

// ---- book maturity --------------------------------------------------------
// The original 6-statement set spans ~2 months, so it's a "new" book.
ok(s.maturity, 'maturity: present on the summary');
eq(s.maturity.tier, 'new', 'maturity: a 2-month, few-statement book is "new"');
const matBig = [];
for (let m = 0; m < 14; m++) { const y = 2025 + (m >= 12 ? 1 : 0), mm = (m % 12) + 1;
  matBig.push(mk(`${y}-${String(mm).padStart(2, '0')}-10`, [item('commission', 'P1', 'X, Y', 'HUMANA MEDADVANTAGE', 'Humana', 20)])); }
const sMatBig = buildSummary(matBig, {});
eq(sMatBig.maturity.tier, 'established', 'maturity: a 14-month, 14-statement book is "established"');
ok(sMatBig.maturity.months_span >= 12, 'maturity: months_span is computed in calendar months');
const matMid = [];
for (let m = 1; m <= 6; m++) matMid.push(mk(`2026-${String(m).padStart(2, '0')}-10`, [item('commission', 'P1', 'X, Y', 'HUMANA MEDADVANTAGE', 'Humana', 20)]));
eq(buildSummary(matMid, {}).maturity.tier, 'building', 'maturity: a 6-month book is "building"');

// Convention planner baselines: per-line average points/app from YOUR history (all dates),
// replacements excluded; unwritten lines fall back to a flagged assumption.
{
  const sp = buildSummary(recs, { profile: { self_names: ['JANE AGENT'] } });
  const av = Object.fromEntries((sp.convention.avg_by_family || []).map(f => [f.family, f]));
  eq(av['Annuity'].avg_points, 150, 'planner: annuity avg = 15% of the one non-replacement annuity');
  eq(av['Annuity'].sample, 1, 'planner: the P1->P2 rewrite is excluded as a replacement');
  eq(av['Annuity'].avg_premium, 1000, 'planner: annuity avg premium is total premium');
  eq(av['Medicare Advantage'].avg_points, 2000, 'planner: MA is flat 2,000');
  ok(av['Med Supp'].default === true && av['Med Supp'].avg_points > 0 && av['Med Supp'].rate === 1.25,
    'planner: unwritten Med Supp falls back to a flagged default with the 125% rate');
}

// Convention credit (2027 ASB rules as reconciled against the ASB dashboard):
// credit date = first payment, no lag; as-earned-only policies count; splits give you your listed
// share; downline production counts toward combined only; annuity trails never count.
{
  const L = (section, policy, client, product, payable, premium, agents) =>
    ({ section, policy, client, product, carrier: 'Test', premium: premium || 0, comm_pct: 0, payable, agents: agents || [] });
  const DL = [{ name: 'DOWN LINE', level: 100 }];
  const months = ['2025-12-03', '2026-01-07', '2026-01-28', '2026-02-04', '2026-03-04', '2026-04-01', '2026-05-06', '2026-06-03'];
  const cv = months.map(d => {
    const its = [L('commission', 'OLDH', 'OLD, HOSP', 'CLI HOSP INDM', 4, 60)];          // existing book, pays monthly
    if (d === '2026-01-28') its.push(L('advances', 'JANADV', 'JAN, ADV', 'FINAL EXP', 300, 20));        // paid before Feb 1
    if (d === '2026-02-04') its.push(L('advances', 'FEBADV', 'FEB, ADV', 'FINAL EXP', 300, 20));        // 20*12*2.5 = 600
    if (d >= '2026-03-04') its.push(L('commission', 'NEWH', 'NEW, HOSP', 'CLI HOSP INDM', 15, 50));      // as-earned new: 1500
    if (d === '2026-03-04') {
      its.push(L('commission', 'ANNTRAIL', 'TRAIL, ANN', 'ATHENE PERF ELITE 10', 40, 250000));          // trail: never counts
      its.push(L('advances', 'PEER', 'PEER, SPLIT', 'FINAL EXP', 150, 40, [{ name: 'PEER AGENT', level: 50 }]));  // 1200 * 50% = 600
      its.push(L('advances', 'DSOLO', 'DL, SOLO', 'FINAL EXP', 50, 40, DL));                            // downline only: 1200
      its.push(L('advances', 'DSPLIT', 'DL, SPLIT', 'FINAL EXP', 150, 40, [{ name: 'DOWN LINE', level: 50 }])); // 600 me / 600 DL
    }
    return mk(d, its);
  });
  const c = buildSummary(cv, {}).convention;
  eq(c.pay_lag_days, 0, 'convention: no issue->payment lag by default');
  eq(Math.round(c.personal_points), 600 + 1500 + 600 + 600, 'convention: personal = Feb advance + as-earned new + your split shares');
  eq(Math.round(c.downline_points), 1200 + 600, 'convention: downline = solo downline policy + their split share (peer share counts nowhere)');
  eq(Math.round(c.combined_points), Math.round(c.personal_points + c.downline_points), 'convention: combined = personal + downline');
  ok(!c.policies.some(p => p.policy === 'ANNTRAIL' || p.policy === 'OLDH' || p.policy === 'JANADV'),
    'convention: annuity trails, the existing book and pre-window payments are not credited');
  // Short history: a policy already on the books first "appears" at the earliest statement; it must not count.
  const short = buildSummary(cv.filter(r => r.date >= '2026-02-04'), {}).convention;
  ok(!short.policies.some(p => p.policy === 'OLDH'), 'convention: existing as-earned book is not new business on a short history');
  ok(!short.policies.some(p => p.policy === 'NEWH'), 'convention: as-earned policy within 45 days of the earliest statement is ambiguous and skipped');
}

console.log('aggregate: ' + n + ' checks passed');
