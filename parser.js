'use strict';
// ---- statement parser (pure JS; operates on line-structured text) ----

// Carrier's weekly payout minimum: a positive net below this is not paid out and
// carries to the next week, but a statement is still issued for the period.
const PAYOUT_MINIMUM = 100;

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

// The statement holder is the name/LLC the statement is addressed to — the line right
// after the "Commission Statement" title (e.g. "Kaden L Greenwell" or "Greenwell Financial Llc").
// Agents who run an LLC receive two statements per pay period, one to each name.
function grabHolder(text){
  const m = text.match(/Commission Statement\s*\n\s*([^\n]+?)\s*\n/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function parseHeader(text){
  const dm = text.match(/Pay Period \((\d{2}\/\d{2}\/\d{4})\):\s*\$(-?[\d,]+\.\d{2})/);
  return {
    holder: grabHolder(text),
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
  // Pending statements print the pay-period date on its own line before the
  // "Pay Period:" total. Read it so the statement is placed by its real date
  // rather than the filename (which can be mistyped), closing false "missing week" gaps.
  const head = text.split(/Pay Period:/)[0];
  const dm = head.match(DATE_RE);
  const items = []; let total = 0;
  for (const line of text.split('\n')){
    const amt = rowAmounts(line);
    if (!amt) continue;
    total += amt.payable;
    items.push(makeItem('pending', line, null, amt.premium, amt.payable));
  }
  return {
    pending: true,
    header: { holder: grabHolder(text), pay_period_date: dm ? dm[0] : null, pay_period_net: nm ? money(nm[1]) : 0,
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

function finalizeRecord(data, fname){
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
  // Whether money was actually disbursed this period. The carrier still issues a
  // statement (and we still want it on the timeline) when nothing is paid — either
  // the net is negative after chargebacks, or the net is a positive amount below
  // the carrier's weekly payout minimum and carries forward. These arrive as
  // "Pending Commission Statement" PDFs; a plain negative net counts too.
  const netv = f(h.pay_period_net);
  let paid = true, no_pay_reason = null;
  if (data.pending){
    paid = false;
    no_pay_reason = netv < 0 ? 'chargebacks' : (netv < PAYOUT_MINIMUM ? 'below_minimum' : 'pending');
  } else if (netv < 0){
    paid = false; no_pay_reason = 'chargebacks';
  }
  return {
    file: fname.replace(/^.*[\\/]/, ''),
    holder: h.holder || null,
    date: d ? iso(d) : null,
    year: d ? d.getUTCFullYear() : null,
    pending: data.pending,
    paid, no_pay_reason,
    pay_period_net: netv,
    advances_total: f(st.advances),
    residual_total: f(st.commission),
    chargebacks_total: f(st.chargebacks),
    pending_total: f(st.pending),
    ytd_advances: h.ytd_advances, ytd_commission: h.ytd_commission,
    ytd_chargebacks: h.ytd_chargebacks, ytd_total: h.ytd_total,
    items: data.items,
  };
}

function parseStatement(text, fname){
  return finalizeRecord(parseText(text), fname);
}

// =================================================================
// 2026 statement format (column-aware). The newer ASB layout wraps the
// Product and Writing-Agent columns onto extra text lines and splits long
// client names, so a single logical row is scattered across several y-lines.
// We reassemble each row from the glyph runs by bucketing them into columns
// by x-position, which recovers client / product / agent cleanly. Detected via
// the "Payable Comm  Writing Agent" column header or the split "Advances &"
// section title, neither of which appears in the prior single-line format.
// =================================================================
function isNewFormat(text){
  return /Payable Comm\s+Writing Agent/.test(text) || /(^|\n)\s*Advances &\s*(\n|$)/.test(text);
}

// Fallback column x-ranges (points) if the header can't be read: policy ~22,
// client ~97, product ~172, numeric band (dates/mode/premium/comm%/payable)
// 247-674, writing agent ~674+.
const NF_COLS_DEFAULT = [['policy',0,60],['client',60,168],['product',168,246],['core',246,674],['agent',674,1e9]];
const nfColFor = cols => x => { for (const [k,a,b] of cols) if (x>=a && x<b) return k; return 'core'; };
const nfNorm = s => s.replace(/\s+/g,'').toUpperCase();

// Derive column x-boundaries from the statement's OWN header row, so the parser
// adapts if ASB shifts a column or adds one in a future format rather than
// relying on fixed pixel ranges. The header labels (Policy / Client / Product /
// Eff Date..Payable / Writing Agent) anchor each column; boundaries are the
// midpoints between adjacent anchors (the agent boundary uses the last numeric
// label and the agent label, since agent data aligns under "Writing", left of
// the "Agent" word). Falls back to NF_COLS_DEFAULT when no usable header found.
function nfDetectColumns(pages){
  for (const runs of pages){
    const byY={}; for (const r of runs){ const k=Math.round(r.y); (byY[k]||(byY[k]=[])).push(r); }
    for (const y of Object.keys(byY)){
      const parts = byY[y].sort((a,b)=>a.x-b.x);
      const up = parts.map(p=>p.t.toUpperCase());
      const joined = up.join(' ');
      if (!(joined.includes('POLICY') && joined.includes('CLIENT') && joined.includes('PRODUCT'))) continue;
      let policyX,clientX,productX,coreStartX,coreEndX,agentX;
      for (let i=0;i<parts.length;i++){
        const u=up[i], x=parts[i].x;
        if (policyX==null && u.includes('POLICY')) policyX=x;
        else if (clientX==null && u.includes('CLIENT')) clientX=x;
        else if (productX==null && u.includes('PRODUCT')) productX=x;
        else if (/EFF|PREM|DUE|MODE|PREMIUM|COMM|PAYABLE/.test(u)){ if(coreStartX==null)coreStartX=x; coreEndX=x; }
        else if (/WRITING|AGENT/.test(u)){ if(agentX==null)agentX=x; }
      }
      if ([policyX,clientX,productX,coreStartX,coreEndX,agentX].some(v=>v==null)) continue;
      if (!(policyX<clientX && clientX<productX && productX<coreStartX && coreEndX<agentX)) continue;
      const mid=(a,b)=>(a+b)/2;
      return [
        ['policy', 0, mid(policyX,clientX)],
        ['client', mid(policyX,clientX), mid(clientX,productX)],
        ['product', mid(clientX,productX), mid(productX,coreStartX)],
        ['core', mid(productX,coreStartX), mid(coreEndX,agentX)],
        ['agent', mid(coreEndX,agentX), 1e9],
      ];
    }
  }
  return NF_COLS_DEFAULT;
}

// Gap-aware join of a column's runs into text (handles wrapped sub-lines and
// the font's irregular intra-word advances).
function nfCellText(runs){
  runs = runs.slice().sort((a,b)=> b.y-a.y || a.x-b.x);
  let s='', px=null, py=null;
  for (const p of runs){
    if (px!=null){
      if (Math.abs(p.y-py) > 3){ if (!s.endsWith(' ')) s += ' '; }
      else if (p.x-px > (p.size||10)*0.7 && !s.endsWith(' ') && !p.t.startsWith(' ')) s += ' ';
    }
    s += p.t; px = p.x + p.t.length*(p.size||10)*0.4; py = p.y;
  }
  return s.replace(/\s+/g,' ').trim();
}
function nfPhysLines(runs){
  const m={}; for (const r of runs){ const k=Math.round(r.y); (m[k]||(m[k]=[])).push(r); }
  return Object.keys(m).map(Number).sort((a,b)=>b-a).map(y=>({ y, text: nfCellText(m[y]) }));
}
function nfSection(text){
  const n = nfNorm(text);
  if (n.startsWith('YTD')) return null;
  if (n.includes('ADVANCES&') || n.includes('INITIALANNUITY')) return 'advances';
  if (n.startsWith('COMMISSION') && n.includes('YEARTODATE')) return 'commission';
  if (n.includes('CHARGEBACK') || (n.includes('EXPENSE') && n.includes('ADJUSTMENT'))) return 'chargebacks';
  return null;
}
const NF_ANCHOR = /\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}\s+[A-Z]\b/;

function makeItemNew(section, cells){
  const policy = nfCellText(cells.policy);
  const client = nfCellText(cells.client);
  const product = nfCellText(cells.product);
  const core = nfCellText(cells.core);
  const agentTxt = nfCellText(cells.agent);
  const cur = [...core.matchAll(CURRENCY_G)].map(m => m[1]);
  const premium = money(cur[0]);
  const payable = money(cur[cur.length-1]);
  const pm = core.match(MIDPCT_RE);
  const comm_pct = pm ? parseFloat(pm[1]) : null;
  const carrier = detectCarrier(policy + ' ' + client + ' ' + product);
  return { section, policy, client, product, carrier, premium, comm_pct, payable, agents: extractAgents(agentTxt) };
}

function parseTextStructured(pages, text){
  if (text.includes('Pending Commission Statement')){
    // Pending statements carry a handful of rows; reuse the line-based pending
    // parser on the flattened text (the extra columns don't affect its totals).
    return parsePending(text);
  }
  const header = parseHeader(text);
  const items = [];
  const totals = { advances: 0, commission: 0, chargebacks: 0 };
  const nfCol = nfColFor(nfDetectColumns(pages));
  let section = null;
  for (const runs of pages){
    const pls = nfPhysLines(runs);
    const anchorYs = pls.filter(L => NF_ANCHOR.test(L.text)).map(L => L.y);
    if (!anchorYs.length){
      // still track section changes on a page with no rows (rare)
      for (const L of pls){ const s = nfSection(L.text); if (s) section = s; }
      continue;
    }
    // bucket every run on the page to the nearest anchor row (within 13pt)
    const bucket = {};
    for (const r of runs){
      let best=null, bd=13;
      for (const ay of anchorYs){ const d=Math.abs(r.y-ay); if (d<bd){ bd=d; best=ay; } }
      if (best!=null) (bucket[best]||(bucket[best]=[])).push(r);
    }
    for (const L of pls){
      const s = nfSection(L.text); if (s) section = s;
      if (anchorYs.includes(L.y) && section){
        const cells = { policy:[], client:[], product:[], core:[], agent:[] };
        for (const r of (bucket[L.y]||[])) cells[nfCol(r.x)].push(r);
        const it = makeItemNew(section, cells);
        if (!isFinite(it.premium) && !isFinite(it.payable)) continue;
        totals[section] += (it.payable || 0);
        items.push(it);
      }
    }
  }
  const st = { advances: round2(totals.advances), commission: round2(totals.commission),
               chargebacks: round2(totals.chargebacks), pending: 0 };
  return { pending: false, header, items, sectionTotals: st };
}

function parseStatementNew(pages, text, fname){
  return finalizeRecord(parseTextStructured(pages, text), fname);
}

module.exports = { parseText, parseStatement, parseStatementNew, isNewFormat,
                   dateFromFilename, detectCarrier, round2 };
