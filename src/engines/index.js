/**
 * Engine registry.
 *
 * Each adapter exports `run(question, opts)` returning one shape, and a flag
 * saying whether it always grounds. Adding an engine is one file and one line
 * here — no other part of the pipeline knows which engines exist.
 *
 * ⚠️ WHICH ENGINES RAN IS PART OF THE MEASUREMENT. Inclusion is an equal-weight
 * average across engines, so adding or dropping one moves the headline for
 * reasons that have nothing to do with your brand. Pin the set in config and
 * treat a change as a deliberate re-baselining, never as a side effect.
 *
 * A real programme lost a cycle to this: a provider's free quota renewed, a
 * fourth engine silently started answering, and the resulting number could not
 * be compared with anything before it. The cycle had to be deleted.
 */

'use strict';

const ADAPTERS = {
  openai: require('./openai'),
  gemini: require('./gemini'),
  perplexity: require('./perplexity'),
};

function get(name) {
  const a = ADAPTERS[name];
  if (!a) {
    throw new Error(`unknown engine "${name}" — available: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return a;
}

/** Engines that ground on every call, so "no citations" is not "no search". */
function alwaysSearches(name) {
  return !!(ADAPTERS[name] && ADAPTERS[name].alwaysSearches);
}

module.exports = { get, alwaysSearches, names: Object.keys(ADAPTERS) };
