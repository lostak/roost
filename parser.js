'use strict';
// ---- statement parser (pure JS; operates on line-structured text) ----

const DATE_RE = /\d{2}\/\d{2}\/\d{4}/;
const CURRENCY_G = /\$(-?[\d,]+\.\d{2})/g;
const CURRENCY_1 = /\$(-?[\d,]+\.\d{2})/;
const MIDPCT_RE = /\$-?[\d,]+\.\d{2}\s+(\d+\.\d+)\s+\$-?[\d,]+\.\d{2}/;
const POLICY_RE = /^([A-Z0-9-]{5,})\s+(.*)$/;
// Writing-agent tokens look like "MICHAEL SCHWAB (50)" or "NICHOLAS CRINGHOFER(50)".
const AGENT_RE = /([A-Za-z][A-Za-z .,&'’\/\-]+?)\s*\((\d{1,3})\)/g;

const money = t => parseFloat(t.replace(/,/g, ''));
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Pull writing-agent name/level pairs out of a chunk of text (the tail of a line
// after the payable, or a continuation line that lists additional agents).
function extractAgents(text){
  const out = [];
  if (!text) return out;
  AGENT_RE.lastIndex = 0;
  let m;
  while ((m = AGENT_RE.exec(text))){
    const name = m[1].replace(/\s+/g, ' ').trim();
    if (name.length >= 2 && !/^\d/.test(name)) out.push({ name, level: Number(m[2]) });
  }
  return out;
}
// A line is "just" a writing-agent continuation if it has an agent token and no date/currency.
function isAgentContinuation(line){
  return !DATE_RE.test(line) && !CURRENCY_1.test(line) && extractAgents(line).length > 0;
}

// Substring keyword -> carrier display name. Matched in order against the
// uppercased line text; the FIRST hit wins, so put more-specific keywords
// (e.g. 'OMAHA MEDSUPP') ahead of broader ones. New entries are appended at the
// end so they only catch statement lines that would otherwise fall to 'Other'.
const CARRIERS = [
  ['UNITEDOFOMAHA','United of Omaha'],['HUMANA','Humana'],['DEVOTED','Devoted'],
  ['KAISER','Kaiser'],['UHC','UnitedHealthcare'],['AIG','AIG'],['GTL','GTL'],['GTA','GTL'],
  ['CLI','Aetna'], // CLI-prefixed policies (Recovery Care, Cancer/Heart/Stroke, etc.) are Aetna
  ['UNL','United National Life'],['FGL','F&G Life'],
  ['MONUMENTAL','Monumental'],['FEX','Monumental'],['MUTUAL','Mutual of Omaha'],
  ['BANKERS','Bankers'],['AETNA','Aetna'],['WELLCARE','WellCare'],['ANTHEM','Anthem'],
  ['CIGNA','Cigna'],['GERBER','Gerber'],['CLEARSPRING','ClearSpring'],['ATHENE','Athene'],
  // ---- added carriers (previously fell into "Other") ----
  ['OMAHA MEDSUPP','Mutual of Omaha'], // Med Supp lines with no MUTUAL/UNITEDOFOMAHA token
  ['AMER-AMIC','Americo'],['AMERICO','Americo'],
  ['MEDICO','Medico'],
  ['RNA ','Royal Neighbors'], // trailing space avoids matching FRATERNAL/INTERNAL etc.
  ['ACCENDO','Accendo (Aetna)'],
  ['BFLIC','Bankers Fidelity'],
  ['GWIC','Great Western'],
  ['NWL','National Western'],
  ['SCAN','SCAN Health'],
  ['NGIS','NGIS'], // ticker retained; carrier identity uncertain
  ['CIC ','CIC'],  // ticker retained; carrier identity uncertain
  ['SELECT HEALTH','SelectHealth'],
  // ---- non-carrier lines grouped out of the "Other" bucket ----
  ['OFFICE EXPENSE','Fees'],           // office-expense fee lines
  ['MISC','Bonus / Adjustment'],       // production bonuses & earnings adjustments (no policy)
];
function detectCarrier(text){
  const up = text.toUpperCase();
  for (const [kw,name] of CARRIERS) if (up.includes(kw)) return name;
  return 'Other';
}

function rowAmounts(line){
  if (!DATE_RE.test(line)) return null;
  const cur = [...line.matchAll(CURRENCY_G)].map(m => m[1]);
  if (!cur.length) return null;
  const premium = money(cur[0]);
  const payable = money(cur[cur.length - 1]);
  const pm = line.match(MIDPCT_RE);
  const commPct = pm ? parseFloat(pm[1]) : null;
  return { premium, commPct, payable };
}

function clientAndProduct(rest){
  const dm = rest.match(DATE_RE);
  const head = dm ? rest.slice(0, dm.index).trim() : rest.trim();
  const m = head.match(/(.+?,\s+\S+(?:\s+[A-Z])?)\s+(.*)/);
  if (m) return [m[1].trim(), m[2].trim()];
  return ['', head];
}

function makeItem(section, line, commPct, premium, payable){
  const before = line.slice(0, line.search(CURRENCY_1)).trim();
  const pm = before.match(POLICY_RE);
  const policy = pm ? pm[1] : '';
  const rest = pm ? pm[2] : before;
  const [client, product] = clientAndProduct(rest);
  const curs = [...line.matchAll(CURRENCY_G)];
  const lastCur = curs[curs.length - 1];
  const after = lastCur ? line.slice(lastCur.index + lastCur[0].length) : '';
  return { section, policy, client, product, carrier: detectCarrier(before),
           premium, comm_pct: commPct, payable, agents: extractAgents(after) };
}

function grab(text, re){ const m = text.match(re); return m ? money(m[1]) : null; }

function parseHeader(text){
  const dm = text.match(/Pay Period \((\d{2}\/\d{2}\/\d{4})\):\s*\$(-?[\d,]+\.\d{2})/);
  return {
    pay_period_date: dm ? dm[1] : null,
    pay_period_net: dm ? money(dm[2]) : null,
    ytd_advances: grab(text, /YTD Advances & Initial Annuity Payouts:\s*\$(-?[\d,]+\.\d{2})/),
    ytd_commission: grab(text, /YTD Commission Earnings:\s*\$(-?[\d,]+\.\d{2})/),
    ytd_chargebacks: grab(text, /YTD Chargebacks & Expense Adjustments:\s*\$(-?[\d,]+\.\d{2})/),
    ytd_total: grab(text, /YTD Total:\s*\$\s*(-?[\d,]+\.\d{2})/),
  };
}

function sectionFor(line, current){
  if (line.includes('Advances & Initial')) return 'advances';
  if (line.startsWith('Commission Earnings Year To Date')) return 'commission';
  if (line.includes('Chargebacks & Expense')) return 'chargebacks';
  return current;
}

function parsePending(text){
  const nm = text.match(/Pay Period:\s*\$\s*(-?[\d,]+\.\d{2})/);
  const ym = text.match(/Year To Date:\s*\$\s*(-?[\d,]+\.\d{2})/);
  const items = []; let total = 0;
  for (const line of text.split('\n')){
    const amt = rowAmounts(line);
    if (!amt) continue;
    total += amt.payable;
    items.push(makeItem('pending', line, null, amt.premium, amt.payable));
  }
  return {
    pending: true,
    header: { pay_period_date: null, pay_period_net: nm ? money(nm[1]) : 0,
      ytd_advances: null, ytd_commission: null, ytd_chargebacks: null,
      ytd_total: ym ? money(ym[1]) : null },
    items,
    sectionTotals: { advances: 0, commission: 0, chargebacks: 0, pending: round2(total) },
  };
}

function parseText(text){
  if (text.includes('Pending Commission Statement')) return parsePending(text);
  const header = parseHeader(text);
  const items = [];
  const totals = { advances: 0, commission: 0, chargebacks: 0 };
  let section = null;
  let lastItem = null;
  for (const line of text.split('\n')){
    const next = sectionFor(line, section);
    if (next !== section){ section = next; lastItem = null; }
    if (!section) continue;
    const amt = rowAmounts(line);
    if (amt){
      const it = makeItem(section, line, amt.commPct, amt.premium, amt.payable);
      totals[section] += amt.payable;
      items.push(it);
      lastItem = it;
    } else if (lastItem && isAgentContinuation(line)){
      // additional writing agents for the previous line item (they wrap to new lines)
      for (const a of extractAgents(line)) lastItem.agents.push(a);
    }
  }
  const st = { advances: round2(totals.advances), commission: round2(totals.commission),
               chargebacks: round2(totals.chargebacks), pending: 0 };
  return { pending: false, header, items, sectionTotals: st };
}

function dateFromFilename(fname){
  const base = fname.replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '');
  const m = base.match(/(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (!m) return null;
  let [_, mo, day, yr] = m; mo = +mo; day = +day; yr = +yr;
  if (yr < 100) yr += 2000;
  const d = new Date(Date.UTC(yr, mo - 1, day));
  if (d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== day) return null;
  return d;
}
const iso = d => d.toISOString().slice(0, 10);

function parseStatement(text, fname){
  const data = parseText(text);
  const h = data.header;
  // Prefer the date printed ON the statement (the pay-period date). The file can be named
  // anything; only fall back to a date encoded in the filename if the statement itself has
  // no readable date (e.g. some pending statements).
  let d = null;
  if (h.pay_period_date){
    const [mo, day, yr] = h.pay_period_date.split('/').map(Number);
    d = new Date(Date.UTC(yr, mo - 1, day));
  }
  if (!d) d = dateFromFilename(fname);
  const f = x => (x == null ? 0 : round2(x));
  const st = data.sectionTotals;
  return {
    file: fname.replace(/^.*[\\/]/, ''),
    date: d ? iso(d) : null,
    year: d ? d.getUTCFullYear() : null,
    pending: data.pending,
    pay_period_net: f(h.pay_period_net),
    advances_total: f(st.advances),
    residual_total: f(st.commission),
    chargebacks_total: f(st.chargebacks),
    pending_total: f(st.pending),
    ytd_advances: h.ytd_advances, ytd_commission: h.ytd_commission,
    ytd_chargebacks: h.ytd_chargebacks, ytd_total: h.ytd_total,
    items: data.items,
  };
}

module.exports = { parseText, parseStatement, dateFromFilename, detectCarrier, round2 };
