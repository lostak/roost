'use strict';
// Generates a per-client folder under Commissions/Clients/, each holding a spreadsheet
// with one row per policy. Runs when statements are (re)parsed. Reuses an existing
// client folder if one is already there (keyed by client name), so re-running just
// refreshes each client's sheet with their full current set of policies.
//
// Rules:
//  - A policy is only listed once it was NEW BUSINESS (had an advance / initial payment).
//    Residual-only lines feed an existing policy row but never create one on their own.
//  - Each row shows whether the residual is still coming through (a residual payment
//    within ~2 months of the latest statement).

const fs = require('fs');
const path = require('path');
const { buildXlsx } = require('./xlsxlite.js');

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const RESIDUAL_ACTIVE_DAYS = 62; // no residual in ~2 months => considered dropped off
const isMedAdvantage = product => /MED\s?ADV/i.test(product || ''); // Humana/UHC/etc. MedAdvantage
// House/accounting "clients" that aren't real people (interest on chargebacks, bonuses,
// overrides, adjustments) — skip these, same rule the downline logic uses.
const HOUSE_RE = /\b(INTEREST|BONUS|OVERRIDE|ADJUSTMENT|EARNINGS|COMPENSATION|1099|TRIP|AWARD|CONTEST|EAPP|VBE)\b/i;

// Make a client name / policy safe to use as a Windows + POSIX file/folder name.
function sanitize(s) {
  return (s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '').trim().slice(0, 120) || 'Unknown';
}
const daysBetween = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

// Roll every real client policy up: client -> policy -> aggregated figures.
function buildClientSummaries(records) {
  let latest = '0000-00-00';
  for (const r of records) if (!r.pending && r.date > latest) latest = r.date;

  const clients = {};
  const cbByPolicy = new Set(); // policy numbers with a chargeback, tracked globally by
                                // number so a differently-spelled client name still matches
  for (const r of records) {
    if (r.pending) continue;
    for (const it of (r.items || [])) {
      if (!it.policy || it.product === 'MISC') continue;
      if (HOUSE_RE.test(it.client || '')) continue;
      const client = (it.client || '').trim();
      if (!client) continue;
      const c = (clients[client] ||= {});
      const p = (c[it.policy] ||= { policy: it.policy, carrier: it.carrier, product: it.product,
        advances: 0, residual: 0, chargebacks: 0, agents: new Set(), payments: 0,
        hasAdvance: false, hasChargeback: false, firstAdvance: null, lastResidual: null, first: r.date, last: r.date });
      p.carrier = it.carrier || p.carrier;
      p.product = it.product || p.product;
      for (const a of (it.agents || [])) if (a && a.name) p.agents.add(a.name);
      if (it.section === 'advances') {
        p.advances += it.payable; p.hasAdvance = true;
        if (!p.firstAdvance || r.date < p.firstAdvance) p.firstAdvance = r.date;
      } else if (it.section === 'commission') {
        p.residual += it.payable;
        if (!p.lastResidual || r.date > p.lastResidual) p.lastResidual = r.date;
      } else if (it.section === 'chargebacks') {
        p.chargebacks += it.payable;
        if (it.payable < 0) cbByPolicy.add(it.policy);
      }
      p.payments++;
      if (r.date < p.first) p.first = r.date;
      if (r.date > p.last) p.last = r.date;
    }
  }

  // Keep only policies that were new business; work out the residual-active status.
  const latestYear = Number((latest || '').slice(0, 4)) || 0;
  for (const client of Object.keys(clients)) {
    for (const pol of Object.keys(clients[client])) {
      const p = clients[client][pol];
      if (!p.hasAdvance) { delete clients[client][pol]; continue; }
      const active = !!(p.lastResidual && daysBetween(latest, p.lastResidual) <= RESIDUAL_ACTIVE_DAYS);
      p.residual_active = active;
      p.hasChargeback = cbByPolicy.has(p.policy);   // match by policy number, any client spelling
      if (p.hasChargeback) {
        // A chargeback means the policy lapsed / was clawed back -> not active.
        p.residual_status = 'No';
      } else if (isMedAdvantage(p.product)) {
        // MA residuals only begin the January AFTER enrollment. A policy still in its
        // enrollment year hasn't started paying yet, so it's on track (Yes), not dropped.
        const writeYear = p.firstAdvance ? Number(p.firstAdvance.slice(0, 4)) : latestYear;
        p.residual_status = (latestYear <= writeYear) ? 'Yes' : (active ? 'Yes' : 'No');
      } else {
        p.residual_status = !p.lastResidual ? 'No Residual' : (active ? 'Yes' : 'No');
      }
    }
    if (!Object.keys(clients[client]).length) delete clients[client];
  }
  return clients;
}

function clientWorkbook(policies) {
  const rows = Object.values(policies).map(p => ({
    policy: p.policy, carrier: p.carrier, product: p.product,
    advances: round2(p.advances), residual: round2(p.residual), chargebacks: round2(p.chargebacks),
    net: round2(p.advances + p.residual + p.chargebacks),
    residual_active: p.residual_status,
    last_residual: p.lastResidual || '', first_written: p.firstAdvance || '',
    payments: p.payments, agents: [...p.agents].join(', '),
  })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return buildXlsx([{ name: 'Policies', columns: [
    { header: 'Policy', key: 'policy', width: 18 },
    { header: 'Carrier', key: 'carrier', width: 18 },
    { header: 'Product', key: 'product', width: 32 },
    { header: 'New Business', key: 'advances', width: 14, money: true },
    { header: 'Residual', key: 'residual', width: 12, money: true },
    { header: 'Chargebacks', key: 'chargebacks', width: 13, money: true },
    { header: 'Net', key: 'net', width: 12, money: true },
    { header: 'Residual Active', key: 'residual_active', width: 14 },
    { header: 'Last Residual', key: 'last_residual', width: 13 },
    { header: 'First Written', key: 'first_written', width: 13 },
    { header: 'Payments', key: 'payments', width: 10 },
    { header: 'Writing Agents', key: 'agents', width: 30 },
  ], rows }]);
}

// Write Clients/<client>/<client>.xlsx for every client. Returns counts.
function writeClientFolders(records, clientsDir) {
  const clients = buildClientSummaries(records);
  fs.mkdirSync(clientsDir, { recursive: true });
  let clientCount = 0, policyCount = 0;
  for (const [client, policies] of Object.entries(clients)) {
    const safe = sanitize(client);
    const cdir = path.join(clientsDir, safe);
    fs.mkdirSync(cdir, { recursive: true }); // reuse the folder if the client already has one
    fs.writeFileSync(path.join(cdir, safe + '.xlsx'), clientWorkbook(policies));
    clientCount++;
    policyCount += Object.keys(policies).length;
  }
  return { clients: clientCount, policies: policyCount };
}

module.exports = { buildClientSummaries, writeClientFolders };
