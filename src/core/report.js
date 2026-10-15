/**
 * REPORT — one row per metric per cycle, plus a readable console summary.
 *
 * Rows rather than a nested blob, so a chart across cycles is one GROUP BY and
 * a human can read the table without a parser.
 *
 * Every row carries the previous value and the target, because a number on its
 * own is not a direction. And "previous" means EARLIER THAN THIS ONE, not
 * "some other cycle" — re-score a historical cycle with the naive version and
 * it compares itself against the future, inverting every arrow with no error.
 */

'use strict';

const metricsLib = require('./metrics');
const costLib = require('./cost');

const pct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);

/** Join runs to scores so metrics see one flat row per answer. */
function joinScores(runs, scores) {
  const byRow = new Map(scores.map((s) => [s.row_id, s]));
  return runs.map((r) => ({ ...r, ...(byRow.get(r.row_id) || {}) }));
}

async function build(cfg, store, { runId, runDate }) {
  const runs = await store.read('runs', { runId });
  if (!runs.length) return { runId, metrics: 0, rows: [] };
  const scores = await store.read('scores', { runId });
  const rows = joinScores(runs, scores);
  const m = metricsLib.computeAll(rows, cfg);

  // Previous cycle = the most recent one STRICTLY EARLIER than this.
  const allSummary = await store.read('summary');
  const earlier = allSummary.filter((s) => s.run_date < runDate);
  let prev = new Map();
  if (earlier.length) {
    const prevDate = earlier.map((s) => s.run_date).sort().pop();
    prev = new Map(earlier.filter((s) => s.run_date === prevDate).map((s) => [s.metric, s.value_num]));
  }

  const out = [];
  const push = (metric, section, text, num, opts = {}) => {
    const before = prev.has(metric) ? prev.get(metric) : null;
    out.push({
      run_id: runId, run_date: runDate, metric, section,
      value_text: text,
      value_num: num == null ? null : Number(num),
      prev_num: before,
      delta: (before != null && num != null) ? Number(num) - before : null,
      target_num: cfg.targets[metric] != null ? cfg.targets[metric] : null,
      breached: !!opts.breached,
      metrics_version: metricsLib.METRICS_VERSION,
      rules_version: cfg.rulesVersion || null,
      facts_version: (cfg.facts && cfg.facts.version) || null,
      built_at: new Date().toISOString(),
    });
  };

  const ok = rows.filter((r) => r.status === 'ok').length;

  // Cost, itemised, with the judge counted and the published figure preserved.
  // "What the dashboard said then" is never recomputed — see core/cost.js.
  const priorSummary = allSummary.filter((s) => s.run_id === runId);
  const priorTotal = priorSummary.find((s) => s.metric === 'cost_reported_at_time')
    || priorSummary.find((s) => s.metric === 'cost_total_benchmark')
    || priorSummary.find((s) => s.metric === 'cost_usd');
  const breakdown = costLib.decompose(runs, scores, {
    reportedAtTime: priorTotal ? priorTotal.value_num : null,
  });

  push('answers_collected', 'STATUS', `${rows.length} answers (${ok} ok)`, rows.length);
  push('cycle_validity', 'STATUS', m.integrity.overall, null,
    { breached: m.integrity.overall !== metricsLib.VALIDITY.VALID });
  push('cost_engine', 'STATUS', `$${breakdown.cost_engine.toFixed(2)} to ask`,
    breakdown.cost_engine);
  push('cost_judge', 'STATUS', `$${breakdown.cost_judge.toFixed(2)} to read`,
    breakdown.cost_judge);
  push('cost_total_benchmark', 'STATUS',
    `$${breakdown.cost_total_benchmark.toFixed(2)} (engine + judge)`,
    breakdown.cost_total_benchmark);
  if (breakdown.reported_at_time != null) {
    push('cost_reported_at_time', 'STATUS',
      `$${breakdown.reported_at_time.toFixed(2)} — what was published at the time`,
      breakdown.reported_at_time);
  }

  // Say the method in the value. A dashboard reader has no other place to see
  // that this is an equal-weight average rather than a raw count of answers.
  push('core_inclusion', 'RESULT',
    `${pct(m.core_inclusion.rate)} (equal weight per engine)`, m.core_inclusion.rate);
  push('core_inclusion_any', 'RESULT', pct(m.core_inclusion_any.rate), m.core_inclusion_any.rate);
  for (const [engine, e] of Object.entries(m.core_inclusion.engines)) {
    push(`core_inclusion_${engine}`, 'RESULT',
      `${pct(e.rate)} (${e.included}/${e.usable_cells} cells, ${e.validity})`, e.rate,
      { breached: e.validity === metricsLib.VALIDITY.INVALID });
  }
  push('total_non_branded', 'RESULT', pct(m.total_non_branded.rate), m.total_non_branded.rate);

  push('corroboration', 'LADDER',
    `${pct(m.corroboration.rate)} (${m.corroboration.corroborated} of ${m.corroboration.mentions} mentions)`,
    m.corroboration.rate);
  push('independent_share', 'LADDER',
    `${pct(m.independent_share.rate)}${m.independent_share.note ? ` — ${m.independent_share.note}` : ''}`,
    m.independent_share.rate);

  push('branded_recall', 'GUARDRAIL',
    `${pct(m.branded_recall.rate)}${m.branded_recall.blackouts.length
      ? ` — BLACKOUT: ${m.branded_recall.blackouts.map((b) => `${b.question_id}/${b.engine}`).join(', ')}`
      : ''}`,
    m.branded_recall.rate, { breached: m.branded_recall.breached });
  push('entity_confusion', 'GUARDRAIL',
    `${pct(m.entity_confusion.rate)} (${m.entity_confusion.wrong} of ${m.entity_confusion.denominator} about-us sources)`,
    m.entity_confusion.rate);
  push('accuracy_breaches', 'GUARDRAIL',
    `${m.accuracy.flagged} flagged, ${m.accuracy.serious} serious`,
    m.accuracy.serious, { breached: m.accuracy.breached });

  await store.replaceCycle('summary', runId, out);
  return { runId, metrics: out.length, rows: out, computed: m, cost: breakdown };
}

/** Console view. The dashboard is optional; this is not. */
function print(rows, cfg) {
  const by = new Map(rows.map((r) => [r.metric, r]));
  const line = (label, key) => {
    const r = by.get(key);
    if (!r) return;
    const arrow = r.delta == null ? '' : (r.delta > 0 ? ` ▲ ${r.delta.toFixed(1)}`
      : r.delta < 0 ? ` ▼ ${Math.abs(r.delta).toFixed(1)}` : ' —');
    const target = r.target_num != null ? `   target ${r.target_num}` : '';
    const flag = r.breached ? '  !! BREACHED' : '';
    console.log(`  ${label.padEnd(30)} ${String(r.value_text).padEnd(46)}${arrow}${target}${flag}`);
  };

  console.log('\n  ── RESULT ────────────────────────────────────────────');
  line('Core inclusion', 'core_inclusion');
  for (const e of cfg.engines) line(`  └ ${e}`, `core_inclusion_${e}`);
  line('Inclusion (any run)', 'core_inclusion_any');

  console.log('\n  ── LADDER ────────────────────────────────────────────');
  line('Independent corroboration', 'corroboration');
  line('Independent source share', 'independent_share');

  console.log('\n  ── GUARDRAILS ────────────────────────────────────────');
  line('Branded recall', 'branded_recall');
  line('Entity confusion', 'entity_confusion');
  line('Accuracy breaches', 'accuracy_breaches');

  console.log('\n  ── STATUS ────────────────────────────────────────────');
  line('Cycle validity', 'cycle_validity');
  line('Answers collected', 'answers_collected');
  // Cost gets its own itemised block rather than a single line here. One total
  // is what let a doubled search fee hide for four days.
  line('Cost to ask (engines)', 'cost_engine');
  line('Cost to read (judge)', 'cost_judge');
  line('Total benchmark cost', 'cost_total_benchmark');
  console.log('');
}

module.exports = { build, print, joinScores };
