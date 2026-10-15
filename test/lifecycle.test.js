/**
 * Action lifecycle.
 *
 * The rule being defended: a condition that stops firing is not a condition
 * that was fixed. In the programme this came from, seven actions in one cycle
 * were marked Closed with no recorded fix behind any of them, and the
 * completion rate rose on nothing but run-to-run variance. These tests are the
 * reason that cannot happen silently again.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const actions = require('../src/core/actions');
const { STATUS, BACKLOG } = actions;

const fired = (over) => ({
  action_id: 'ABSENT-B3', action_type: 'RETRIEVAL', owner: 'Web', ...over,
});
const cfg = { questions: [{ id: 'B3', site_coverage: 'STRONG' }] };

test('an action that merely stops firing does not close', () => {
  const c1 = actions.reconcile([fired()], [], cfg);
  const c2 = actions.reconcile([], c1, cfg);
  assert.equal(c2[0].status, STATUS.OBSERVED_RECOVERY);
  assert.match(c2[0].why, /not closed/i);
});

test('it closes only after holding a second consecutive cycle', () => {
  const c1 = actions.reconcile([fired()], [], cfg);
  const c2 = actions.reconcile([], c1, cfg);
  const c3 = actions.reconcile([], c2, cfg);
  assert.equal(c3[0].status, STATUS.CLOSED);
  assert.match(c3[0].why, /two consecutive cycles/i);
});

test('firing again during observed recovery resets it to open', () => {
  // The honest outcome. Carrying the optimistic state forward would let one
  // lucky mention launder a still-broken thing into a closure.
  const c1 = actions.reconcile([fired()], [], cfg);
  const c2 = actions.reconcile([], c1, cfg);
  const c3 = actions.reconcile([fired()], c2, cfg);
  assert.equal(c3[0].status, STATUS.OPEN);
});

test('a recorded fix closes it on the first clean cycle', () => {
  // The one case where the intervention can be credited rather than the
  // number merely having moved.
  const c1 = actions.reconcile([fired()], [], cfg).map((a) => ({ ...a, fix_shipped: 'shipped a hub page' }));
  const c2 = actions.reconcile([], c1, cfg);
  assert.equal(c2[0].status, STATUS.CLOSED);
  assert.match(c2[0].why, /fix was recorded/i);
});

test('a closed action is not resurrected', () => {
  const closed = [{ action_id: 'ABSENT-B3', status: STATUS.CLOSED }];
  assert.equal(actions.reconcile([], closed, cfg).length, 0);
});

test('nothing infers a fix on the team\'s behalf', () => {
  // fix_shipped is set by a person or it is null. If nobody will claim the
  // fix, the benchmark must not claim it for them.
  const c1 = actions.reconcile([fired()], [], cfg);
  assert.equal(c1[0].fix_shipped, null);
});

test('retrieval debt on an already-strong page is AUTHORITY, not execution', () => {
  // The page is written and findable and still not fetched. Filing this as web
  // debt blames people for something they cannot close on the site.
  const [a] = actions.reconcile([fired()], [], cfg);
  assert.equal(a.backlog_type, BACKLOG.AUTHORITY);
});

test('the same action with thin coverage is ordinary execution debt', () => {
  const [a] = actions.reconcile([fired()], [], { questions: [{ id: 'B3', site_coverage: 'NONE' }] });
  assert.equal(a.backlog_type, BACKLOG.EXECUTION);
});

test('a shipped fix awaiting cycles is VALIDATION, not debt', () => {
  const prev = [{ action_id: 'ABSENT-B3', status: STATUS.OPEN, fix_shipped: 'shipped' }];
  const [a] = actions.reconcile([fired()], prev, cfg);
  assert.equal(a.backlog_type, BACKLOG.VALIDATION);
});

test('cycles_open counts up once per cycle and does not ping-pong', () => {
  // An earlier implementation took MAX(cycles_open) + 1 over all history and
  // produced 8 for an action that had existed for 2 cycles.
  let rows = actions.reconcile([fired()], [], cfg);
  for (let i = 0; i < 3; i++) rows = actions.reconcile([fired()], rows, cfg);
  assert.equal(rows[0].cycles_open, 4);
});
