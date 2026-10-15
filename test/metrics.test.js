/**
 * Metric definitions, asserted against hand-built rows.
 *
 * Each test encodes a decision that is easy to get wrong and expensive to get
 * wrong quietly — the kind that produces a plausible number nobody questions
 * for months.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const m = require('../src/core/metrics');
const { load } = require('../src/config');

const cfg = load('./config/example.config.js');
const opts = cfg.limits;

const row = (over) => ({
  question_id: 'B1', question_group: 'B', engine: 'openai', repeat_index: 1,
  status: 'ok', mentioned: false, branded: false,
  sources_total: 0, sources_ours: 0, sources_independent: 0,
  sources_corroborating: 0, sources_about_us: 0, sources_wrong_company: 0,
  sources_unclassified: 0,
  ...over,
});

const cell = (engine, qid, hits, runs = 3) =>
  Array.from({ length: runs }, (_, i) => row({
    engine, question_id: qid, repeat_index: i + 1, mentioned: i < hits,
  }));

test('inclusion is a macro-average across engines, not pooled', () => {
  // openai: 1 of 1 question. perplexity: 0 of 3. Pooling would give 25%;
  // equal weight per engine gives 50%. Pooling lets the chattier engine set
  // your headline, which is why it is wrong.
  const rows = [
    ...cell('openai', 'B1', 3),
    ...cell('perplexity', 'B1', 0),
    ...cell('perplexity', 'B2', 0),
    ...cell('perplexity', 'B3', 0),
  ];
  const r = m.inclusion(rows, opts, (x) => x.question_group === 'B');
  assert.equal(r.engines.openai.rate, 100);
  assert.equal(r.engines.perplexity.rate, 0);
  assert.equal(r.rate, 50);
});

test('a cell needs two good runs to count at all', () => {
  // One observation of a generative system is an anecdote.
  const rows = [row({ engine: 'openai', question_id: 'B1', mentioned: true })];
  const r = m.inclusion(rows, opts, () => true);
  assert.equal(r.engines.openai.usable_cells, 0);
  assert.equal(r.engines.openai.rate, null);
});

test('inclusion uses a majority within the cell, not any single hit', () => {
  const rows = cell('openai', 'B1', 1);        // 1 of 3
  const strict = m.inclusion(rows, opts, () => true);
  const loose = m.inclusionAny(rows, opts, () => true);
  assert.equal(strict.engines.openai.rate, 0);
  assert.equal(loose.rate, 100);
});

test('branded recall flags a whole-engine blackout even above the floor', () => {
  // A scattered miss is noise. A branded question at zero on a whole engine
  // means that engine stopped knowing you — a different and worse event.
  const rows = [
    ...cell('openai', 'A1', 3).map((r) => ({ ...r, branded: true })),
    ...cell('openai', 'A2', 3).map((r) => ({ ...r, branded: true })),
    ...cell('perplexity', 'A1', 0).map((r) => ({ ...r, branded: true })),
  ];
  const r = m.brandedRecall(rows, opts);
  assert.equal(r.blackouts.length, 1);
  assert.equal(r.blackouts[0].engine, 'perplexity');
  assert.ok(r.breached);
});

test('entity confusion excludes rivals from its denominator', () => {
  // Counting every citation would dilute a real problem until it looked small.
  const rows = [row({
    sources_total: 100, sources_wrong_company: 10,
    sources_ours: 10, sources_about_us: 0,
  })];
  const r = m.entityConfusion(rows);
  assert.equal(r.denominator, 20);       // not 100
  assert.equal(r.rate, 50);
});

test('corroboration counts answers, not citations', () => {
  const rows = [
    row({ mentioned: true, sources_corroborating: 5 }),
    row({ mentioned: true, sources_corroborating: 0 }),
    row({ mentioned: false, sources_corroborating: 9 }),   // not a mention: ignored
  ];
  const r = m.corroboration(rows, () => true);
  assert.equal(r.mentions, 2);
  assert.equal(r.corroborated, 1);
  assert.equal(r.rate, 50);
});

test('roundups are not corroboration', () => {
  // The most expensive measurement mistake this tool exists to prevent: a
  // listicle you want to be ON is a target, not a witness. Counting it made a
  // real programme report 52.9% when the truth was 0%.
  const { CORROBORATING_CLASSES, SOURCE_CLASS } = require('../src/config');
  assert.ok(!CORROBORATING_CLASSES.has(SOURCE_CLASS.ROUNDUP_TARGET));
  assert.ok(CORROBORATING_CLASSES.has(SOURCE_CLASS.THEIRS_COMPARISON));
});

test('independent share reports the unknown pool alongside the rate', () => {
  // Unclassified citations are excluded, which makes the rate an optimistic
  // bound. If the pool is not shown, nobody can tell.
  const rows = [row({ sources_total: 10, sources_independent: 2, sources_unclassified: 6 })];
  const r = m.independentShare(rows);
  assert.equal(r.rate, 20);
  assert.match(r.note, /6 of 10/);
});

test('a thin cycle is marked, not silently averaged', () => {
  const rows = [
    ...cell('openai', 'B1', 0),
    row({ engine: 'openai', question_id: 'B2' }),          // 1 run only
    row({ engine: 'openai', question_id: 'B3' }),
  ];
  const r = m.integrity(rows, opts, () => true);
  assert.notEqual(r.overall, m.VALIDITY.VALID);
});

test('a clean answer is not counted as a breach, however the judge spells it', () => {
  // This predicate sets a headline denominator, and every way it can be wrong
  // is silent. An empty array is truthy in JavaScript: a judge adapter
  // returning [] would report a 100% breach rate with no error anywhere.
  const clean = ['none', 'None', ' none ', '', 'n/a', null, undefined, []];
  for (const v of clean) {
    assert.equal(m.flaggedBreach(v), false, `expected clean: ${JSON.stringify(v)}`);
  }
});

test('a real breach is counted whether it arrives as text or a list', () => {
  assert.ok(m.flaggedBreach('claims an iOS app exists'));
  assert.ok(m.flaggedBreach(['claims an iOS app exists']));
});

test('severity is matched regardless of case and padding', () => {
  const rows = [
    { wrong_facts: 'claims a 4.8 rating', wrong_facts_severity: ' Serious ' },
    { wrong_facts: 'slightly old price', wrong_facts_severity: 'minor' },
    { wrong_facts: 'none', wrong_facts_severity: 'none' },
  ];
  const a = m.accuracy(rows);
  assert.equal(a.flagged, 2);
  assert.equal(a.serious, 1);
  assert.ok(a.breached);
});
