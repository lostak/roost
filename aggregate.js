'use strict';
// ---- aggregation: parsed statement records -> dashboard JSON payload ----
const { buildClientSummaries } = require('./clients.js');
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const num = x => (x == null ? 0 : Number(x));

// Classify a product string into a broad family so we can analyze economics by line
// of business (they behave very differently: upfront vs. trail, chargeback risk, etc.).
function productFamily(product) {
  const p = (product || '').toUpperCase();
  if (/MED\s?ADV|MEDADVANTAGE|\bMAPD\b|\bMA\b/.test(p)) return 'Medicare Advantage';
  if (/MED\s?SUPP|MEDSUPP|MEDIGAP|SUPPLEMENT|SUPP\b/.test(p)) return 'Med Supp';
  if (/\bPDP\b|PART\s?D|PRESCRIPTION|\bRX\b/.test(p)) return 'Part D (PDP)';
  if (/HOSP|INDEMNITY|\bHIP\b|RECOVERY\s?CARE|CANC|\bCNC\b|HRT|STRK|STROKE|HEART|CRITICAL|ACCIDENT/.test(p)) return 'Hospital / Supplemental';
  if (/DENTAL|VISION|\bDVH\b|D\/V\/H|HEARING/.test(p)) return 'Dental / Vision';
  if (/ANNUIT|\bMYGA\b|\bFIA\b|\bSPIA\b|PERF\s?ELITE|ACCUMAX|ACCUMULATOR|TETON|PERFORM|RETIRE\s?PRO|AGILITY|EAGLE\s?SELECT|\bTARGET\b|\bASCENT\b/.test(p)) return 'Annuity';
  if (/LIFE|FINAL\s?EXP|FINALEXP|WHOLE\s?LIFE|\bWL\b|\bTERM\b|LIVING\s?PROMISE|\bIUL\b|EXPENSE|\bSIWL\b|\bGIWL\b|IMM\s?BEN|IMMEDIATE\s?SOLUTIONS|SIMPLINOW|GOLDSOLFE|GREAT\s?ASSURANCE|LEGACY|\bFE\b|\bFDC\b/.test(p)) return 'Life / Final Expense';
  return 'Other';
}

function dayOfYear(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const start = Date.UTC(y, 0, 0);
  const cur = Date.UTC(y, m - 1, d);
  return Math.floor((cur - start) / 86400000);
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ---- Medicare Advantage reclassification ----------------------------------
// MA plans book BOTH the initial commission and the recurring residual in the
// statement's "Commission Earnings" (residual) section. The initial payment is
// really new business. We detect it by magnitude: an item whose payable is far
// larger than that policy's typical recurring residual (e.g. $15/mo shows up as
// $200) is the up-front commission, so we move it to new business. Works on the
// records in place (they are clones -- see buildSummary) and rebuilds the
// per-record advances/residual split from the item sections.
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function reclassifyMA(records, opts) {
  opts = opts || {};
  const byPol = {}, allComm = [];
  for (const r of records)
    for (const it of (r.items || []))
      if (it.section === 'commission' && it.payable > 0) {
        allComm.push(it.payable);
        if (it.policy) (byPol[it.policy] ||= []).push(it.payable);
      }
  if (!allComm.length) return { moved: 0, dollars: 0, global_median: 0, floor: 0, mult: 0 };
  const gMed = median(allComm);
  const polBase = {};
  for (const k in byPol) if (byPol[k].length >= 3) polBase[k] = median(byPol[k]);
  const MULT = opts.mult != null ? opts.mult : 3.5;   // an initial is ~12x a monthly residual
  const FLOOR = Math.max(opts.floor_min != null ? opts.floor_min : 80, round2(gMed * 3)); // never touch small recurring amounts
  // New business for an MA policy is the first-enrollment payout cluster: the initial
  // commission PLUS the initial-enrollment bonus, which land in the same enrollment
  // window (same day up to a few months apart). Large payouts in LATER years are
  // renewals -- a payout on an existing line of business -- and must stay residual.
  // We also never touch a policy that already booked a real advance elsewhere: its
  // commission lines are renewals/residual, not another new-business event.
  const ENROLL_WINDOW_DAYS = 150; // initial + enrollment bonus fall within this of the first payout
  const hasAdvance = new Set();
  for (const r of records) for (const it of (r.items || []))
    if (it.section === 'advances' && it.policy) hasAdvance.add(it.policy);

  const candByPol = {};   // policy -> [all qualifying commission lines]
  for (const r of records) {
    for (const it of (r.items || [])) {
      if (it.section !== 'commission' || !(it.payable > 0)) continue;
      // Only reclassify genuine policy commissions -- skip bonus/trip/adjustment/MISC
      // lines (1099-MISC trips, earnings adjustments, agency bonuses). These are not
      // MA initials; they just happen to be large and sit in the commission section.
      if (!it.policy || it.product === 'MISC' ||
          /BONUS|ADJUST|1099|TRIP|EXPENSE|EARNINGS/i.test(`${it.policy} ${it.client} ${it.product}`)) continue;
      if (hasAdvance.has(it.policy)) continue;   // policy already had its new-business event
      const base = polBase[it.policy] != null ? polBase[it.policy] : gMed;
      if (!(it.payable >= base * MULT && it.payable >= FLOOR)) continue;
      (candByPol[it.policy] ||= []).push({ it, date: r.date || '', payable: it.payable, r });
    }
  }
  let moved = 0, dollars = 0; const touched = new Set();
  for (const k in candByPol) {
    const list = candByPol[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const first = Date.parse(list[0].date + 'T00:00:00Z');
    for (const c of list) {                       // enrollment cluster = new business; later = renewal (residual)
      const d = Date.parse(c.date + 'T00:00:00Z');
      if (isFinite(first) && isFinite(d) && (d - first) / 86400000 > ENROLL_WINDOW_DAYS) break;
      c.it.section = 'advances'; c.it.ma_initial = true;
      moved++; dollars += c.payable; touched.add(c.r);
    }
  }
  for (const r of touched) {                      // rebuild affected records' section totals
    let adv = 0, res = 0;
    for (const it of (r.items || [])) {
      if (it.section === 'advances') adv += it.payable;
      else if (it.section === 'commission') res += it.payable;
    }
    r.advances_total = round2(adv);
    r.residual_total = round2(res);
  }
  return { moved, dollars: round2(dollars), global_median: round2(gMed), floor: FLOOR, mult: MULT };
}

// ---- bonus / override / adjustment reclassification -----------------------
// The statement's "Commission Earnings" section also carries comp that is NOT
// recurring policy residual: 1099-MISC trips, production bonuses, agency
// overrides, and earnings adjustments. These have no real policy number (or a
// sentinel like 99999) and carry tell-tale text (BONUS / TRIP / OVERRIDE / ...).
// Leaving them in residual produces large one-off spikes, so we move them to a
// separate 'bonus' section and recompute every record's section totals. Genuine
// residuals with alphanumeric policy IDs (e.g. Devoted's DAGJZU) are untouched.
const BONUS_RE = /BONUS|ADJUST|1099|TRIP|OVERRIDE|COMPENSATION|EARNINGS/i;
function bonusKind(it) {
  const hay = `${it.policy || ''} ${it.client || ''} ${it.product || ''}`;
  if (/1099|TRIP/i.test(hay)) return 'Trip / 1099 incentive';
  if (/OVERRIDE/i.test(hay)) return 'Override';
  if (/ADJUST|EARNINGS/i.test(hay)) return 'Earnings adjustment';
  if (/BONUS|COMPENSATION/i.test(hay)) return 'Production bonus';
  return 'Other comp';
}
function isBonusLine(it) {
  return it.carrier === 'Bonus / Adjustment' || it.product === 'MISC' || it.policy === '99999'
    || BONUS_RE.test(`${it.policy || ''} ${it.client || ''} ${it.product || ''} ${it.carrier || ''}`);
}
function classifyBonuses(records) {
  let count = 0, dollars = 0;
  for (const r of records) {
    for (const it of (r.items || [])) {
      if (it.section === 'commission' && it.payable > 0 && isBonusLine(it)) {
        it.section = 'bonus'; it.bonus_kind = bonusKind(it);
        count++; dollars += it.payable;
      }
    }
    // recompute all section totals from items so downstream stays consistent
    let adv = 0, res = 0, cbk = 0, bon = 0;
    for (const it of (r.items || [])) {
      if (it.section === 'advances') adv += it.payable;
      else if (it.section === 'commission') res += it.payable;
      else if (it.section === 'chargebacks') cbk += it.payable;
      else if (it.section === 'bonus') bon += it.payable;
    }
    r.advances_total = round2(adv); r.residual_total = round2(res);
    r.chargebacks_total = round2(cbk); r.bonus_total = round2(bon);
  }
  return { count, dollars: round2(dollars) };
}

function buildSummary(allRecords, config) {
  config = config || {};
  // Work on deep-ish clones so this module never mutates the server's parse cache.
  const cloned = allRecords.map(r => ({ ...r, items: (r.items || []).map(it => ({ ...it })) }));
  const records = cloned.filter(r => !r.pending);
  const pendingRecs = cloned.filter(r => r.pending);
  const reclass = reclassifyMA(records, config.ma_reclass);
  const bonusInfo = classifyBonuses(records);

  const byYear = {};
  for (const r of records) (byYear[r.year] ||= []).push(r);
  const allYears = Object.keys(byYear).map(Number).sort((a, b) => a - b);

  // ---- bonuses & overrides (separated out of residual) ----
  const bonusItems = [];
  for (const r of records) for (const it of (r.items || [])) if (it.section === 'bonus')
    bonusItems.push({ date: r.date, year: r.year, kind: it.bonus_kind || 'Other comp',
      carrier: it.carrier, client: it.client, product: it.product, amount: round2(it.payable) });
  const bKind = {}, bYear = {}, bSeries = {};
  for (const b of bonusItems) {
    (bKind[b.kind] ||= { kind: b.kind, total: 0, count: 0 });
    bKind[b.kind].total += b.amount; bKind[b.kind].count++;
    bYear[b.year] = (bYear[b.year] || 0) + b.amount;
    bSeries[b.date] = (bSeries[b.date] || 0) + b.amount;
  }
  const bonuses = {
    total: round2(bonusItems.reduce((s, b) => s + b.amount, 0)),
    count: bonusItems.length,
    by_kind: Object.values(bKind).map(k => ({ ...k, total: round2(k.total) })).sort((a, b) => b.total - a.total),
    by_year: Object.fromEntries(allYears.map(y => [y, round2(bYear[y] || 0)])),
    series: Object.entries(bSeries).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, amount]) => ({ date, amount: round2(amount) })),
    top: bonusItems.slice().sort((a, b) => b.amount - a.amount).slice(0, 30),
    items: bonusItems.slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
  };

  // ---- per-year rollups (with authoritative YTD from latest statement) ----
  const years = [];
  for (const year of allYears) {
    const recs = byYear[year];
    const adv = recs.reduce((s, r) => s + num(r.advances_total), 0);
    const res = recs.reduce((s, r) => s + num(r.residual_total), 0);
    const cbk = recs.reduce((s, r) => s + num(r.chargebacks_total), 0);
    const bon = recs.reduce((s, r) => s + num(r.bonus_total), 0);
    const net = recs.reduce((s, r) => s + num(r.pay_period_net), 0);
    const latest = recs.reduce((a, b) => (a.date > b.date ? a : b));
    years.push({
      year, statements: recs.length,
      advances: round2(adv), residual: round2(res), chargebacks: round2(cbk), bonus: round2(bon),
      net: round2(net), gross: round2(adv + res),
      avg_per_statement: recs.length ? round2(net / recs.length) : 0,
      ytd_advances: latest.ytd_advances, ytd_commission: latest.ytd_commission,
      ytd_chargebacks: latest.ytd_chargebacks, ytd_total: latest.ytd_total,
      last_statement: latest.date,
    });
  }

  // ---- enrollments: count a new policy once, on the date of its first advance ----
  const enrollFirst = {};
  for (const r of records) for (const it of (r.items || []))
    if (it.section === 'advances' && it.policy && (!enrollFirst[it.policy] || r.date < enrollFirst[it.policy]))
      enrollFirst[it.policy] = r.date;
  const enrollByDate = {};
  for (const p in enrollFirst) { const d = enrollFirst[p]; enrollByDate[d] = (enrollByDate[d] || 0) + 1; }

  // ---- per-statement time series ----
  const series = records.map(r => ({
    date: r.date, year: r.year,
    net: num(r.pay_period_net), advances: num(r.advances_total),
    residual: num(r.residual_total), chargebacks: num(r.chargebacks_total),
    bonus: num(r.bonus_total), enrollments: enrollByDate[r.date] || 0,
  }));

  // ---- residual & new-business by carrier ----
  const carrierResidual = {}, carrierNew = {};
  for (const r of records) {
    for (const it of r.items) {
      if (it.section === 'commission') {
        (carrierResidual[it.carrier] ||= {});
        carrierResidual[it.carrier][r.year] = (carrierResidual[it.carrier][r.year] || 0) + it.payable;
      } else if (it.section === 'advances') {
        (carrierNew[it.carrier] ||= {});
        carrierNew[it.carrier][r.year] = (carrierNew[it.carrier][r.year] || 0) + it.payable;
      }
    }
  }
  function carrierTable(src) {
    const rows = [];
    for (const [carrier, ymap] of Object.entries(src)) {
      const row = { carrier, total: round2(Object.values(ymap).reduce((a, b) => a + b, 0)) };
      for (const y of allYears) row[y] = round2(ymap[y] || 0);
      rows.push(row);
    }
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }

  // ---- per-(date, carrier) income so the UI can bucket carrier charts by any timeframe ----
  const csMap = {};
  for (const r of records) {
    for (const it of r.items) {
      if (it.section !== 'advances' && it.section !== 'commission') continue;
      const k = r.date + '|' + it.carrier;
      const e = (csMap[k] ||= { date: r.date, carrier: it.carrier, nb: 0, res: 0 });
      if (it.section === 'advances') e.nb += it.payable; else e.res += it.payable;
    }
  }
  const carrierSeries = Object.values(csMap)
    .map(e => ({ date: e.date, carrier: e.carrier, nb: round2(e.nb), res: round2(e.res) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // ---- per-policy residual tracker ----
  const polMap = {};
  for (const r of records) {
    for (const it of r.items) {
      if (it.section === 'commission' && it.policy) {
        const p = (polMap[it.policy] ||= { client: '', carrier: '', product: '', years: {}, count: 0 });
        p.client = it.client || p.client;
        p.carrier = it.carrier;
        p.product = it.product || p.product;
        p.years[r.year] = (p.years[r.year] || 0) + it.payable;
        p.count += 1;
      }
    }
  }
  const policies = [];
  for (const [policy, d] of Object.entries(polMap)) {
    const row = { policy, client: d.client, carrier: d.carrier, product: d.product,
      payments: d.count, total: round2(Object.values(d.years).reduce((a, b) => a + b, 0)) };
    for (const y of allYears) row[y] = round2(d.years[y] || 0);
    policies.push(row);
  }
  policies.sort((a, b) => b.total - a.total);

  // ---- downline: agents you earn an override on -------------------------------
  // Simple, data-driven rule: a writing agent is YOUR downline if they ever appear
  // at level (100) on your statements (they took the full writing comp beneath you).
  // We then roll up ALL of that agent's production as your downline production, and
  // track when they first appeared (when they joined your downline).
  const normName = s => (s || '').toUpperCase().replace(/[^A-Z]/g, '');
  const prettyName = s => (s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
    .replace(/\bLlc\b/g, 'LLC').replace(/\s+/g, ' ').trim();
  const secKey = s => (s === 'advances' ? 'advances' : s === 'commission' ? 'residual'
    : s === 'chargebacks' ? 'chargebacks' : null);
  // Only actual client policies written by a person count for downline — not house /
  // accounting lines (interest on chargebacks, production bonuses, overrides, earnings
  // adjustments). Those name the "client" after the accounting entry, e.g.
  // "INTEREST, ACC", "BONUS-MCA HUMANA, OVERRIDE", "ADJ ADJUSTMENT, EARNINGS".
  const HOUSE_RE = /\b(INTEREST|BONUS|OVERRIDE|ADJUSTMENT|EARNINGS|COMPENSATION|1099|TRIP|AWARD|CONTEST|EAPP|VBE)\b/i;
  const isRealPolicy = it => !!it.policy && it.product !== 'MISC' && !HOUSE_RE.test(it.client || '');
  // pass 1 — collect every real-policy writing agent, and who ever hits level 100 (auto).
  // Manual overrides from config (downline_include / downline_exclude) then force agents
  // in or out, so you can correct the automatic result.
  const INC = (config.downline_include || []).map(normName).filter(Boolean);
  const EXC = (config.downline_exclude || []).map(normName).filter(Boolean);
  const allAgents = {}, autoDL = {}, agentSeen = {};
  for (const r of records) for (const it of (r.items || [])) {
    if (!secKey(it.section) || !isRealPolicy(it)) continue;
    for (const a of (it.agents || [])) {
      const k = normName(a.name); if (!k) continue;
      allAgents[k] = prettyName(a.name);
      if ((a.level || 0) >= 100) autoDL[k] = true;
      const t = (agentSeen[k] ||= { first: r.date, last: r.date, since100: null });
      if (r.date < t.first) t.first = r.date;
      if (r.date > t.last) t.last = r.date;
      if ((a.level || 0) >= 100 && (!t.since100 || r.date < t.since100)) t.since100 = r.date;
    }
  }
  const isDL = {};
  for (const k of Object.keys(allAgents)) {
    let dl = !!autoDL[k];
    if (INC.includes(k)) dl = true;
    if (EXC.includes(k)) dl = false;
    if (dl) isDL[k] = true;
  }
  // pass 2 — attribute ONLY pure-override production to the downline.
  // When you personally co-write a policy WITH a downline agent, your payable lumps your
  // own split cut together with the override on their cut — the statement never separates
  // the two. So a line only counts as downline-produced when YOU are not on the split.
  // You are off the split when the listed writing-agent levels already sum to >= 100 (you
  // hold no writing share of your own). Lines that sum to < 100 mean you hold the remaining
  // share (you co-wrote it), so they are excluded from downline production.
  const agentMap = {}, dlSeriesMap = {}, dlCarriers = {};
  const dlTotals = { advances: 0, residual: 0, chargebacks: 0, count: 0 };
  const excluded = { advances: 0, residual: 0, chargebacks: 0, count: 0 }; // co-written with you (lumped)
  const dlPolicies = [];
  const mkAgent = name => ({ name, total: 0, advances: 0, residual: 0, chargebacks: 0, count: 0,
    years: {}, carriers: {},
    cw_total: 0, cw_advances: 0, cw_residual: 0, cw_chargebacks: 0, cw_count: 0 }); // cw = co-written w/ you
  for (const r of records) {
    for (const it of (r.items || [])) {
      const sk = secKey(it.section); if (!sk || !isRealPolicy(it) || !it.agents || !it.agents.length) continue;
      const onLine = it.agents.filter(a => isDL[normName(a.name)]);
      if (!onLine.length) continue;                        // no downline agent on this line
      const lvlSum = it.agents.reduce((s, a) => s + (a.level || 0), 0);
      if (lvlSum < 100) {                                  // you hold the remainder -> lumped, exclude
        excluded[sk] += it.payable; excluded.count += 1;
        const seenX = new Set();                           // still break the excluded amount out per agent
        for (const a of onLine) {
          const key = normName(a.name); if (seenX.has(key)) continue; seenX.add(key);
          const m = (agentMap[key] ||= mkAgent(prettyName(a.name)));
          m['cw_' + sk] += it.payable; m.cw_total += it.payable; m.cw_count += 1;
        }
        continue;
      }
      const seen = new Set();
      for (const a of onLine) {
        const key = normName(a.name); if (seen.has(key)) continue; seen.add(key);
        const m = (agentMap[key] ||= mkAgent(prettyName(a.name)));
        m[sk] += it.payable; m.total += it.payable; m.count += 1;
        m.years[r.year] = (m.years[r.year] || 0) + it.payable;
        m.carriers[it.carrier] = (m.carriers[it.carrier] || 0) + it.payable;
      }
      dlTotals[sk] += it.payable; dlTotals.count += 1;
      (dlSeriesMap[r.date] ||= { advances: 0, residual: 0, chargebacks: 0 })[sk] += it.payable;
      dlCarriers[it.carrier] = (dlCarriers[it.carrier] || 0) + it.payable;
      dlPolicies.push({ date: r.date, year: r.year, policy: it.policy, client: it.client,
        carrier: it.carrier, product: it.product, section: sk, amount: round2(it.payable),
        agents: it.agents.map(a => prettyName(a.name) + ' (' + (a.level || 0) + ')').join(', ') });
    }
  }
  // Roster keeps every flagged downline agent (even one with no pure-override yet), so the
  // hierarchy / drag-and-drop config stays stable. Income comes from qualifying lines only;
  // first/last-seen timing comes from all of their appearances (agentSeen, pass 1).
  const agentList = Object.keys(isDL).map(k => {
    const m = agentMap[k] || mkAgent(allAgents[k]);
    const t = agentSeen[k] || { first: null, last: null, since100: null };
    const row = { name: m.name || allAgents[k], since: t.first, since_100: t.since100, last_seen: t.last,
      manual: !autoDL[k],   // in the downline but never auto-flagged = manually added
      count: m.count, total: round2(m.total), advances: round2(m.advances),
      residual: round2(m.residual), chargebacks: round2(m.chargebacks),
      // co-written with you (excluded from override income above), broken out per agent
      cw_count: m.cw_count, cw_total: round2(m.cw_total), cw_advances: round2(m.cw_advances),
      cw_residual: round2(m.cw_residual), cw_chargebacks: round2(m.cw_chargebacks),
      top_carrier: (Object.entries(m.carriers).sort((a, b) => b[1] - a[1])[0] || ['', 0])[0] };
    for (const y of allYears) row[y] = round2(m.years[y] || 0);
    return row;
  }).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const downlineSeries = Object.entries(dlSeriesMap).sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, year: Number(date.slice(0, 4)),
      advances: round2(v.advances), residual: round2(v.residual), chargebacks: round2(v.chargebacks),
      net: round2(v.advances + v.residual + v.chargebacks) }));
  dlPolicies.sort((a, b) => (a.date < b.date ? 1 : -1));

  // ---- downline hierarchy ----
  // Every downline agent sits directly under You by default (same level). The user can
  // nest an agent under another via drag-and-drop; those choices persist in config as
  // downline_parents { childName: parentName } and are applied here (with cycle safety).
  const byKey = {}; for (const a of agentList) byKey[normName(a.name)] = a;
  const rawParents = (config.downline_parents && typeof config.downline_parents === 'object') ? config.downline_parents : {};
  const parentOf = {};
  for (const a of agentList) {
    const k = normName(a.name);
    const pk = rawParents[a.name] ? normName(rawParents[a.name]) : null;
    parentOf[k] = (pk && byKey[pk] && pk !== k) ? pk : 'YOU'; // parent must be another downline agent
  }
  for (const c of Object.keys(parentOf)) {      // break any cycles -> attach to You
    let x = parentOf[c]; const chain = new Set([c]);
    while (x && x !== 'YOU') { if (chain.has(x)) { parentOf[c] = 'YOU'; break; } chain.add(x); x = parentOf[x]; }
  }
  function buildNode(key) {
    const a = byKey[key];
    const children = Object.keys(parentOf).filter(k => parentOf[k] === key).map(buildNode)
      .sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
    const descendants = children.reduce((s, c) => s + 1 + c.descendants, 0);
    return { name: a.name, total: a.total, count: a.count, since: a.since, since_100: a.since_100,
      advances: a.advances, residual: a.residual, chargebacks: a.chargebacks, children, descendants };
  }
  const roots = Object.keys(parentOf).filter(k => parentOf[k] === 'YOU').map(buildNode)
    .sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
  const hierarchy = { name: 'You', children: roots,
    descendants: roots.reduce((s, c) => s + 1 + c.descendants, 0) };

  const downline = {
    rule: 'Flagged as downline when an agent ever writes at level (100). Income counts only ' +
      'pure-override policies — those where you are NOT on the split (listed writing-agent ' +
      'levels sum to 100), because a policy you co-wrote lumps your own cut in with the override.',
    totals: { advances: round2(dlTotals.advances), residual: round2(dlTotals.residual),
      chargebacks: round2(dlTotals.chargebacks),
      net: round2(dlTotals.advances + dlTotals.residual + dlTotals.chargebacks), count: dlTotals.count },
    // Production you co-wrote with a downline agent (levels < 100): the override can't be
    // separated from your own split cut, so it's excluded above and reported here for context.
    co_written: { advances: round2(excluded.advances), residual: round2(excluded.residual),
      chargebacks: round2(excluded.chargebacks),
      net: round2(excluded.advances + excluded.residual + excluded.chargebacks), count: excluded.count },
    by_carrier: Object.entries(dlCarriers).map(([carrier, v]) => ({ carrier, total: round2(v) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    agents: agentList,
    agent_count: agentList.length,
    hierarchy,
    candidates: Object.entries(allAgents).filter(([k]) => !isDL[k]).map(([, v]) => v)
      .sort((a, b) => (a < b ? -1 : 1)),
    manual_include: config.downline_include || [],
    manual_exclude: config.downline_exclude || [],
    manual_parents: config.downline_parents || {},
    series: downlineSeries,
    policies: dlPolicies.slice(0, 500),
  };

  // ---- monthly breakdown (year-month buckets) ----
  const mMap = {};
  for (const r of records) {
    const key = r.date.slice(0, 7); // YYYY-MM
    const m = (mMap[key] ||= { year: r.year, month: Number(r.date.slice(5, 7)),
      advances: 0, residual: 0, chargebacks: 0, bonus: 0, net: 0, statements: 0 });
    m.advances += num(r.advances_total); m.residual += num(r.residual_total);
    m.chargebacks += num(r.chargebacks_total); m.bonus += num(r.bonus_total); m.net += num(r.pay_period_net);
    m.statements += 1;
  }
  const monthly = Object.entries(mMap).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([key, m]) => ({
    key, year: m.year, month: m.month, label: `${MONTHS[m.month - 1]} ${m.year}`,
    month_name: MONTHS[m.month - 1],
    advances: round2(m.advances), residual: round2(m.residual),
    chargebacks: round2(m.chargebacks), bonus: round2(m.bonus), net: round2(m.net),
    gross: round2(m.advances + m.residual), statements: m.statements,
  }));

  // ---- cumulative-by-year (day-of-year keyed for overlay) ----
  const cumulativeByYear = {};
  for (const year of allYears) {
    const recs = byYear[year].slice().sort((a, b) => a.date < b.date ? -1 : 1);
    let cNet = 0, cRes = 0, cAdv = 0;
    cumulativeByYear[year] = recs.map(r => {
      cNet += num(r.pay_period_net); cRes += num(r.residual_total); cAdv += num(r.advances_total);
      return { date: r.date, doy: dayOfYear(r.date),
        net: round2(cNet), residual: round2(cRes), advances: round2(cAdv) };
    });
  }

  // ---- residual run-rate projection ----
  const sortedRes = records.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  let runrate = { window_days: 0, residual_in_window: 0, monthly: 0, annual: 0,
    recent_monthly: [], last_date: null };
  if (sortedRes.length) {
    const lastDate = sortedRes[sortedRes.length - 1].date;
    runrate.last_date = lastDate;
    const lastMs = Date.parse(lastDate + 'T00:00:00Z');
    const windowDays = 90;
    const cutoff = lastMs - windowDays * 86400000;
    const inWin = sortedRes.filter(r => Date.parse(r.date + 'T00:00:00Z') >= cutoff);
    const resWin = inWin.reduce((s, r) => s + num(r.residual_total), 0);
    const firstMs = inWin.length ? Date.parse(inWin[0].date + 'T00:00:00Z') : lastMs;
    const spanDays = Math.max(1, Math.round((lastMs - firstMs) / 86400000) || windowDays);
    const perDay = resWin / spanDays;
    runrate.window_days = spanDays;
    runrate.residual_in_window = round2(resWin);
    runrate.monthly = round2(perDay * 30.437);
    runrate.annual = round2(perDay * 365);
    runrate.recent_monthly = monthly.slice(-6).map(m => ({ label: m.label, residual: m.residual }));
  }

  const latestPending = pendingRecs.length
    ? pendingRecs.reduce((a, b) => (a.date > b.date ? a : b)) : null;

  // ---------------- PROJECTIONS & INSIGHTS ----------------
  const clamp = (x, lo, hi) => (x == null ? null : Math.min(hi, Math.max(lo, x)));
  const curYear = allYears.length ? allYears[allYears.length - 1] : new Date().getFullYear();
  const curRecs = byYear[curYear] || [];
  const lastStmtMonth = curRecs.length ? Math.max(...curRecs.map(r => Number(r.date.slice(5, 7)))) : 12;
  const curPartial = lastStmtMonth < 12;
  const refYear = (allYears.includes(curYear - 1) && (byYear[curYear - 1] || []).length >= 15) ? curYear - 1 : null;

  function monthShares(recs, field) {
    const m = Array(12).fill(0); let tot = 0;
    for (const r of recs) { const v = Math.max(0, num(r[field])); m[Number(r.date.slice(5, 7)) - 1] += v; tot += v; }
    return tot > 0 ? m.map(x => round2(x / tot)) : Array(12).fill(round2(1 / 12));
  }
  const seasonSrc = refYear ? byYear[refYear] : records.filter(r => !(r.year === curYear && curPartial));
  const seasonNew = monthShares(seasonSrc.length ? seasonSrc : records, 'advances_total');
  const seasonNet = monthShares(seasonSrc.length ? seasonSrc : records, 'pay_period_net');
  let cumNewThrough = 0; for (let i = 0; i < lastStmtMonth; i++) cumNewThrough += seasonNew[i];
  cumNewThrough = Math.min(1, Math.max(0.05, cumNewThrough));
  let cumNetThrough = 0; for (let i = 0; i < lastStmtMonth; i++) cumNetThrough += seasonNet[i];
  cumNetThrough = Math.min(1, Math.max(0.05, cumNetThrough));

  const newbizYtd = round2(curRecs.reduce((s, r) => s + num(r.advances_total), 0));
  const netYtd = round2(curRecs.reduce((s, r) => s + num(r.pay_period_net), 0));
  const newbizAnnual = curPartial ? round2(newbizYtd / cumNewThrough) : newbizYtd;
  const netAnnual = curPartial ? round2(netYtd / cumNetThrough) : netYtd;
  const residualAnnual = round2(runrate.annual || 0);

  // policy-level persistence / retention (refYear -> curYear)
  const annualizeRes = curPartial ? (12 / lastStmtMonth) : 1;
  let retCount = null, retDollar = null;
  if (refYear) {
    const y0 = refYear, y1 = curYear;
    let activePrev = 0, survived = 0, basePrev = 0, keptNow = 0;
    for (const p of policies) {
      const a = num(p[y0]), bNow = num(p[y1]);
      if (a > 0) { activePrev++; basePrev += a; if (bNow > 0) { survived++; keptNow += bNow * annualizeRes; } }
    }
    if (activePrev > 0) retCount = round2(survived / activePrev);
    if (basePrev > 0) retDollar = round2(keptNow / basePrev);
  }
  const retentionDefault = clamp(retDollar, 0.45, 0.97) ?? 0.82;
  const conversionDefault = clamp(retCount, 0.55, 0.95) ?? 0.75;

  // observed new-business growth: like-for-like year over year. Compare the current
  // year's new business THROUGH the latest statement month against the prior year
  // through the same month, so a partial current year or a ramp-up first year
  // doesn't distort the comparison.
  const ytdAdv = (yr, thru) => records
    .filter(r => r.year === yr && Number(r.date.slice(5, 7)) <= thru)
    .reduce((s, r) => s + num(r.advances_total), 0);
  let growthObs = null, growthYoy = null;
  const curYtdAdv = ytdAdv(curYear, lastStmtMonth);
  for (let py = curYear - 1; py >= allYears[0]; py--) {
    if (!byYear[py]) continue;
    const prevYtd = ytdAdv(py, lastStmtMonth);
    if (prevYtd > 0) {
      growthObs = (curYtdAdv - prevYtd) / prevYtd;
      growthYoy = { from_year: py, to_year: curYear, through_month: lastStmtMonth,
        from: round2(prevYtd), to: round2(curYtdAdv) };
      break;
    }
  }
  const growthDefault = clamp(growthObs, -0.25, 0.25) ?? 0.05;  // cap for multi-year sanity

  // chargeback drag on new business
  const totCbk = records.reduce((s, r) => s + num(r.chargebacks_total), 0);
  const totAdv = records.reduce((s, r) => s + num(r.advances_total), 0);
  const chargebackRate = totAdv > 0 ? round2(Math.min(0.6, -totCbk / totAdv)) : 0;

  // observed renewal-to-initial ratio: for policies that have BOTH an up-front
  // initial (advance) and recurring residual, how much a year of residual is worth
  // relative to the initial that created it. Median across matched policies.
  const initByPol = {}, residByPol = {};
  for (const r of records) {
    for (const it of r.items) {
      if (!it.policy) continue;
      if (it.section === 'advances') initByPol[it.policy] = (initByPol[it.policy] || 0) + it.payable;
      else if (it.section === 'commission') {
        const p = (residByPol[it.policy] ||= { sum: 0, count: 0 });
        p.sum += it.payable; p.count += 1;
      }
    }
  }
  const renewalRatios = [];
  for (const pol in initByPol) {
    const I = initByPol[pol], rp = residByPol[pol];
    if (!rp || I <= 0 || rp.count < 1) continue;
    const annualResid = (rp.sum / rp.count) * 12;   // avg monthly residual annualized
    const ratio = annualResid / I;
    if (ratio > 0.02 && ratio < 3) renewalRatios.push(ratio);
  }
  const renewalObs = renewalRatios.length >= 3 ? round2(median(renewalRatios)) : null;
  const renewalDefault = clamp(renewalObs, 0.1, 1.0) ?? 0.5;

  const projections = {
    current_year: curYear, last_stmt_month: lastStmtMonth, current_partial: curPartial,
    ref_year: refYear,
    residual_annual: residualAnnual,
    newbiz_ytd: newbizYtd, newbiz_annual: newbizAnnual,
    net_ytd: netYtd, net_annual: netAnnual,
    elapsed_new: round2(cumNewThrough), elapsed_net: round2(cumNetThrough),
    seasonality_new: seasonNew, seasonality_net: seasonNet,
    hist: years.map(y => {
      // Annualize the current partial year so the trajectory compares like-for-like
      // with completed prior years (7 months of 2026 vs 12 months of 2025).
      const isCur = y.year === curYear && curPartial;
      return { year: y.year, residual: y.residual, advances: y.advances, net: y.net, partial: isCur,
        residual_annualized: isCur ? residualAnnual : y.residual,
        advances_annualized: isCur ? newbizAnnual : y.advances,
        net_annualized: isCur ? netAnnual : y.net };
    }),
    growth_yoy: growthYoy,
    observed: { retention_dollar: retDollar, retention_count: retCount,
      growth: growthObs == null ? null : round2(growthObs), renewal_ratio: renewalObs,
      chargeback_rate: chargebackRate },
    defaults: { retention: round2(retentionDefault), growth: round2(growthDefault),
      conversion: round2(conversionDefault), renewal_ratio: round2(renewalDefault),
      chargeback_rate: chargebackRate },
  };

  // ---------------- INSIGHTS ----------------
  const residualByCarrier = carrierTable(carrierResidual);
  const newByCarrier = carrierTable(carrierNew);
  const totResid = residualByCarrier.reduce((s, c) => s + c.total, 0) || 1;
  const top3Resid = residualByCarrier.slice(0, 3);
  const concentration = round2(top3Resid.reduce((s, c) => s + c.total, 0) / totResid);
  const byCarrierPol = {};
  for (const p of policies) { const c = (byCarrierPol[p.carrier] ||= { resid: 0, count: 0, pmts: 0 });
    c.resid += p.total; c.count++; c.pmts += p.payments; }
  let bestYield = null;
  for (const [carrier, c] of Object.entries(byCarrierPol)) {
    if (c.count >= 3) { const y = c.resid / c.count; if (!bestYield || y > bestYield.yield) bestYield = { carrier, yield: round2(y), count: c.count }; }
  }
  const multiYear = policies.filter(p => p.payments >= 12).length;
  const persistPct = policies.length ? round2(multiYear / policies.length) : 0;
  const avgPmts = policies.length ? round2(policies.reduce((s, p) => s + p.payments, 0) / policies.length) : 0;
  const aepShare = round2([9, 10, 11, 0].reduce((s, i) => s + seasonNew[i], 0)); // Oct,Nov,Dec,Jan
  const mres = monthly.map(m => m.residual);
  let momentum = null;
  if (mres.length >= 6) { const a = mres.slice(-3).reduce((x, y) => x + y, 0); const b = mres.slice(-6, -3).reduce((x, y) => x + y, 0);
    if (b > 0) momentum = round2((a - b) / b); }
  const residualShareNow = round2(residualAnnual / ((residualAnnual + newbizAnnual) || 1));
  let bookGrowth = null;
  if (refYear) { const ry = years.find(x => x.year === refYear); if (ry && ry.residual > 0) bookGrowth = round2((residualAnnual - ry.residual) / ry.residual); }

  const pct = x => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + Math.round(x * 100) + '%');
  const money0 = x => '$' + Math.round(x).toLocaleString('en-US');
  const working = [], watch = [], focus = [];

  working.push({ title: `Recurring book ${bookGrowth == null ? 'is building' : (bookGrowth >= 0 ? 'growing ' + pct(bookGrowth) + '/yr' : 'down ' + pct(bookGrowth))}`,
    body: `Annualized residual pace is ${money0(residualAnnual)} — ${Math.round(residualShareNow * 100)}% of your current earning pace. This is the passive income that keeps paying even without new sales.` });
  if (top3Resid[0]) working.push({ title: `${top3Resid[0].carrier} is your residual anchor`,
    body: `${top3Resid[0].carrier} is ${Math.round(top3Resid[0].total / totResid * 100)}% of recurring residual (${money0(top3Resid[0].total)}). Retention here has the biggest dollar impact on your book.` });
  if (bestYield) working.push({ title: `Best residual yield: ${bestYield.carrier}`,
    body: `${money0(bestYield.yield)} of residual per policy across ${bestYield.count} policies — your highest recurring value per enrollment.` });
  if (momentum != null && momentum >= 0) working.push({ title: `Residual momentum ${pct(momentum)} last quarter`,
    body: `Most recent 3 months of residual vs the prior 3 — the book is accelerating.` });
  if (persistPct > 0) working.push({ title: `${Math.round(persistPct * 100)}% of policies are multi-year`,
    body: `${multiYear} of ${policies.length} policies have 12+ residual payments, averaging ${avgPmts} payments each — a sticky base.` });

  if (concentration >= 0.6) watch.push({ title: `Concentration: top 3 carriers = ${Math.round(concentration * 100)}% of residual`,
    body: `A large share of recurring income rides on a few carriers. Losing one book would hit hard — spreading new enrollments reduces the risk.` });
  if (chargebackRate >= 0.15) watch.push({ title: `Chargeback drag ${Math.round(chargebackRate * 100)}% of new business`,
    body: `Clawbacks are eroding roughly ${Math.round(chargebackRate * 100)}% of advance commissions — early lapses and rapid disenrollments. Improving first-90-day retention lifts net pay directly.` });
  if (retCount != null && retCount < 0.8) watch.push({ title: `Residual persistence ~${Math.round(retCount * 100)}%`,
    body: `About ${Math.round((1 - retCount) * 100)}% of last year's paying policies stopped producing residual this year (members who left or switched). Each retained member compounds — see the retention slider.` });
  if (momentum != null && momentum < 0) watch.push({ title: `Residual momentum ${pct(momentum)} last quarter`,
    body: `The most recent quarter of residual came in below the prior quarter — worth watching for drop-off.` });

  focus.push({ title: `Retention is your highest-leverage lever`,
    body: `Every retained enrollment renews as residual, and every new enrollment converts to next year's residual. Small retention gains compound across years — try the retention slider to see the multi-year swing.` });
  if (aepShare >= 0.4) focus.push({ title: `AEP drives ${Math.round(aepShare * 100)}% of new business`,
    body: `New enrollments concentrate in Oct–Jan. Front-loading effort and follow-up into AEP has outsized payoff for both this year's advances and next year's residual base.` });
  if (newByCarrier[0]) focus.push({ title: `Scale enrollments with ${newByCarrier[0].carrier}`,
    body: `${newByCarrier[0].carrier} is your top new-business source (${money0(newByCarrier[0].total)}). If its members persist, growing enrollments there builds the recurring book fastest.` });
  if (bestYield && (!top3Resid[0] || bestYield.carrier !== top3Resid[0].carrier)) focus.push({ title: `Lean into ${bestYield.carrier} for value per policy`,
    body: `It pays the most residual per policy (${money0(bestYield.yield)}). Each enrollment here is worth more over time than an average one.` });

  const insights = { working, watch, focus,
    stats: { residual_annual: residualAnnual, residual_share: residualShareNow, book_growth: bookGrowth,
      concentration, persistence_pct: persistPct, avg_payments: avgPmts, aep_share: aepShare,
      chargeback_rate: chargebackRate, retention_count: retCount, momentum } };

  // ================= retention, chargebacks & product profitability =================
  // Reuse the per-policy lifecycle logic (advance -> residual -> lapse/chargeback) so the
  // "where am I losing money" views agree with the client spreadsheets.
  const clientSummaries = buildClientSummaries(records);
  const pols = [];
  for (const client of Object.keys(clientSummaries)) {
    for (const pol of Object.keys(clientSummaries[client])) {
      const p = clientSummaries[client][pol];
      pols.push({ client, policy: p.policy, carrier: p.carrier, product: p.product,
        family: productFamily(p.product),
        advances: round2(p.advances), residual: round2(p.residual), chargebacks: round2(p.chargebacks),
        net: round2(p.advances + p.residual + p.chargebacks),
        status: p.residual_status, hasChargeback: p.hasChargeback,
        firstAdvance: p.firstAdvance, lastResidual: p.lastResidual, payments: p.payments,
        agents: [...(p.agents || [])].join(', ') });
    }
  }
  const latestDate = records.reduce((a, r) => (!r.pending && r.date > a ? r.date : a), '0000-00-00');
  const daysAgo = d => d ? Math.round((Date.parse(latestDate + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000) : null;

  const retGroup = keyFn => {
    const g = {};
    for (const p of pols) {
      const k = keyFn(p) || 'Unknown';
      const e = (g[k] ||= { key: k, policies: 0, active: 0, lapsed: 0, no_residual: 0,
        advances: 0, residual: 0, chargebacks: 0, net: 0, cb_policies: 0 });
      e.policies++; e.advances += p.advances; e.residual += p.residual; e.chargebacks += p.chargebacks; e.net += p.net;
      if (p.status === 'Yes') e.active++; else if (p.status === 'No') e.lapsed++; else e.no_residual++;
      if (p.hasChargeback) e.cb_policies++;
    }
    return Object.values(g).map(e => ({ ...e,
      advances: round2(e.advances), residual: round2(e.residual), chargebacks: round2(e.chargebacks), net: round2(e.net),
      persistency: (e.active + e.lapsed) ? round2(e.active / (e.active + e.lapsed)) : null,
      avg_net: e.policies ? round2(e.net / e.policies) : 0 })).sort((a, b) => b.net - a.net);
  };
  const byCarrierRet = retGroup(p => p.carrier);
  const byFamily = retGroup(p => p.family);
  const active = pols.filter(p => p.status === 'Yes').length;
  const lapsed = pols.filter(p => p.status === 'No').length;
  const noRes = pols.filter(p => p.status === 'No Residual').length;
  const clawback = round2(pols.reduce((s, p) => s + Math.min(0, p.chargebacks), 0)); // total money clawed back
  const cbPolicies = pols.filter(p => p.hasChargeback).length;
  // At-risk: Medicare Advantage written inside the ~90-day rapid-disenrollment window, where a
  // disenrollment claws back the entire initial commission.
  const atRisk = pols.filter(p => p.family === 'Medicare Advantage' && p.advances > 0
      && daysAgo(p.firstAdvance) != null && daysAgo(p.firstAdvance) <= 90)
    .map(p => ({ client: p.client, policy: p.policy, carrier: p.carrier, product: p.product,
      at_risk: p.advances, written: p.firstAdvance, days_ago: daysAgo(p.firstAdvance) }))
    .sort((a, b) => b.at_risk - a.at_risk);
  const lapses = pols.filter(p => p.hasChargeback || p.status === 'No')
    .map(p => ({ client: p.client, policy: p.policy, carrier: p.carrier, product: p.product, family: p.family,
      chargebacks: p.chargebacks, net: p.net, last_residual: p.lastResidual }))
    .sort((a, b) => a.chargebacks - b.chargebacks);
  const retention = {
    latest_date: latestDate,
    totals: { policies: pols.length, active, lapsed, no_residual: noRes,
      persistency: (active + lapsed) ? round2(active / (active + lapsed)) : null,
      clawback, cb_policies: cbPolicies,
      at_risk_count: atRisk.length, at_risk_dollars: round2(atRisk.reduce((s, x) => s + x.at_risk, 0)) },
    by_carrier: byCarrierRet, by_family: byFamily,
    at_risk: atRisk.slice(0, 200), lapses: lapses.slice(0, 200),
  };
  // per-(date, family) series for By Product time charts
  const psMap = {};
  for (const r of records) for (const it of r.items) {
    if (it.section !== 'advances' && it.section !== 'commission') continue;
    const fam = productFamily(it.product), k = r.date + '|' + fam;
    const e = (psMap[k] ||= { date: r.date, family: fam, nb: 0, res: 0 });
    if (it.section === 'advances') e.nb += it.payable; else e.res += it.payable;
  }
  const productSeries = Object.values(psMap)
    .map(e => ({ date: e.date, family: e.family, nb: round2(e.nb), res: round2(e.res) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const products = { by_family: byFamily, series: productSeries };

  // ================= clients & households =================
  // Roll policies up to the client, compute what each is worth, and flag cross-sell gaps
  // (e.g. a Medicare client with no dental/vision or hospital-indemnity plan).
  const clientMap = {};
  for (const p of pols) {
    const c = (clientMap[p.client] ||= { client: p.client, surname: (p.client.split(',')[0] || p.client).trim().toUpperCase(),
      policies: 0, advances: 0, residual: 0, chargebacks: 0, net: 0, active: 0, lapsed: 0, fams: new Set(), carriers: new Set() });
    c.policies++; c.advances += p.advances; c.residual += p.residual; c.chargebacks += p.chargebacks; c.net += p.net;
    if (p.status === 'Yes') c.active++; else if (p.status === 'No') c.lapsed++;
    c.fams.add(p.family); if (p.carrier) c.carriers.add(p.carrier);
  }
  const polsByClient = {};
  for (const p of pols) (polsByClient[p.client] ||= []).push(p);
  const clientList = Object.values(clientMap).map(c => {
    const medicare = c.fams.has('Medicare Advantage') || c.fams.has('Med Supp') || c.fams.has('Part D (PDP)');
    const sug = [];
    if (medicare && !c.fams.has('Dental / Vision')) sug.push('Dental/Vision');
    if (medicare && !c.fams.has('Hospital / Supplemental')) sug.push('Hospital/cancer');
    if (c.fams.has('Med Supp') && !c.fams.has('Part D (PDP)')) sug.push('Part D');
    const detail = (polsByClient[c.client] || []).map(p => ({ policy: p.policy, carrier: p.carrier, product: p.product,
      family: p.family, advances: p.advances, residual: p.residual, chargebacks: p.chargebacks, net: p.net,
      status: p.status, first_written: p.firstAdvance, last_residual: p.lastResidual, payments: p.payments, agents: p.agents }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    return { client: c.client, surname: c.surname, policies: c.policies, families: [...c.fams], carriers: [...c.carriers],
      advances: round2(c.advances), residual: round2(c.residual), chargebacks: round2(c.chargebacks), net: round2(c.net),
      active: c.active, lapsed: c.lapsed, cross_sell: sug.join(', '), detail };
  }).sort((a, b) => b.net - a.net);
  const hh = {};
  for (const c of clientList) { const h = (hh[c.surname] ||= { surname: c.surname, members: [], net: 0, policies: 0 });
    h.members.push(c.client); h.net += c.net; h.policies += c.policies; }
  const households = Object.values(hh).filter(h => h.members.length > 1)
    .map(h => ({ surname: h.surname, clients: h.members.length, members: h.members, policies: h.policies, net: round2(h.net) }))
    .sort((a, b) => b.net - a.net);
  const clients = {
    count: clientList.length,
    avg_net: clientList.length ? round2(clientList.reduce((s, c) => s + c.net, 0) / clientList.length) : 0,
    cross_sell_count: clientList.filter(c => c.cross_sell).length,
    household_count: households.length,
    list: clientList.slice(0, 800),
    households: households.slice(0, 300),
  };

  // ================= audit & reconciliation =================
  // Trust checks: does the summed net match the printed year-to-date? Are there
  // impossible YTD reversals (off-sequence statements), missing weeks, or residual
  // payments that dropped well below a policy's own norm (possible carrier error)?
  const nonPending = records.filter(r => !r.pending).sort((a, b) => (a.date < b.date ? -1 : 1));
  const byYr = {}; for (const r of nonPending) (byYr[r.year] ||= []).push(r);
  const ytdDrops = [], cadenceGaps = [];
  for (const y of Object.keys(byYr)) {
    const rs = byYr[y];
    for (let i = 1; i < rs.length; i++) {
      if (rs[i].ytd_total != null && rs[i - 1].ytd_total != null && rs[i].ytd_total < rs[i - 1].ytd_total - 1)
        ytdDrops.push({ date: rs[i].date, ytd: round2(rs[i].ytd_total),
          prev_date: rs[i - 1].date, prev_ytd: round2(rs[i - 1].ytd_total),
          drop: round2(rs[i - 1].ytd_total - rs[i].ytd_total) });
      const days = Math.round((Date.parse(rs[i].date) - Date.parse(rs[i - 1].date)) / 86400000);
      if (days > 14) cadenceGaps.push({ from: rs[i - 1].date, to: rs[i].date, days });
    }
  }
  const reconciliation = allYears.map(y => {
    const rs = byYr[y] || [];
    const summed = round2(rs.reduce((s, r) => s + num(r.pay_period_net), 0));
    const printed = round2(rs.reduce((m, r) => (r.ytd_total != null && r.ytd_total > m ? r.ytd_total : m), 0));
    const components = {
      advances: round2(rs.reduce((s, r) => s + num(r.advances_total), 0)),
      residual: round2(rs.reduce((s, r) => s + num(r.residual_total), 0)),
      chargebacks: round2(rs.reduce((s, r) => s + num(r.chargebacks_total), 0)),
      bonus: round2(rs.reduce((s, r) => s + num(r.bonus_total), 0)),
    };
    const withYtd = rs.filter(r => r.ytd_total != null);
    const latest = withYtd.length ? withYtd[withYtd.length - 1] : null;  // rs is date-sorted
    const drops = ytdDrops.filter(d => String(d.date).slice(0, 4) === String(y));
    return { year: y, summed_net: summed, printed_ytd: printed, diff: round2(summed - printed),
      pct: printed ? round2((summed - printed) / printed) : null,
      components, drops,
      printed_latest: latest ? round2(latest.ytd_total) : null, printed_latest_date: latest ? latest.date : null };
  });
  // residual "dip" watch: a policy whose latest residual is well under its own median.
  // Exclude families whose payout structure naturally steps down and would false-positive:
  //  - Medicare Advantage (large initial -> small monthly renewal), and
  //  - Life / Final Expense (first year is ~9 months advanced, then months 10-12 paid
  //    "as earned", so those trailing payments are legitimately smaller).
  const DIP_SKIP = new Set(['Medicare Advantage', 'Life / Final Expense']);
  const payByPol = {};
  for (const r of nonPending) for (const it of (r.items || [])) {
    if (it.section === 'commission' && it.policy && it.payable > 0 && !DIP_SKIP.has(productFamily(it.product)))
      (payByPol[it.policy] ||= { client: it.client, carrier: it.carrier, product: it.product, pays: [] })
        .pays.push({ date: r.date, amt: it.payable });
  }
  const underpaid = [];
  for (const [policy, d] of Object.entries(payByPol)) {
    if (d.pays.length < 4) continue;
    const amts = d.pays.map(p => p.amt).sort((a, b) => a - b);
    const med = amts[Math.floor(amts.length / 2)];
    const last = d.pays[d.pays.length - 1];
    if (med > 5 && last.amt < med * 0.5)
      underpaid.push({ policy, client: d.client, carrier: d.carrier, product: d.product,
        median: round2(med), latest: round2(last.amt), latest_date: last.date, shortfall: round2(med - last.amt) });
  }
  underpaid.sort((a, b) => b.shortfall - a.shortfall);
  const audit = {
    ytd_drops: ytdDrops, cadence_gaps: cadenceGaps, reconciliation, underpaid: underpaid.slice(0, 100),
    counts: { ytd_drops: ytdDrops.length, cadence_gaps: cadenceGaps.length, underpaid: underpaid.length },
  };

  // ================= book value & forward residual cash-flow =================
  // In-force valuation: annualized residual times an industry multiple range. Forward
  // cash-flow: the current residual run-rate held flat, plus the step-up when THIS year's
  // new Medicare Advantage members begin paying residual next January.
  const monthlyResidual = round2(residualAnnual / 12);
  const famMA = byFamily.find(f => f.key === 'Medicare Advantage');
  const matureMAMonthly = (famMA && famMA.active > 0) ? famMA.residual / famMA.active / 12 : 0;
  const newMAThisYear = pols.filter(p => p.family === 'Medicare Advantage' && p.status === 'Yes'
    && p.firstAdvance && p.firstAdvance.slice(0, 4) === String(curYear)).length;
  const maStepUp = round2(newMAThisYear * matureMAMonthly);
  const [ly, lm] = (latestDate || (curYear + '-01-01')).split('-').map(Number);
  const cashflow = [];
  for (let i = 1; i <= 12; i++) {
    const mIdx = (lm - 1) + i, y = ly + Math.floor(mIdx / 12), mo = ((mIdx % 12) + 12) % 12;
    const stepup = y > ly ? maStepUp : 0;               // new MA members begin paying next January
    cashflow.push({ label: MONTHS[mo] + " '" + String(y).slice(2), year: y, month: mo + 1,
      base: monthlyResidual, stepup: round2(stepup), amount: round2(monthlyResidual + stepup) });
  }
  const value = {
    residual_annual: residualAnnual,
    inforce_policies: active,
    monthly_residual: monthlyResidual,
    new_ma_this_year: newMAThisYear,
    ma_step_up_monthly: maStepUp,
    book_value: { mult_low: 2, mult_mid: 2.5, mult_high: 3,
      low: round2(residualAnnual * 2), mid: round2(residualAnnual * 2.5), high: round2(residualAnnual * 3) },
    cashflow,
    cashflow_total: round2(cashflow.reduce((s, m) => s + m.amount, 0)),
  };
  // AEP re-enrollment forecast: next year's Medicare Advantage renewal income. Every active
  // MA member (including this year's new enrollments, who begin paying in January) renews at
  // roughly their per-member annual residual, discounted by the retention rate.
  const activeMA = famMA ? famMA.active : 0;
  const perMemberAnnual = round2(matureMAMonthly * 12);
  const maRetention = (famMA && famMA.persistency != null) ? famMA.persistency : 0.85;
  value.ma_renewal = {
    active_members: activeMA,
    new_this_year: newMAThisYear,
    per_member_annual: perMemberAnnual,
    retention: maRetention,
    next_year_income: round2(activeMA * perMemberAnnual * maRetention),
    next_year_income_full: round2(activeMA * perMemberAnnual),  // if every member renews
  };

  // ================= convention (ASB incentive-trip) qualification =================
  // Points on new, ISSUED annualized premium over the qualification window, per the
  // official rules. Product credit: MedSupp 125% of annualized premium (AARP/UHC flat
  // 1,500); Medicare Advantage flat 2,000/policy; annuities 15% of premium; life and
  // LTC/other supplemental health 250% of annualized premium. Part D and <65 medical
  // don't count. Also tracked: >=25 issued apps and >=50% of credit from non-MA lines.
  const CONV_START = '2026-02-01', CONV_END = '2027-01-31';
  const CONV_ELIGIBLE = new Set(['Medicare Advantage', 'Med Supp', 'Annuity',
    'Life / Final Expense', 'Hospital / Supplemental', 'Dental / Vision']);
  // The window is by ISSUE date, but statements only carry payment dates, and commission is
  // paid a few weeks AFTER issue. So we shift the payment-date filter forward by a lag: a
  // policy issued Feb 1 pays ~a month later, one issued Jan 31 next year pays ~a month after
  // that. Shifting both boundaries drops early-Feb payments (prior-window issues) and captures
  // in-window issues paid just after Jan 31. Lag is configurable (profile.convention_pay_lag_days).
  const CONV_LAG = (config.profile && Number(config.profile.convention_pay_lag_days) >= 0)
    ? Number(config.profile.convention_pay_lag_days) : 30;
  const shiftDate = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const PAY_START = shiftDate(CONV_START, CONV_LAG), PAY_END = shiftDate(CONV_END, CONV_LAG);
  const convFirst = {};
  for (const r of records) for (const it of (r.items || [])) {
    if (it.section === 'advances' && it.policy) {
      const cur = convFirst[it.policy];
      if (!cur || r.date < cur.date) convFirst[it.policy] = { date: r.date, premium: it.premium, product: it.product, carrier: it.carrier, client: it.client, agents: it.agents };
    }
  }
  const convPointsFor = (fam, premium, carrier, product) => {
    const pm = num(premium);
    const tag = `${carrier || ''} ${product || ''}`;
    if (fam === 'Medicare Advantage') return { pts: 2000, ma: true, basis: '2,000 / policy' };
    if (fam === 'Med Supp') {
      if (/UNITEDHEALTH|\bUHC\b|AARP/i.test(tag)) return { pts: 1500, ma: false, basis: 'AARP/UHC flat 1,500' };
      return { pts: round2(pm * 12 * 1.25), ma: false, basis: '125% of annualized premium' };
    }
    if (fam === 'Annuity') return { pts: round2(pm * 0.15), ma: false, basis: '15% of premium' };
    if (fam === 'Life / Final Expense') return { pts: round2(pm * 12 * 2.5), ma: false, basis: '250% of annualized premium' };
    if (fam === 'Hospital / Supplemental') return { pts: round2(pm * 12 * 2.5), ma: false, basis: '250% of annualized premium' };
    if (fam === 'Dental / Vision') return { pts: round2(pm * 12 * 2.5), ma: false, basis: '250% (supplemental health)' };
    return { pts: 0, ma: false, basis: 'does not count' };
  };
  // Level -> qualifying production (in convention points). Each level qualifies on downline
  // OR personal production (per the corrected reading). Levels 7+ list only a downline
  // number; levels above 9 aren't published (shown as >= level 9).
  const CONV_LEVELS = [
    { level: 1, personal: 275000, downline: null },
    { level: 2, personal: 310000, downline: 1670000 },
    { level: 2.5, personal: 310000, downline: 1700000 },
    { level: 3, personal: 360000, downline: 1700000 },
    { level: 3.5, personal: 360000, downline: 1750000 },
    { level: 4, personal: 410000, downline: 1800000 },
    { level: 4.5, personal: 410000, downline: 1900000 },
    { level: 5, personal: 525000, downline: 2100000 },
    { level: 5.5, personal: 525000, downline: 2500000 },
    { level: 6, personal: 650000, downline: 2800000 },
    { level: 6.5, personal: 650000, downline: 3000000 },
    { level: 7, personal: null, downline: 3300000 },
    { level: 7.5, personal: null, downline: 3300000 },
    { level: 8, personal: null, downline: 3300000 },
    { level: 8.5, personal: null, downline: 3300000 },
    { level: 9, personal: null, downline: 5800000 },
    { level: 9.5, personal: null, downline: 5800000 },
    { level: 10, personal: null, downline: 5800000 },
  ];
  // Only the statement holder's SHARE counts, not the whole policy premium. Your share is
  // the percentage paid to you = 100 minus the other writing agents' listed cuts. Names/LLCs
  // that are you (config.profile.self_names) count toward you, not against. Downline share is
  // the downline agents' listed cuts; combined = your share + downline share.
  const selfSet = new Set((((config.profile || {}).self_names) || []).map(normName).filter(Boolean));
  const convExclude = new Set((((config.profile || {}).convention_exclude) || []).map(String)); // you force-excluded
  const convInclude = new Set((((config.profile || {}).convention_include) || []).map(String)); // you force-counted (override auto)
  // Auto-detect replacements: a new policy in the SAME product family for the SAME client, when
  // that client already had an earlier policy of that family, is a replacement (e.g. MA plan A
  // 2025 -> MA plan B 2026). Build a client+family index of every policy's earliest date.
  const normClient = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const polHist = {};
  for (const r of records) for (const it of (r.items || [])) {
    if (!it.policy) continue;
    const h = (polHist[it.policy] ||= { client: normClient(it.client), family: productFamily(it.product), first: r.date });
    if (r.date < h.first) h.first = r.date;
    if (!h.client && it.client) h.client = normClient(it.client);
  }
  const cfIndex = {};
  for (const [pol, h] of Object.entries(polHist)) { if (!h.client) continue; (cfIndex[h.client + '|' + h.family] ||= []).push({ policy: pol, first: h.first }); }
  const effExcludedSet = new Set();
  const convPols = [], convFamMap = {};
  const convPSeries = {}, convCSeries = {};       // personal series, combined (personal + downline) series
  let convPts = 0, convMA = 0, convApps = 0, convFyc = 0, convDPts = 0, convPApps = 0;
  for (const [policy, d] of Object.entries(convFirst)) {
    if (d.date < PAY_START || d.date > PAY_END) continue;   // payment date shifted to match the issue window
    const fam = productFamily(d.product);
    if (!CONV_ELIGIBLE.has(fam)) continue;              // Part D, unclassified -> not eligible
    const cp = convPointsFor(fam, d.premium, d.carrier, d.product);
    const ags = d.agents || [];
    const otherListed = ags.reduce((s, a) => s + (selfSet.has(normName(a.name)) ? 0 : (a.level || 0)), 0);
    // A policy a DOWNLINE agent wrote is override income (their production, not yours) — it
    // counts toward downline/combined, NOT personal. Peer splits (co-agents who aren't your
    // downline) still count your share as personal.
    const hasDownline = ags.some(a => isDL[normName(a.name)] && !selfSet.has(normName(a.name)));
    const selfShare = hasDownline ? 0 : Math.max(0, Math.min(100, 100 - otherListed)) / 100;   // your cut, if you wrote it
    const dlShare = ags.reduce((s, a) => s + ((isDL[normName(a.name)] && !selfSet.has(normName(a.name))) ? (a.level || 0) : 0), 0) / 100;
    const pPts = cp.pts * selfShare, dPts = cp.pts * dlShare;
    // auto-detect replacement: earlier policy, same client + family
    const autoReplacement = (cfIndex[normClient(d.client) + '|' + fam] || [])
      .some(x => x.policy !== policy && x.first < d.date);
    // effective exclusion: force-excluded, or auto-replacement unless you force-counted it
    const excluded = convExclude.has(String(policy)) || (autoReplacement && !convInclude.has(String(policy)));
    if (excluded) effExcludedSet.add(String(policy));
    if (!excluded) {
      convApps++; if (selfShare > 0) convPApps++;
      convPts += pPts; if (cp.ma) convMA += pPts; convDPts += dPts;
      if (pPts > 0) (convPSeries[d.date] ||= { date: d.date, points: 0 }).points += pPts;
      const combined = pPts + dPts;
      if (combined > 0) (convCSeries[d.date] ||= { date: d.date, points: 0 }).points += combined;
      const fm = (convFamMap[fam] ||= { family: fam, policies: 0, points: 0, ma: cp.ma });
      fm.policies++; fm.points += pPts;
    }
    const annualized = fam === 'Annuity' ? round2(num(d.premium)) : round2(num(d.premium) * 12);
    convPols.push({ date: d.date, policy, client: d.client, carrier: d.carrier, product: d.product, family: fam,
      premium: round2(num(d.premium)), annualized, basis: cp.basis, self_share: Math.round(selfShare * 100),
      points: round2(pPts), ma: cp.ma, excluded, auto_replacement: autoReplacement });
  }
  convPols.sort((a, b) => b.points - a.points);
  // first-year commission (dollars) actually paid to YOU on eligible business in the window —
  // excludes overrides on policies your downline wrote (that's not your first-year commission).
  for (const r of records) {
    if (r.date < PAY_START || r.date > PAY_END) continue;
    for (const it of (r.items || [])) {
      if (it.section !== 'advances' || !it.policy || !CONV_ELIGIBLE.has(productFamily(it.product))) continue;
      if (effExcludedSet.has(String(it.policy))) continue;
      const hasDownline = (it.agents || []).some(a => isDL[normName(a.name)] && !selfSet.has(normName(a.name)));
      if (!hasDownline) convFyc += it.payable;
    }
  }
  const convNonMA = round2(convPts - convMA);
  const convLevel = (config.profile && config.profile.convention_level != null) ? Number(config.profile.convention_level) : null;
  // candidate self-identities: only LLCs/entities that have been paid SOLO at 100% (the sole
  // writing agent at level 100) on at least one line. That's the only case an LLC could be
  // your own payee identity (an individual paid through their LLC) or a downline's LLC. An
  // LLC that only ever appears at a partial split is someone you override, not you.
  const CAND_LLC = /\b(LLC|INC|BROKERAGE|FINANCIAL|RETIREMENT|INSURANCE|AGENCY|GROUP|SOLUTIONS|SERVICES|ADVISORS|LTD|CORP|ENTERPRISES)\b/i;
  const CAND_HOUSE = /AMERICAN SENIOR BENEFITS|\bASB\b|INTEREST|BONUS|OVERRIDE|ADJUSTMENT|EARNINGS|COMPENSATION/i;
  const soloStats = {};
  let policyLineTotal = 0;
  for (const r of records) for (const it of (r.items || [])) {
    if (it.section !== 'advances' || !it.policy) continue;
    policyLineTotal++;
    const ags = it.agents || []; if (ags.length !== 1) continue;   // solo = single writing agent
    const a = ags[0], nm = (a.name || '').trim();
    if (!nm || CAND_HOUSE.test(nm) || !CAND_LLC.test(nm)) continue;
    const st = (soloStats[nm] ||= { name: nm, solo100: 0 });
    if ((a.level || 0) >= 100) st.solo100++;
  }
  // An LLC paid 100% solo is either a downline's LLC or your own. If it were YOURS, essentially
  // all your business would run through it -> high coverage marks it "likely you"; occasional
  // 100%-solo marks it "likely a downline's LLC".
  const convCandidates = Object.values(soloStats).filter(s => s.solo100 > 0)
    .map(s => { const cov = policyLineTotal ? s.solo100 / policyLineTotal : 0;
      return { name: s.name, count: s.solo100, coverage: round2(cov),
        note: cov >= 0.4 ? 'likely your own LLC — most business runs through it' : 'likely a downline\'s LLC' }; })
    .sort((a, b) => b.count - a.count).slice(0, 20);
  const winDays = Math.round((Date.parse(CONV_END + 'T00:00:00Z') - Date.parse(CONV_START + 'T00:00:00Z')) / 86400000) + 1;
  const convAsOf = (latestDate > CONV_START ? latestDate : CONV_START);
  const convElapsed = Math.min(Math.max(Math.round((Date.parse(convAsOf + 'T00:00:00Z') - Date.parse(CONV_START + 'T00:00:00Z')) / 86400000) + 1, 0), winDays);
  const convention = {
    window: { start: CONV_START, end: CONV_END },
    pay_lag_days: CONV_LAG, pay_window: { start: PAY_START, end: PAY_END },
    as_of: latestDate,
    points: round2(convPts), points_ma: round2(convMA), points_nonma: convNonMA,
    apps: convPApps, apps_needed: 25,
    nonma_share: convPts ? round2(convNonMA / convPts) : null,
    nonma_rule_met: convNonMA >= convPts * 0.5,
    by_family: Object.values(convFamMap).map(f => ({ ...f, points: round2(f.points) })).sort((a, b) => b.points - a.points),
    policies: convPols.slice(0, 500),
    persistency: (retention && retention.totals) ? retention.totals.persistency : null,
    elapsed_frac: round2(convElapsed / winDays), days_left: Math.max(0, winDays - convElapsed),
    level: convLevel, levels: CONV_LEVELS,
    fyc: round2(convFyc),
    alt: { new_contract_personal: 260000, fyc_levels_1_7: 150000 },
    self_names: (((config.profile || {}).self_names) || []),
    candidates: convCandidates,
    force_exclude: [...convExclude], force_include: [...convInclude],
    auto_replacements: convPols.filter(p => p.auto_replacement).length,
    personal_points: round2(convPts), personal_apps: convPApps,
    personal_series: Object.values(convPSeries).sort((a, b) => (a.date < b.date ? -1 : 1)),
    downline_points: round2(convDPts),
    combined_points: round2(convPts + convDPts),
    combined_series: Object.values(convCSeries).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };

  return {
    generated: new Date().toISOString().slice(0, 19),
    all_years: allYears,
    retention, products, value, clients, audit, convention,
    statement_count: records.length,
    years, series,
    residual_by_carrier: residualByCarrier,
    new_by_carrier: newByCarrier,
    carrier_series: carrierSeries,
    policies, monthly,
    cumulative_by_year: cumulativeByYear,
    runrate,
    reclass,
    bonuses,
    downline,
    projections,
    insights,
    goals: {
      config: (config.goals && typeof config.goals === 'object') ? config.goals : {},
      current_year: allYears[allYears.length - 1] || new Date().getFullYear(),
    },
    expenses: {
      config: (config.expenses && typeof config.expenses === 'object') ? config.expenses : {},
      current_year: allYears[allYears.length - 1] || new Date().getFullYear(),
    },
    tax: { config: (config.profile && config.profile.tax) || {} },
    pending: {
      count: pendingRecs.length,
      latest_date: latestPending ? latestPending.date : null,
      latest_total: latestPending ? latestPending.pending_total : 0,
    },
  };
}
// Clone + reclassify records the same way buildSummary does (MA initials -> new
// business, bonuses -> their own bucket), for consumers like the client-folder export
// that need "new business" to include Medicare Advantage initials.
function prepareRecords(allRecords, config) {
  config = config || {};
  const cloned = allRecords.map(r => ({ ...r, items: (r.items || []).map(it => ({ ...it })) }));
  const records = cloned.filter(r => !r.pending);
  reclassifyMA(records, config.ma_reclass);
  classifyBonuses(records);
  return records;
}

module.exports = { buildSummary, prepareRecords };
