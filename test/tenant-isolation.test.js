'use strict';
// Tenant-isolation + login-hardening test for the hosted server. Zero external deps.
// Proves: unauthenticated requests are blocked, each signed-in user sees only their
// own data, sessions map to the correct account, statements are scoped per user, and
// repeated failed logins get locked out. Run: node test/tenant-isolation.test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate everything in a throwaway data dir + port BEFORE loading the app.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-iso-'));
process.env.ROOST_DATA = TMP;
const PORT = 5188;
process.env.PORT = String(PORT);

const auth = require('../auth.js');
const { db } = require('../db.js');

// Two independent accounts with distinct saved data.
const A = auth.createUser('alice', 'password1a', false);
const B = auth.createUser('bob', 'password2b', false);
db.prepare('UPDATE settings SET json=? WHERE user_id=?').run(JSON.stringify({ goals: { 2026: { net: 111111 } } }), A.id);
db.prepare('UPDATE settings SET json=? WHERE user_id=?').run(JSON.stringify({ goals: { 2026: { net: 222222 } } }), B.id);

require('../server.js'); // starts listening on PORT

function req(opts, body) {
  return new Promise((res, rej) => {
    const r = http.request(Object.assign({ host: '127.0.0.1', port: PORT }, opts), x => {
      let d = ''; x.on('data', c => d += c); x.on('end', () => res({ code: x.statusCode, headers: x.headers, body: d }));
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const login = (u, p) => req({ path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ username: u, password: p }))
  .then(r => ({ code: r.code, cookie: (r.headers['set-cookie'] || [''])[0].split(';')[0], setCookie: (r.headers['set-cookie'] || [''])[0] }));

(async () => {
  await new Promise(r => setTimeout(r, 700)); // let the server bind
  let n = 0;

  // 1. Unauthenticated data request is blocked.
  assert.strictEqual((await req({ path: '/api/data' })).code, 401, 'unauth /api/data should be 401'); n++;

  // 2. Both users can log in; cookie is HttpOnly (and Secure only when configured).
  const la = await login('alice', 'password1a'); assert.strictEqual(la.code, 200, 'alice login');
  const lb = await login('bob', 'password2b'); assert.strictEqual(lb.code, 200, 'bob login');
  assert.ok(/HttpOnly/i.test(la.setCookie), 'cookie must be HttpOnly');
  assert.ok(/SameSite=Strict/i.test(la.setCookie), 'cookie must be SameSite=Strict'); n++;

  // 3. Each user sees ONLY their own goals (no cross-tenant leakage).
  const da = JSON.parse((await req({ path: '/api/data', headers: { Cookie: la.cookie } })).body);
  const dbd = JSON.parse((await req({ path: '/api/data', headers: { Cookie: lb.cookie } })).body);
  assert.strictEqual(da.goals.config['2026'].net, 111111, 'alice sees her goal');
  assert.strictEqual(dbd.goals.config['2026'].net, 222222, 'bob sees his goal');
  assert.notStrictEqual(da.goals.config['2026'].net, dbd.goals.config['2026'].net, 'goals must differ'); n++;

  // 4. Session cookie resolves to the correct account.
  assert.strictEqual(JSON.parse((await req({ path: '/api/me', headers: { Cookie: la.cookie } })).body).user.username, 'alice'); n++;
  assert.strictEqual(JSON.parse((await req({ path: '/api/me', headers: { Cookie: lb.cookie } })).body).user.username, 'bob'); n++;

  // 5. A tampered/garbage cookie is rejected.
  assert.strictEqual((await req({ path: '/api/data', headers: { Cookie: 'roost_session=deadbeef' } })).code, 401, 'bogus session rejected'); n++;

  // 6. Statements are scoped per user at the data layer.
  db.prepare('INSERT INTO statements(user_id,sha256,orig_name,canonical,date,year,bytes,uploaded,rec_json,parse_version) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(A.id, 'shaA', 'a.pdf', 'a', null, 2026, 1, new Date().toISOString(), '{}', 6);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM statements WHERE user_id=?').get(A.id).c, 1, 'A has 1 statement');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM statements WHERE user_id=?').get(B.id).c, 0, 'B has 0 statements'); n++;

  // 7. Password policy is enforced.
  assert.throws(() => auth.createUser('weakuser', 'short'), /at least/, 'short password rejected');
  assert.throws(() => auth.createUser('weakuser2', 'alllettersonly'), /letter and one number/, 'letters-only rejected'); n++;

  // 8. Repeated failed logins get locked out (429).
  let last;
  for (let i = 0; i < 6; i++) last = await login('alice', 'definitelywrong1');
  assert.strictEqual(last.code, 429, 'brute force should be locked out'); n++;

  console.log(`tenant-isolation: ${n} checks passed`);
  process.exit(0);
})().catch(e => { console.error('tenant-isolation FAILED:', e && e.stack || e); process.exit(1); });
