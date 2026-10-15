/**
 * End-to-end, with no network and no spend.
 *
 * A fake engine and a fake judge drive the real runner, the real classifier,
 * the real metrics and the real action router. This is the test that proves the
 * pieces fit — unit tests on each one can all pass while the pipeline produces
 * nothing.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { load } = require('../src/config');
const storage = require('../src/storage');
const runner = require('../src/core/runner');
const actionsLib = require('../src/core/actions');
const report = require('../src/core/report');
const metricsLib = require('../src/core/metrics');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivb-'));
  return storage.create({ storage: { driver: 'file', dir } });
}

/** Answers that name the brand for B1/B2 and stay silent elsewhere. */
function fakeAnswer(q) {
  const names = q.id === 'B1' || q.id === 'B2' || q.branded;
  return {
    text: names
      ? `For this you might look at Orbital, which handles it well. Competitor One also exists.`
      : `Several tools do this, including Competitor One and Competitor Two.`,
    citations: names
      ? ['https://orbital.example/pricing', 'https://trade-press.example/review-of-orbital']
      : ['https://competitor-one.example', 'https://roundup-blog.example/best-tools'],
    searchCalls: 1,
    tokensIn: 100, tokensOut: 200, costUsd: 0.01,
    model: 'fake-1', latencyMs: 5, status: 'ok', error: null,
  };
}

test('a whole cycle runs, scores and reports without a network', async () => {
  const cfg = load('./config/example.config.js');
  const store = tmpStore();
  await store.init();

  // Swap the adapter registry for a fake. The runner does not know.
  const engines = require('../src/engines');
  const realGet = engines.get;
  engines.get = () => ({ run: async (text) => {
    const q = cfg.questions.find((x) => x.text === text) || {};
    return fakeAnswer(q);
  } });

  try {
    const res = await runner.run(cfg, store, {
      runId: 'test_cycle', runDate: '2026-01-15', engines: ['openai'], repeats: 3,
    });
    assert.ok(res.made > 0, 'calls were made');

    const runs = await store.read('runs', { runId: 'test_cycle' });
    assert.ok(runs.length > 0);

    // Classification reached the rows rather than being computed and dropped.
    const named = runs.find((r) => r.question_id === 'B1');
    assert.equal(named.mentioned, true, 'brand detected in the answer');
    assert.ok(named.sources_ours > 0, 'our own domain classified as OURS');
    assert.ok(named.sources_corroborating > 0, 'press counted as corroboration');

    const silent = runs.find((r) => r.question_id === 'B4');
    assert.equal(silent.mentioned, false);
    assert.equal(silent.sources_ours, 0);
    // A roundup is cited here, and it must NOT count as corroboration.
    assert.equal(silent.sources_corroborating, 0,
      'a roundup target must never corroborate');

    // Sequential stopping fired: with 3 repeats and agreeing first two, the
    // third call is skipped and no information is lost.
    assert.ok(res.saved > 0, 'sequential stopping saved calls');

    // Metrics and actions on real rows.
    const m = metricsLib.computeAll(runs, cfg);
    assert.ok(m.core_inclusion.rate > 0, 'some inclusion measured');
    assert.equal(m.branded_recall.rate, 100, 'branded control holds');

    const acts = actionsLib.build(runs, m, cfg);
    assert.ok(acts.length > 0, 'absences produced actions');

    // The headline assertion: an unshipped feature must raise nothing, and no
    // absence with a live page may be filed as a writing job.
    assert.ok(!acts.some((a) => a.action_id === 'ABSENT-B5'),
      'COMING_SOON question raised an action');
    const gaps = acts.filter((a) => a.action_type === actionsLib.ACTION_TYPE.CONTENT_GAP);
    for (const g of gaps) {
      const q = cfg.questions.find((x) => `ABSENT-${x.id}` === g.action_id);
      assert.ok(!q.canonical_pages.length || q.site_coverage === 'NONE',
        `${q.id} filed as a content gap but has a page`);
    }

    // Report writes rows and states its method.
    const rep = await report.build(cfg, store, { runId: 'test_cycle', runDate: '2026-01-15' });
    assert.ok(rep.metrics > 0);
    const headline = rep.rows.find((r) => r.metric === 'core_inclusion');
    assert.match(headline.value_text, /equal weight per engine/);
  } finally {
    engines.get = realGet;
  }
});

test('a resumed run does not re-buy answers it already has', async () => {
  const cfg = load('./config/example.config.js');
  const store = tmpStore();
  await store.init();

  const engines = require('../src/engines');
  const realGet = engines.get;
  let calls = 0;
  engines.get = () => ({ run: async (text) => {
    calls++;
    const q = cfg.questions.find((x) => x.text === text) || {};
    return fakeAnswer(q);
  } });

  try {
    await runner.run(cfg, store, { runId: 'resume', runDate: '2026-01-15', engines: ['openai'], repeats: 1 });
    const first = calls;
    assert.ok(first > 0);

    // Same cycle again — every row already landed, so nothing should be bought.
    const second = await runner.run(cfg, store, { runId: 'resume', runDate: '2026-01-15', engines: ['openai'], repeats: 1 });
    assert.equal(calls, first, 'a resumed run made new API calls');
    assert.ok(second.skipped > 0, 'resume did not recognise existing rows');
  } finally {
    engines.get = realGet;
  }
});

test('the spend cap stops a run and marks the cycle incomplete', async () => {
  const cfg = load('./config/example.config.js');
  const store = tmpStore();
  await store.init();

  const engines = require('../src/engines');
  const realGet = engines.get;
  engines.get = () => ({ run: async () => ({ ...fakeAnswer({}), costUsd: 1.0 }) });

  try {
    const res = await runner.run(cfg, store, {
      runId: 'capped', runDate: '2026-01-15', engines: ['openai'], repeats: 3, capUsd: 3,
    });
    assert.ok(res.capHit, 'cap did not fire');
    assert.ok(res.spend >= 3);
    // Incompleteness has to be recorded, not inferred — a partial cycle that
    // looks complete is worse than one that failed loudly.
    const log = await store.read('run_log', { runId: 'capped' });
    assert.equal(log[0].cap_hit, true);
  } finally {
    engines.get = realGet;
  }
});
