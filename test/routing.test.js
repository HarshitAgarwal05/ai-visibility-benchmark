/**
 * The action ladder, asserted.
 *
 * These are the tests that would have caught the original defect: a single line
 * that sent every absence to the content team, producing 33 writing tasks of
 * which zero were real. It survived because nothing could check it — the logic
 * was buried inside a function that needed a database and a paid API run.
 *
 * Routing is a pure function precisely so this file can exist.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { load, PRODUCT_STATUS, INTENT, COVERAGE } = require('../src/config');
const { routeAbsence, ACTION_TYPE, OWNER, PRIORITY } = require('../src/core/actions');

const cfg = load('./config/example.config.js');
const q = (over) => ({
  id: 'X1', group: 'B', text: 'a question',
  product_status: PRODUCT_STATUS.LIVE,
  intent_type: INTENT.CAPABILITY,
  canonical_pages: ['/page'],
  site_coverage: COVERAGE.STRONG,
  ...over,
});
const seen = { runs: 3, sourcesOurs: 0 };

test('an unshipped feature raises nothing at all', () => {
  // A task that contradicts your own site is worse than no task: whoever picks
  // it up stops trusting the rest of the list.
  assert.equal(routeAbsence(q({ product_status: PRODUCT_STATUS.COMING_SOON }), seen, cfg), null);
  assert.equal(routeAbsence(q({ product_status: PRODUCT_STATUS.NOT_TARGET }), seen, cfg), null);
});

test('"best X" goes to marketing, never to content', () => {
  // The 19-of-33 case. No page of your own can win a recommendation question.
  const r = routeAbsence(q({ intent_type: INTENT.RECOMMENDATION }), seen, cfg);
  assert.equal(r.type, ACTION_TYPE.THIRD_PARTY_AUTHORITY);
  assert.equal(r.owner, OWNER.MARKETING);
});

test('comparison questions route like recommendations', () => {
  const r = routeAbsence(q({ intent_type: INTENT.COMPARISON }), seen, cfg);
  assert.equal(r.owner, OWNER.MARKETING);
});

test('no page at all is the only real writing job', () => {
  const r = routeAbsence(q({ canonical_pages: [] }), seen, cfg);
  assert.equal(r.type, ACTION_TYPE.CONTENT_GAP);
  assert.equal(r.owner, OWNER.CONTENT);
});

test('NONE coverage counts as no page even when one is listed', () => {
  const r = routeAbsence(q({ site_coverage: COVERAGE.NONE }), seen, cfg);
  assert.equal(r.type, ACTION_TYPE.CONTENT_GAP);
});

test('page exists but was never cited -> retrieval, owned by web', () => {
  // The distinction the whole thing turns on. Nobody read the page, so
  // rewriting it cannot help.
  const r = routeAbsence(q(), { runs: 3, sourcesOurs: 0 }, cfg);
  assert.equal(r.type, ACTION_TYPE.RETRIEVAL);
  assert.equal(r.owner, OWNER.WEB);
  assert.match(r.evidence, /\/page/);
});

test('page cited but brand not named -> selection, and only LOW', () => {
  // Reachable but not quotable. The one case a copy tweak earns its keep —
  // and it is low priority, because it is one sentence.
  const r = routeAbsence(q(), { runs: 3, sourcesOurs: 4 }, cfg);
  assert.equal(r.type, ACTION_TYPE.SELECTION);
  assert.equal(r.owner, OWNER.CONTENT);
  assert.equal(r.priority, PRIORITY.LOW);
  assert.match(r.why, /do not write a new page/i);
});

test('core-group absences outrank the rest', () => {
  const core = routeAbsence(q({ group: 'B', canonical_pages: [] }), seen, cfg);
  const other = routeAbsence(q({ group: 'C', canonical_pages: [] }), seen, cfg);
  assert.equal(core.priority, PRIORITY.URGENT);
  assert.notEqual(other.priority, PRIORITY.URGENT);
});

test('the example config produces no phantom writing tasks', () => {
  // The regression that matters. Every absent question in the shipped example
  // must route somewhere defensible, and the only CONTENT_GAP allowed is a
  // question with genuinely no page behind it.
  const gaps = cfg.questions
    .map((qq) => ({ qq, r: routeAbsence(qq, { runs: 3, sourcesOurs: 0 }, cfg) }))
    .filter(({ r }) => r && r.type === ACTION_TYPE.CONTENT_GAP);

  for (const { qq } of gaps) {
    assert.ok(!qq.canonical_pages.length || qq.site_coverage === COVERAGE.NONE,
      `${qq.id} routed to CONTENT_GAP but has a page — that is a phantom task`);
  }
});
