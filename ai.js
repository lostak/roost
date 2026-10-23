'use strict';
// ---- AI insights: rule-based anomalies (always available) + optional LLM summary/chat ----
// Optional and local-by-default: with no API key the endpoint still returns rule-based anomalies
// and a clear "not configured" flag. Set a key via the ANTHROPIC_API_KEY env var, or by adding
// "ai_key" to config.json. Nothing is sent anywhere unless a key is set and you ask.

const https = require('https');

let _cfgKey = '';
function setKey(k) { _cfgKey = k ? String(k) : ''; }
function apiKey() { return process.env.ANTHROPIC_API_KEY || process.env.HISTAK_AI_KEY || _cfgKey || ''; }
const MODEL = process.env.ROOST_AI_MODEL || 'claude-3-5-haiku-latest';

const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const pct = x => x == null ? 'n/a' : Math.round(x * 100) + '%';

// Compact, model-friendly digest of the agent's book — the grounding context for summaries & chat.
function bookFacts(s) {
  if (!s) return 'No statements have been uploaded yet.';
  const years = (s.years || []).map(y => `  ${y.year}: net ${money(y.net)}, new business ${money(y.advances)}, residual ${money(y.residual)}, chargebacks ${money(y.chargebacks)} (${y.statements} statements)`).join('\n');
  const v = s.value || {}, bv = v.book_value || {}, r = (s.retention || {}).totals || {};
  const f = s.forecast || {}, cb = s.chargebacks || {}, pr = s.projections || {}, h = s.health || {};
  const lines = [
    `Statements on file: ${s.statement_count || 0}. Years: ${(s.all_years || []).join(', ') || 'none'}.`,
    `Book health score: ${h.score != null ? h.score + '/100 (grade ' + h.grade + ')' : 'n/a'}.`,
    `Annualized residual: ${money(v.residual_annual)}. In-force policies: ${v.inforce_policies || 0}. Estimated book value: ${money(bv.mid)} (range ${money(bv.low)}–${money(bv.high)}).`,
    `Overall persistency: ${pct(r.persistency)}. 13-month persistency: ${pct((f.persistency || {}).m13)}. Policies active/lapsed: ${r.active || 0}/${r.lapsed || 0}.`,
    `Chargebacks all-time: ${money(cb.total)} at a ${cb.rate_vs_advances != null ? cb.rate_vs_advances + '%' : 'n/a'} rate. Predicted upcoming: ${money((f.predicted_chargebacks || {}).next_window)}.`,
    `This year projected net: ${money((f.projection_band || {}).base)} (range ${money((f.projection_band || {}).low)}–${money((f.projection_band || {}).high)}). YTD net: ${money(pr.net_ytd)}.`,
    `At-risk Medicare Advantage (90-day window): ${r.at_risk_count || 0} policies, ${money(r.at_risk_dollars)}.`,
    `Per year:\n${years || '  (none)'}`,
  ];
  const gw = (s.growth && s.growth.suggestions) || [];
  if (gw.length) lines.push('Current growth opportunities: ' + gw.map(g => g.title).join('; ') + '.');
  return lines.join('\n');
}

// Rule-based anomalies — notable, plain-English changes worth the agent's attention. No AI needed.
function anomalies(s) {
  const out = [];
  if (!s || !s.statement_count) return out;
  const ser = (s.series || []).filter(x => x.date);
  if (ser.length >= 2) {
    const last = ser[ser.length - 1], prev = ser[ser.length - 2];
    if (prev.net > 0) {
      const chg = (last.net - prev.net) / Math.abs(prev.net);
      if (chg <= -0.4) out.push({ severity: 'high', text: `Your latest pay dropped ${Math.round(-chg * 100)}% from the period before (${money(last.net)} vs ${money(prev.net)}). Worth checking for a missing statement or a chargeback hit.` });
      else if (chg >= 0.6) out.push({ severity: 'info', text: `Your latest pay jumped ${Math.round(chg * 100)}% (${money(last.net)}). Nice period — often an advance-heavy week.` });
    }
  }
  const cb = s.chargebacks || {};
  if (cb.rate_vs_advances != null && cb.rate_vs_advances > 5) out.push({ severity: 'high', text: `Chargebacks are running at ${cb.rate_vs_advances}% of what's been advanced — above a comfortable range. Early-lapse outreach would help.` });
  const m13 = (s.forecast && s.forecast.persistency || {}).m13;
  if (m13 != null && m13 < 0.8) out.push({ severity: 'high', text: `13-month persistency is ${pct(m13)} — below the ~85% a healthy Medicare book holds. Retention is your highest-leverage fix.` });
  const gaps = (s.review && s.review.counts || {}).gaps || 0;
  if (gaps > 0) out.push({ severity: 'medium', text: `${gaps} gap${gaps === 1 ? '' : 's'} in your statement cadence suggest about ${(s.review.counts.missing_est || 0)} missing statement${s.review.counts.missing_est === 1 ? '' : 's'}. Add them so your totals are complete.` });
  const ar = (s.retention && s.retention.totals || {});
  if (ar.at_risk_count > 0) out.push({ severity: 'medium', text: `${ar.at_risk_count} Medicare Advantage polic${ar.at_risk_count === 1 ? 'y is' : 'ies are'} in the 90-day rapid-disenrollment window (${money(ar.at_risk_dollars)} of commission at risk). A quick check-in protects it.` });
  return out;
}

function callClaude(system, userText, key) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: userText }] });
    const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) },
      timeout: 30000 }, r => {
      const chunks = []; r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (j.error) return reject(new Error(j.error.message || 'AI error'));
          const text = (j.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
          resolve(text || '(no response)');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('AI request timed out')); });
    req.write(body); req.end();
  });
}

const SYSTEM_SUMMARY = `You are an analyst inside Roost, a commission dashboard for an independent insurance agent (Medicare, life, annuities). You are given a factual digest of the agent's own book. Write for that agent: warm, concrete, plain English, no hype, no jargon they wouldn't use. Never invent numbers — use only the figures given. Money that recurs (residual) is the asset; chargebacks and lapses erode it. Keep it tight.`;
const SYSTEM_ASK = SYSTEM_SUMMARY + ` Answer the agent's question using only the digest. If the digest doesn't contain the answer, say so briefly and suggest what to look at. 120 words max.`;

async function summary(s) {
  const key = apiKey();
  const anoms = anomalies(s);
  if (!key) return { configured: false, anomalies: anoms };
  const text = await callClaude(SYSTEM_SUMMARY,
    `Here is my book:\n\n${bookFacts(s)}\n\nGive me a 2-3 sentence plain-English summary of where my book stands, then 3 short bullet insights (what's going well, what to watch, the single best next move). Be specific with my numbers.`, key);
  return { configured: true, text, anomalies: anoms };
}
async function ask(s, question) {
  const key = apiKey();
  if (!key) return { configured: false };
  const text = await callClaude(SYSTEM_ASK, `My book:\n\n${bookFacts(s)}\n\nMy question: ${String(question || '').slice(0, 500)}`, key);
  return { configured: true, text };
}

module.exports = { summary, ask, anomalies, bookFacts, setKey, isConfigured: () => !!apiKey() };
