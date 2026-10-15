/**
 * Perplexity adapter.
 *
 * Perplexity always grounds — it searches on essentially every question, which
 * makes it the engine most sensitive to what is actually published about you,
 * and the one where third-party work shows up first. Treat it as the leading
 * indicator, not the average.
 *
 * `alwaysSearches` is true for exactly that reason: there is no tool-call to
 * count, so the runner must not infer "did not search" from "no citations".
 */

'use strict';

const { postJson, failure } = require('./http');

const HOST = 'api.perplexity.ai';
const PATH = '/chat/completions';

async function run(question, opts = {}) {
  const started = Date.now();
  const model = opts.model || 'sonar';
  const apiKey = opts.apiKey || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return failure(model, started, 'PERPLEXITY_API_KEY not set');

  const res = await postJson(HOST, PATH, { Authorization: `Bearer ${apiKey}` }, {
    model,
    // No system prompt and no priming, deliberately. Every nudge you add is a
    // nudge a real user never gets, and it inflates your own score.
    messages: [{ role: 'user', content: question }],
    max_tokens: opts.maxTokens || 1400,
  }, opts.timeoutMs);

  if (res.status !== 200 || !res.json) {
    const msg = (res.json && res.json.error && res.json.error.message) || res.raw;
    return failure(model, started, `HTTP ${res.status}: ${msg}`);
  }

  const choice = (res.json.choices || [])[0] || {};
  const text = (choice.message && choice.message.content) || '';

  // Perplexity returns citations as a first-class array. Older responses used
  // bare strings; newer ones use objects. Handle both rather than silently
  // dropping every citation the day the shape changes.
  const citations = (res.json.citations || res.json.search_results || [])
    .map((c) => (typeof c === 'string' ? c : (c && (c.url || c.link))))
    .filter(Boolean);

  const usage = res.json.usage || {};
  const tokensIn = usage.prompt_tokens || 0;
  const tokensOut = usage.completion_tokens || 0;
  const p = (opts.pricing || {})[model] || {};

  return {
    text: text || null,
    citations: [...new Set(citations)],
    searchCalls: null,          // not reported; alwaysSearches covers it
    tokensIn,
    tokensOut,
    costUsd: tokensIn * (p.in || 0) / 1e6 + tokensOut * (p.out || 0) / 1e6,
    model,
    latencyMs: Date.now() - started,
    status: text ? 'ok' : 'empty',
    error: null,
  };
}

module.exports = { run, alwaysSearches: true };
