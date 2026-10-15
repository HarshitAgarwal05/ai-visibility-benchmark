/**
 * OpenAI adapter — Responses API with the web_search tool offered.
 *
 * ── The model choice is load-bearing, and it is not a detail ────────────────
 *
 * The tool is OFFERED, never forced. Forcing it measures a product nobody uses;
 * a real person asks a question and the model decides whether to look. Letting
 * it decide is what makes the number mean anything.
 *
 * But that only holds if the model is current. An older model will decline to
 * search for category questions almost every time, and the benchmark then reads
 * its silence as "the engine has never heard of you".
 *
 * Measured on identical questions with an identical request body:
 *
 *     a two-year-old model   searched  0 / 8      named the brand  0 / 8
 *     a current model        searched  8 / 8      named the brand  4 / 8
 *
 * Three cycles of a real programme reported 0% for this engine. It was the
 * model, not the engine's verdict. Nobody uses a two-year-old build, and
 * measuring one tells you nothing about what a customer sees.
 *
 * So: set `model` in config, and revisit it. A benchmark pinned to a stale
 * model quietly measures a product that no longer exists.
 *
 * ⚠️ CHANGING THE MODEL BREAKS THE SERIES. Inclusion is a macro-average across
 * engines; lifting one engine off the floor moves the headline on its own. Run
 * the same questions on both models once, record the step, and say so — or a
 * model upgrade gets reported as a marketing win.
 */

'use strict';

const { postJson, failure } = require('./http');

const HOST = 'api.openai.com';
const PATH = '/v1/responses';

// ── THE SEARCH FEE DEPENDS ON THE TOOL, NOT THE MODEL ──────────────────────
//
// Providers ship more than one search tool, and they bill on OPPOSITE
// principles. At the time of writing OpenAI has two:
//
//   web_search           $10 / 1,000 calls   search-result tokens ARE billed,
//                                            at the model's input rate
//   web_search_preview   $25 / 1,000 calls   search-result tokens are FREE
//
// A hardcoded per-call rate sitting next to a request body that names a tool is
// two facts that must agree and nothing forcing them to. In the programme this
// came from they drifted: the file charged the PREVIEW per-call fee while the
// request sent the MODERN tool — so every search was paid for twice, the fee at
// the higher rate plus the result tokens only the modern tool bills. A cycle
// reported $8.70 against a true $6.48. Nothing was overspent; it was
// mis-recorded, which is worse, because the budget conversation that follows is
// about a number nobody can reproduce.
//
// So the rate is DERIVED from the tool constant, and the request body uses that
// same constant. They cannot drift apart again without editing one line.
const WEB_SEARCH_TOOL_TYPE = 'web_search';
const WEB_SEARCH_RATES = { web_search: 0.010, web_search_preview: 0.025 };
const SEARCH_COST_PER_CALL = Number(
  process.env.OPENAI_WEB_SEARCH_COST_PER_CALL || WEB_SEARCH_RATES[WEB_SEARCH_TOOL_TYPE],
);

// Stamped onto every row. "What did we believe the prices were when this cycle
// was recorded?" is a question you will be asked, and reconstructing it from
// git history months later is not an answer.
const PRICING_SOURCE_VERSION = '2026-01-01';

/**
 * @param {string} question
 * @param {object} opts  { apiKey, model, pricing, maxTokens, timeoutMs, search }
 */
async function run(question, opts = {}) {
  const started = Date.now();
  const model = opts.model || 'gpt-4o';
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return failure(model, started, 'OPENAI_API_KEY not set');

  const body = {
    model,
    input: question,
    max_output_tokens: opts.maxTokens || 1400,
  };
  // Offered, not forced — see the header.
  if (opts.search !== false) body.tools = [{ type: WEB_SEARCH_TOOL_TYPE }];

  const res = await postJson(HOST, PATH, { Authorization: `Bearer ${apiKey}` }, body, opts.timeoutMs);
  if (res.status !== 200 || !res.json) {
    const msg = (res.json && res.json.error && res.json.error.message) || res.raw;
    return failure(model, started, `HTTP ${res.status}: ${msg}`);
  }

  let text = '';
  const citations = [];
  let searchCalls = 0;

  for (const item of res.json.output || []) {
    // Counting the tool calls directly is the whole point. Inferring "did it
    // search?" from "were there citations?" restates one fact as two: you can
    // no longer tell "never looked" from "looked and cited nothing", and those
    // are different problems with different owners.
    if (item.type === 'web_search_call') { searchCalls++; continue; }
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      if (c.type !== 'output_text') continue;
      if (typeof c.text === 'string') text += c.text;
      for (const ann of c.annotations || []) {
        if (ann.type === 'url_citation' && ann.url) citations.push(ann.url);
      }
    }
  }

  const usage = res.json.usage || {};
  const tokensIn = usage.input_tokens || 0;
  const tokensOut = usage.output_tokens || 0;
  const actualModel = res.json.model || model;

  return {
    text: text || null,
    citations: [...new Set(citations)],
    searchCalls,
    tokensIn,
    tokensOut,
    costUsd: estimateCost(actualModel, tokensIn, tokensOut, searchCalls, opts.pricing),
    // Kept per answer so the cycle total can be DECOMPOSED later. One opaque
    // total is how a mispriced line item hides: see src/core/cost.js.
    costParts: costParts(actualModel, tokensIn, tokensOut, searchCalls, opts.pricing),
    webSearchToolType: WEB_SEARCH_TOOL_TYPE,
    pricingSourceVersion: PRICING_SOURCE_VERSION,
    // Record what ANSWERED, not what was asked for. APIs resolve an alias to a
    // dated snapshot, and that snapshot is what you are actually measuring — and
    // what your pricing table has to match.
    model: actualModel,
    latencyMs: Date.now() - started,
    status: text ? 'ok' : 'empty',
    error: null,
  };
}

/**
 * Cost, with a guard that errs in the recoverable direction.
 *
 * An unknown model is billed at the HIGHEST rate you know about, never a cheap
 * default. Pricing a model too low means the spend cap never fires and the
 * first warning anyone gets is a dead cycle mid-run. Pricing it too high just
 * stops the run early — loud, obvious, and fixable in a minute.
 *
 * This is not theoretical: a sibling adapter reported $0 for three cycles
 * straight because its model was unpriced, and the provider's own spend cap
 * killed a cycle with no warning.
 */
function rateFor(model, pricing = {}) {
  let p = pricing[model];
  if (!p) {
    // Exact miss — try the alias (drop a trailing -YYYY-MM-DD snapshot).
    const alias = String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '');
    p = pricing[alias];
  }
  if (p) return p;

  const known = Object.values(pricing);
  if (!known.length) return { in: 0, out: 0 };
  if (!rateFor._warned) rateFor._warned = new Set();
  if (!rateFor._warned.has(model)) {
    rateFor._warned.add(model);
    console.warn(`  [openai] no pricing for "${model}" — billing at the highest known rate `
      + 'so the spend cap stays protective. Add it to config.pricing.');
  }
  return known.reduce((a, b) => ((b.out || 0) > (a.out || 0) ? b : a));
}

function estimateCost(model, tokensIn, tokensOut, searchCalls, pricing = {}) {
  const p = rateFor(model, pricing);
  return (tokensIn || 0) * (p.in || 0) / 1e6
       + (tokensOut || 0) * (p.out || 0) / 1e6
       + (searchCalls || 0) * SEARCH_COST_PER_CALL;
}

/**
 * The same arithmetic as estimateCost, itemised.
 *
 * Reported separately because a single total cannot be audited. The programme
 * this came from carried a doubled search fee for four days precisely because
 * the only figure anyone could see was one number, and one number is always
 * plausible. Itemise it and the wrong line stands out immediately.
 */
function costParts(model, tokensIn, tokensOut, searchCalls, pricing = {}) {
  const p = rateFor(model, pricing);
  return {
    input_tokens: tokensIn || 0,
    output_tokens: tokensOut || 0,
    search_calls: searchCalls || 0,
    input_usd: (tokensIn || 0) * (p.in || 0) / 1e6,
    output_usd: (tokensOut || 0) * (p.out || 0) / 1e6,
    search_usd: (searchCalls || 0) * SEARCH_COST_PER_CALL,
    search_rate: SEARCH_COST_PER_CALL,
  };
}

module.exports = {
  run,
  estimateCost,
  costParts,
  SEARCH_COST_PER_CALL,
  WEB_SEARCH_TOOL_TYPE,
  WEB_SEARCH_RATES,
  PRICING_SOURCE_VERSION,
  alwaysSearches: false,
};
