/**
 * Cost decomposition.
 *
 * Three separate wrong numbers were published before this file existed: a
 * search fee charged at another tool's rate, a judge bill left out of the
 * total entirely, and a corrected total that overwrote the figure people
 * remembered. Each one was invisible inside a single number, so the tests here
 * are mostly about the itemisation holding its shape.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cost = require('../src/core/cost');
const openai = require('../src/engines/openai');

const searching = {
  engine: 'openai', tokens_in: 8810, tokens_out: 400, search_calls: 1, cost_usd: 0.0472,
  cost_input_usd: 0.022, cost_output_usd: 0.006, cost_search_usd: 0.01, search_rate_usd: 0.01,
};
const plain = {
  engine: 'openai', tokens_in: 4449, tokens_out: 380, search_calls: 0, cost_usd: 0.0168,
  cost_input_usd: 0.0111, cost_output_usd: 0.0057, cost_search_usd: 0, search_rate_usd: 0.01,
};

test('the search rate is derived from the tool actually sent, not hardcoded', () => {
  // The original bug: the request body named one tool and the price list
  // charged for the other. These two facts must come from one place.
  assert.equal(openai.SEARCH_COST_PER_CALL, openai.WEB_SEARCH_RATES[openai.WEB_SEARCH_TOOL_TYPE]);
});

test('itemised parts add up to the single total', () => {
  // If these ever diverge, the decomposition is decoration.
  const pricing = { m: { in: 2.5, out: 15 } };
  const parts = openai.costParts('m', 1000, 500, 2, pricing);
  const total = openai.estimateCost('m', 1000, 500, 2, pricing);
  const summed = parts.input_usd + parts.output_usd + parts.search_usd;
  assert.ok(Math.abs(summed - total) < 1e-9, `${summed} vs ${total}`);
});

test('the judge is inside the total and still visible on its own', () => {
  // Omitting it understated real cycles fourfold; merging it hid both halves.
  const b = cost.decompose([searching], [{ cost_usd: 4.06, judge_model: 'j' }]);
  assert.ok(b.cost_judge > 4);
  assert.ok(b.cost_total_benchmark > b.cost_engine);
  assert.ok(Math.abs(b.cost_total_benchmark - (b.cost_engine + b.cost_judge)) < 1e-9);
  assert.ok(b.lines.some((l) => l.section === 'EVALUATION' && l.usd > 4));
});

test('a published total is preserved, never recomputed', () => {
  const b = cost.decompose([searching], [], { reportedAtTime: 8.7 });
  assert.equal(b.reported_at_time, 8.7);
  assert.notEqual(b.cost_total_benchmark, 8.7);
});

test('an unpriced engine is labelled unpriced, not free', () => {
  // $0 and "we do not know" look identical in a total and mean opposite
  // things. One of them means the spend cap is not protecting anything.
  const b = cost.decompose([{ engine: 'gemini', cost_usd: 0, tokens_in: 10, tokens_out: 10 }], []);
  const line = b.lines.find((l) => l.label === 'gemini');
  assert.match(line.note, /UNPRICED/);
});

test('search-content tokens are separated from the prompt, and marked derived', () => {
  const b = cost.decompose([searching, plain], []);
  const line = b.lines.find((l) => /search content/.test(l.label));
  assert.ok(line, 'expected a search-content line');
  assert.match(line.note, /DERIVED/);
});

test('no split is claimed when there is nothing to compare against', () => {
  // Every answer searched, so there is no baseline. Reporting a split here
  // would be inventing the most expensive line in the bill.
  const s = cost.splitInputTokens([searching, { ...searching }]);
  assert.equal(s.derived, false);
  assert.equal(s.search_tokens, 0);
});

test('the engine subtotal equals the sum of the engine rows', () => {
  const b = cost.decompose([searching, plain, { engine: 'perplexity', cost_usd: 0.004 }], []);
  assert.ok(Math.abs(b.cost_engine - (0.0472 + 0.0168 + 0.004)) < 1e-9);
});
