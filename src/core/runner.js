/**
 * RUNNER — asks the frozen questions and records what came back.
 *
 * Four design decisions, each of which exists because its absence cost money or
 * a cycle.
 *
 * 1. PERSIST AS YOU GO, AND MAKE ROW IDs DETERMINISTIC. Rows flush in batches
 *    rather than at the end, and `row_id` is derived from
 *    (cycle, question, engine, repeat). A run that dies at 80% can be restarted
 *    and it skips what already landed, instead of re-buying it. Long runs die:
 *    quotas, timeouts, a laptop lid. Resume is not a luxury.
 *
 * 2. INTERLEAVE THE REPEATS. Repeat 1 of every question, then repeat 2, rather
 *    than three calls of Q1 back to back. If the run stops early you have one
 *    observation of everything instead of three observations of a third — the
 *    first is a usable cycle, the second is not.
 *
 * 3. SEQUENTIAL STOPPING. With 3 repeats and majority-of-good-runs scoring, the
 *    third call cannot change the verdict once the first two agree. Skipping it
 *    is EXACT, not an approximation — no information is lost. It saves roughly
 *    a quarter of the spend.
 *
 * 4. A HARD SPEND CAP, CHECKED BETWEEN CALLS. Never a soft warning. But note
 *    what a cap stop means: the cycle is INCOMPLETE and must not be compared
 *    with a full one. The runner records that it stopped so the integrity
 *    metric can mark the cycle rather than quietly averaging a partial one.
 */

'use strict';

const engines = require('../engines');
const { createClassifier } = require('./classify');

const FLUSH_EVERY = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

/** Deterministic, so a resumed run recognises what already landed. */
const rowId = (runId, qId, engine, repeat) => `${runId}:${qId}:${engine}:${repeat}`;

/** Does the answer name the brand? Regex, not judgement — no model needed. */
function mentions(text, cfg) {
  if (!text) return false;
  const names = [cfg.brand.name, ...(cfg.brand.aliases || [])]
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return false;
  return new RegExp(`\\b(${names.join('|')})\\b`, 'i').test(text);
}

/**
 * @param {object} cfg
 * @param {object} store  storage driver
 * @param {object} opts   { runId, runDate, engines, repeats, capUsd, dryRun, questions }
 */
async function run(cfg, store, opts = {}) {
  const runDate = opts.runDate || today();
  const runId = opts.runId || `cycle_${runDate.replace(/-/g, '')}`;
  const repeats = Number(opts.repeats || cfg.repeats || 3);
  const engineList = opts.engines || cfg.engines;
  const capUsd = opts.capUsd != null ? opts.capUsd : cfg.limits.capUsd;
  const warnUsd = cfg.limits.warnUsd;
  const classifier = createClassifier(cfg);

  let questions = cfg.questions;
  if (opts.questions) {
    const want = new Set(String(opts.questions).split(',').map((s) => s.trim()));
    questions = questions.filter((q) => want.has(q.id));
  }

  // Sequential stopping only makes sense at 3 repeats with majority scoring.
  const sequential = repeats === 3 && !opts.fullFidelity;

  // Resume: what already landed for this cycle?
  const existing = await store.read('runs', { runId });
  const done = new Set(existing.map((r) => r.row_id));
  const cellHistory = new Map();
  for (const r of existing) {
    const k = `${r.question_id}||${r.engine}`;
    if (!cellHistory.has(k)) cellHistory.set(k, []);
    cellHistory.get(k).push({ repeat: r.repeat_index, ok: r.status === 'ok', mentioned: !!r.mentioned });
  }

  // Repeat-major order — see design note 2.
  const work = [];
  for (let rep = 1; rep <= repeats; rep++) {
    for (const q of questions) {
      for (const engine of engineList) work.push({ q, engine, rep });
    }
  }

  console.log(`\n  cycle      ${runId}  (${runDate})`);
  console.log(`  questions  ${questions.length} x ${engineList.join(', ')} x ${repeats} repeats`);
  console.log(`  planned    ${work.length} calls`);
  console.log(`  resuming   ${done.size} already landed`);
  console.log(`  sequential ${sequential ? 'on — 3rd call skipped when 1 and 2 agree' : 'off'}`);
  console.log(`  cost cap   $${capUsd.toFixed(2)} hard / $${warnUsd.toFixed(2)} warn`);
  if (opts.dryRun) console.log('  DRY RUN — no calls will be made\n');

  let made = 0; let failed = 0; let skipped = 0; let saved = 0;
  let spend = 0; let capHit = false; let warned = false;
  let runBuf = []; let citeBuf = [];

  const flush = async (force = false) => {
    if (!force && runBuf.length < FLUSH_EVERY) return;
    if (!runBuf.length && !citeBuf.length) return;
    const rb = runBuf; const cb = citeBuf;
    runBuf = []; citeBuf = [];
    try {
      if (rb.length) await store.append('runs', rb);
      if (cb.length) await store.append('citations', cb);
    } catch (e) {
      // Put them back rather than dropping answers already paid for.
      runBuf = rb.concat(runBuf);
      citeBuf = cb.concat(citeBuf);
      console.error(`     ! flush failed, will retry: ${e.message}`);
    }
  };

  for (const item of work) {
    const id = rowId(runId, item.q.id, item.engine, item.rep);
    if (done.has(id)) { skipped++; continue; }

    if (spend >= capUsd) {
      if (!capHit) console.warn(`\n  !! cost cap $${capUsd} reached — stopping. `
        + 'This cycle is INCOMPLETE and must not be compared with a full one.');
      capHit = true;
      break;
    }
    if (!warned && spend >= warnUsd) {
      warned = true;
      console.warn(`  .. $${spend.toFixed(2)} spent, warn level $${warnUsd}`);
    }

    // Sequential stopping — exact, see design note 3.
    if (sequential && item.rep === 3) {
      const hist = (cellHistory.get(`${item.q.id}||${item.engine}`) || [])
        .filter((h) => h.ok && h.repeat < 3);
      if (hist.length === 2 && hist[0].mentioned === hist[1].mentioned) { saved++; continue; }
    }

    if (opts.dryRun) { made++; continue; }

    const adapter = engines.get(item.engine);
    const eCfg = (cfg.engineOptions || {})[item.engine] || {};
    let res;
    try {
      // The bare question. No system prompt, no priming, no history — every
      // nudge is one a real user never gets, and it inflates your own score.
      res = await adapter.run(item.q.text, { ...eCfg, pricing: cfg.pricing || {} });
    } catch (e) {
      res = { status: 'error', error: e.message, text: null, citations: [],
        tokensIn: 0, tokensOut: 0, costUsd: 0, model: eCfg.model || null };
    }

    const ok = res.status === 'ok';
    if (ok) made++; else failed++;
    spend += Number(res.costUsd) || 0;

    const cites = res.citations || [];
    const cls = classifier.summarise(cites);
    const named = ok && mentions(res.text, cfg);

    const hist = cellHistory.get(`${item.q.id}||${item.engine}`) || [];
    hist.push({ repeat: item.rep, ok, mentioned: named });
    cellHistory.set(`${item.q.id}||${item.engine}`, hist);

    runBuf.push({
      run_id: runId, row_id: id, run_date: runDate, run_ts: new Date().toISOString(),
      question_id: item.q.id, question_group: item.q.group, question_text: item.q.text,
      branded: !!item.q.branded,
      engine: item.engine, repeat_index: item.rep,
      mentioned: named,
      response_text: String(res.text || '').slice(0, 60000),
      sources_total: cls.total,
      sources_ours: cls.ours,
      sources_independent: cls.independent,
      sources_corroborating: cls.corroborating,
      sources_about_us: cls.aboutUs,
      sources_wrong_company: cls.wrongCompany,
      sources_unclassified: (cls.byClass.UNCLASSIFIED || 0),
      // Measured where the adapter reports it; inferred only where it cannot.
      // "Did it search" and "were there citations" must not be the same fact
      // stated twice, or you can never tell one failure from the other.
      search_calls: res.searchCalls == null ? null : Number(res.searchCalls),
      search_used: engines.alwaysSearches(item.engine) ? true
        : (res.searchCalls != null ? res.searchCalls > 0 : cites.length > 0),
      model: res.model || null,
      rules_version: classifier.rulesVersion,
      tokens_in: res.tokensIn || 0,
      tokens_out: res.tokensOut || 0,
      cost_usd: Number(res.costUsd) || 0,
      // Itemised alongside the total so the cycle cost can be decomposed
      // without re-deriving prices. See src/core/cost.js for why one number is
      // not enough.
      cost_input_usd: res.costParts ? res.costParts.input_usd : null,
      cost_output_usd: res.costParts ? res.costParts.output_usd : null,
      cost_search_usd: res.costParts ? res.costParts.search_usd : null,
      search_rate_usd: res.costParts ? res.costParts.search_rate : null,
      web_search_tool_type: res.webSearchToolType || null,
      pricing_source_version: res.pricingSourceVersion || null,
      latency_ms: res.latencyMs || null,
      status: res.status || (ok ? 'ok' : 'error'),
      error_message: res.error || null,
    });

    cites.forEach((url, i) => {
      const k = classifier.classify(url);
      citeBuf.push({
        run_id: runId, row_id: id, run_date: runDate,
        question_id: item.q.id, engine: item.engine, repeat_index: item.rep,
        citation_index: i, cited_url: url, cited_domain: classifier.hostOf(url),
        source_class: k.cls, is_ours: k.ours, is_independent: k.independent,
        is_wrong_company: k.wrongCompany,
      });
    });

    if ((made + failed) % 25 === 0) {
      process.stdout.write(`\r     ${made + failed}/${work.length}  $${spend.toFixed(3)}   `);
    }
    await flush();
    if (opts.pauseMs) await sleep(opts.pauseMs);
  }

  await flush(true);

  const log = {
    run_id: runId, run_date: runDate, step: 'runner',
    started_at: new Date().toISOString(),
    calls_made: made, calls_failed: failed, skipped_existing: skipped,
    sequential_saved: saved, cost_usd: Number(spend.toFixed(4)),
    cap_usd: capUsd, cap_hit: capHit,
    engines: engineList.join('+'), repeats,
    rules_version: classifier.rulesVersion,
  };
  await store.append('run_log', [log]);

  console.log(`\n     done. ${made} calls, ${failed} failed, ${skipped} skipped, `
    + `${saved} saved by sequential stopping, $${spend.toFixed(3)} spent.`);
  if (capHit) console.log('     !! cap stop — cycle incomplete');

  return { runId, runDate, made, failed, skipped, saved, spend, capHit };
}

module.exports = { run, rowId, mentions };
