/**
 * The presence audit, and specifically the state it used to get wrong.
 *
 * A 403 is not a healthy profile. Treating it as one silenced an entire
 * workstream for four cycles in the system this came from: ten of twenty-one
 * watched properties were refusing bots, every one was filed as benign, and the
 * cycle reported zero third-party actions while the metric they feed was
 * falling. These tests exist so that cannot come back.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fp = require('../src/core/footprint');
const { load } = require('../src/config');

const cfg = load('./config/example.config.js');
const row = (over) => ({
  url: 'https://directory.example/orbital',
  name: 'Software directory',
  source_class: 'THIRD PARTY - EMPTY',
  http_status: 200,
  what_it_says: 'live',
  ...over,
});

test('a blocked profile still raises an action', () => {
  // The regression that matters. "We could not look" must never be filed as
  // "we looked and it was fine".
  const acts = fp.buildActions([row({ state: fp.STATE.BLOCKED, http_status: 403 })], cfg);
  assert.equal(acts.length, 1);
  assert.match(acts[0].action, /by hand/i);
  assert.equal(acts[0].owner, 'Marketing');
});

test('a blocked profile does not claim to know the profile is empty', () => {
  // Saying "fill this profile" on the strength of a 403 would be inventing a
  // finding we have no evidence for.
  const [a] = fp.buildActions([row({ state: fp.STATE.BLOCKED, http_status: 403 })], cfg);
  assert.doesNotMatch(a.action, /^Fill|^Create/);
  assert.match(a.why, /no evidence either way/i);
});

test('410 Gone is treated as missing, not as a block', () => {
  const acts = fp.buildActions([row({
    state: fp.STATE.EMPTY, http_status: 410,
    what_it_says: 'GONE — deliberately removed (HTTP 410)',
  })], cfg);
  assert.equal(acts.length, 1);
  assert.match(acts[0].action, /^Create/);
});

test('an empty live profile raises "fill", not "create"', () => {
  const acts = fp.buildActions([row({
    state: fp.STATE.EMPTY, what_it_says: '0 reviews',
  })], cfg);
  assert.match(acts[0].action, /^Fill/);
});

test('a healthy profile raises nothing', () => {
  assert.equal(fp.buildActions([row({ state: fp.STATE.OK })], cfg).length, 0);
  assert.equal(fp.buildActions([row({ state: fp.STATE.MANUAL })], cfg).length, 0);
});

test('our own host refusing bots asks about AI crawlers, not about a broken page', () => {
  // A filter that cannot tell your auditor from a scraper may also be refusing
  // the crawlers that feed answer engines — a different question entirely.
  const [a] = fp.buildActions([row({
    state: fp.STATE.BLOCKED, http_status: 403, source_class: 'OURS', name: 'Website',
  })], cfg);
  assert.equal(a.owner, 'Web');
  assert.match(a.why, /crawlers/i);
  assert.doesNotMatch(a.action, /profile/i);
});

test('our own page 404ing is urgent and belongs to web', () => {
  const [a] = fp.buildActions([row({
    state: fp.STATE.EMPTY, http_status: 404, source_class: 'OURS', name: 'Pricing page',
    what_it_says: 'NO PROFILE — not found',
  })], cfg);
  assert.equal(a.priority, 'URGENT');
  assert.equal(a.owner, 'Web');
});

test('the empty-profile heuristic is not fooled by ordinary pages', () => {
  assert.ok(fp.looksEmpty('<p>0 reviews</p>'));
  assert.ok(fp.looksEmpty('Not reviewed yet'));
  assert.ok(!fp.looksEmpty('<p>1,204 reviews · 4.6 stars</p>'));
});

// ─────────────────────────────────────────────────────────────────────────────
// HUMAN_VERIFIED — the mirror-image bug.
//
// BLOCKED stopped a refusal reading as a clean bill of health, and in doing so
// made human work unrecordable: eleven rows asked for the same manual check
// every cycle because the host kept answering 403. Doing the job had no way to
// make the ask stop, which is how people learn to ignore a checklist.
// ─────────────────────────────────────────────────────────────────────────────

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('a fresh human check counts; a stale one does not', () => {
  const v = (on) => ({ verified: { on, says: 'Profile live, name correct' } });
  assert.ok(fp.freshVerification(v(daysAgo(5))));
  assert.ok(!fp.freshVerification(v(daysAgo(fp.VERIFY_TTL_DAYS + 1))));
});

test('verification fails closed on anything it cannot date', () => {
  // The one way this feature could do harm is by silencing a row on the
  // strength of a note nobody can date, so every uncertain case must resolve
  // towards "needs checking".
  assert.ok(!fp.freshVerification({}));
  assert.ok(!fp.freshVerification({ verified: { says: 'live' } }));
  assert.ok(!fp.freshVerification({ verified: { on: daysAgo(3) } }));
  assert.ok(!fp.freshVerification({ verified: { on: 'last tuesday', says: 'live' } }));
  assert.ok(!fp.freshVerification({ verified: { on: daysAgo(-30), says: 'live' } }));
});

test('a verified profile raises the real work, not another request to look', () => {
  const [a] = fp.buildActions([row({
    state: fp.STATE.HUMAN_VERIFIED, http_status: 403,
    what_it_says: 'Profile live, name correct, we hold edit access. 0 reviews.',
    verified_on: daysAgo(3), verified_by: 'Sam',
    verified_action: 'Get the first reviews published',
  })], cfg);
  assert.match(a.action, /Get the first reviews published/);
  assert.doesNotMatch(a.action, /by hand/i);
  assert.match(a.why, /Checked by hand by Sam/);
});

test('verified and correct with nothing to do goes quiet', () => {
  // Some profiles genuinely reach this: a registry mirroring a government
  // filing is correct, unchangeable by us, and finished.
  assert.equal(fp.buildActions([row({
    state: fp.STATE.HUMAN_VERIFIED, http_status: 403,
    what_it_says: 'Record live, name correct. Not editable by us.',
    verified_on: daysAgo(3), verified_action: null,
  })], cfg).length, 0);
});

test('a verified-but-empty profile is urgent, not merely noted', () => {
  // Live, claimed and showing nothing is a worse signal than absent: it reads
  // as unproven rather than unknown.
  const [a] = fp.buildActions([row({
    state: fp.STATE.HUMAN_VERIFIED, http_status: 403,
    what_it_says: 'Profile live, we hold edit access. 0 reviews.',
    verified_on: daysAgo(3), verified_action: 'Get reviews posted',
  })], cfg);
  assert.equal(a.priority, 'URGENT');
});

test('nobody having checked never looks the same as checked and fine', () => {
  // An unverified blocked row keeps asking. That is the honest state.
  const [a] = fp.buildActions([row({ state: fp.STATE.BLOCKED, http_status: 403 })], cfg);
  assert.match(a.action, /by hand/i);
});
