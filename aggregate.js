'use strict';
// ---- aggregation: parsed statement records -> dashboard JSON payload ----
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const num = x => (x == null ? 0 : Number(x));

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
  let moved = 0, dollars = 0;
  for (const r of records) {
    let changed = false;
    for (const it of (r.items || [])) {
      if (it.section !== 'commission' || !(it.payable > 0)) continue;
      // Only reclassify genuine policy commissions -- skip bonus/trip/adjustment/MISC
      // lines (1099-MISC trips, earnings adjustments, agency bonuses). These are not
      // MA initials; they just happen to be large and sit in the commission section.
      if (!it.policy || it.product === 'MISC' ||
          /BONUS|ADJUST|1099|TRIP|EXPENSE|EARNINGS/i.test(`${it.policy} ${it.client} ${it.product}`)) continue;
      const base = (it.policy && polBase[it.policy] != null) ? polBase[it.policy] : gMed;
      if (it.payable >= base * MULT && it.payable >= FLOOR) {
        it.section = 'advances'; it.ma_initial = true;
        moved++; dollars += it.payable; changed = true;
      }
    }
    if (changed) {
      let adv = 0, res = 0;
      for (const it of (r.items || [])) {
        if (it.section === 'advances') adv += it.payable;
        else if (it.section === 'commission') res += it.payable;
      }
      r.advances_total = round2(adv);
      r.residual_total = round2(res);
    }
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

  // ---- per-statement time series ----
  const series = records.map(r => ({
    date: r.date, year: r.year,
    net: num(r.pay_period_net), advances: num(r.advances_total),
    residual: num(r.residual_total), chargebacks: num(r.chargebacks_total),
    bonus: num(r.bonus_total),
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
  for (const r of records) {
    for (const it of (r.items || [])) {
      const sk = secKey(it.section); if (!sk || !isRealPolicy(it) || !it.agents || !it.agents.length) continue;
      const onLine = it.agents.filter(a => isDL[normName(a.name)]);
      if (!onLine.length) continue;                        // no downline agent on this line
      const lvlSum = it.agents.reduce((s, a) => s + (a.level || 0), 0);
      if (lvlSum < 100) {                                  // you hold the remainder -> lumped, exclude
        excluded[sk] += it.payable; excluded.count += 1; continue;
      }
      const seen = new Set();
      for (const a of onLine) {
        const key = normName(a.name); if (seen.has(key)) continue; seen.add(key);
        const m = (agentMap[key] ||= { name: prettyName(a.name), total: 0, advances: 0, residual: 0,
          chargebacks: 0, count: 0, years: {}, carriers: {} });
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
    const m = agentMap[k] || { name: allAgents[k], total: 0, advances: 0, residual: 0,
      chargebacks: 0, count: 0, years: {}, carriers: {} };
    const t = agentSeen[k] || { first: null, last: null, since100: null };
    const row = { name: m.name || allAgents[k], since: t.first, since_100: t.since100, last_seen: t.last,
      manual: !autoDL[k],   // in the downline but never auto-flagged = manually added
      count: m.count, total: round2(m.total), advances: round2(m.advances),
      residual: round2(m.residual), chargebacks: round2(m.chargebacks),
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

  return {
    generated: new Date().toISOString().slice(0, 19),
    all_years: allYears,
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
