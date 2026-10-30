'use strict';
// Static checks over index.html so broken click targets / scroll regressions get caught here
// instead of by the user. Zero dependencies. Run: node test/ui-wiring.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let n = 0;

// 1. Every literal gotoView('x') points at a real nav view (data-view="x").
const views = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]));
assert.ok(views.size > 5, 'nav exposes a set of views'); n++;
const gotos = [...html.matchAll(/gotoView\((['"])([a-z0-9-]+)\1\)/gi)].map(m => m[2]);
assert.ok(gotos.length > 0, 'gotoView() is actually used');
for (const v of new Set(gotos)) assert.ok(views.has(v), `gotoView('${v}') targets an existing view`);
n++;

// 2. Every literal scrollToSection('id') points at an element that exists.
const secs = [...html.matchAll(/scrollToSection\((['"])([a-zA-Z0-9_-]+)\1\)/g)].map(m => m[2]);
for (const id of new Set(secs)) assert.ok(html.includes('id="' + id + '"'), `scrollToSection('${id}') target exists`);
n++;

// 3. scrollToSection is header-aware (regression guard: the old scrollIntoView cut targets off
//    under the sticky app bar).
assert.ok(/function headerOffset\(/.test(html), 'headerOffset() helper is present'); n++;
assert.ok(html.includes('getBoundingClientRect().top+window.scrollY-headerOffset()'),
  'scrollToSection subtracts the sticky-header height'); n++;
assert.ok(!html.includes("scrollIntoView({behavior:'smooth',block:'start'})"),
  'the old header-blind scrollIntoView is gone'); n++;

// 4. Switching views lands at the top of the new view.
assert.ok(/window\.scrollTo\(0,0\)/.test(html), 'nav view-switch scrolls to top'); n++;

// 5. The home/welcome page is reactive: hero, trip card, and KPIs navigate somewhere.
assert.ok(html.includes('id="view-welcome"'), 'the narrated welcome/home view exists'); n++;
assert.ok(/class="wel-num"[^>]*onclick="gotoView\('value'\)"/.test(html),
  'home hero (book value) navigates to Book Value'); n++;
assert.ok(/id="welTrip"[^>]*onclick="gotoView\('convention'\)"/.test(html),
  'home convention trip card navigates to the Convention tab'); n++;
assert.ok(/kpi-go[^]*?gotoView/.test(html), 'home summary KPIs are navigable (kpi-go + gotoView)'); n++;

// The home + thin-history views adapt to how much history the account has.
assert.ok(/DATA\.maturity/.test(html) && /function applyMaturityNotes\(/.test(html),
  'home and views branch on DATA.maturity'); n++;
assert.ok(html.includes('id="projMaturityNote"') && html.includes('id="retMaturityNote"'),
  'projections + retention have maturity-caveat elements'); n++;
assert.ok(html.includes('id="welHlabel"') && html.includes('id="welMoneyLab"'),
  'home hero label + section label are dynamic (new vs established framing)'); n++;

// Developer mode has no header button — it's reachable only via the command palette.
assert.ok(!/id="devLock"/.test(html), 'no developer lock button in the header'); n++;
assert.ok(/Developer mode[\s\S]*?run:devLockClick/.test(html), 'developer mode is a command-palette action'); n++;

console.log(`ui-wiring: ${n} checks passed`);
