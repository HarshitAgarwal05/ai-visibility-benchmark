/**
 * CYCLE COST — decomposed, with the judge in the total and an audit trail.
 *
 * Three lessons live in this file, and all three were learned by publishing a
 * wrong number first.
 *
 * ── 1. ONE TOTAL IS NOT AUDITABLE ──────────────────────────────────────────
 *
 * A cycle cost is four or five quite different things added together: input
 * tokens, output tokens, per-call search fees, the other engines, the judge.
 * Collapsed into one figure, any of them can be wrong by a factor of two and
 * the total still looks plausible — so nobody checks it.
 *
 * A doubled web-search fee survived four days in the programme this came from
 * for exactly that reason. A cycle was reported at $8.70 when it had cost
 * $6.48. The moment the same figure was itemised, the wrong line was obvious:
 * the search row was priced at the preview tool's rate while the request sent
 * the modern tool. Nothing had been overspent. It had been mis-recorded, which
 * is worse — the budget conversation that follows is about a number nobody can
 * reproduce.
 *
 * ── 2. THE JUDGE IS PART OF THE BENCHMARK ──────────────────────────────────
 *
 * It is tempting to count "cost" as what you pay the engines, and to treat
 * scoring as analytics overhead sitting outside the measurement. It is not
 * outside: no metric on the card exists without it.
 *
 * Leaving it out understated three cycles by more than the engine bill itself —
 * $1.41 reported against a true $5.47, because the judge was a frontier model
 * at $4.06 a cycle. The engine figure was accurate and the headline was wrong
 * by a factor of four.
 *
 * But merging them into one opaque figure hides each in the other. Asking and
 * reading are different questions with different fixes: a cheaper judge and a
 * narrower question set are unrelated levers. So the judge is IN the total, and
 * it is its OWN line.
 *
 * ── 3. DO NOT OVERWRITE WHAT YOU PUBLISHED ─────────────────────────────────
 *
 * When a pricing bug is fixed, the instinct is to re-derive history so the
 * chart is "right". That destroys the ability to explain the chart: "what the
 * dashboard said at the time" and "what it really cost" are different
 * questions, and a reader who remembers the old figure deserves a better answer
 * than silence.
 *
 * So `reported_at_time` is recorded beside the reconciled total and is never
 * recomputed. Had that column existed before the back-fill in the original
 * programme, one cycle's original figure would not have been lost — it had to
 * be written back by hand from memory. Add the audit column BEFORE the
 * correction, not after.
 */

'use strict';

const n = (v) => Number(v) || 0;
const usd = (v) => `$${n(v).toFixed(2)}`;

/**
 * Split engine input tokens into "the prompt" and "what the search dragged in".
 *
 * Only meaningful for tools that bill search-result tokens at the model's input
 * rate — on those, a searching answer carries several times the input of one
 * that did not search, and that difference is the largest hidden line in the
 * bill.
 *
 * It is DERIVED, and it says so wherever it is reported. The baseline is the
 * median input of this cycle's non-searching answers: the one honest estimate
 * available without a provider usage API. If the cycle has no non-searching
 * answers to compare against, no split is claimed at all.
 *
 * @returns {{derived: boolean, prompt_tokens: number, search_tokens: number}}
 */
function splitInputTokens(rows) {
  const searched = rows.filter((r) => n(r.search_calls) > 0 && n(r.tokens_in) > 0);
  const plain = rows.filter((r) => n(r.search_calls) === 0 && n(r.tokens_in) > 0);
  if (!searched.length || !plain.length) {
    return {
      derived: false,
      prompt_tokens: rows.reduce((a, r) => a + n(r.tokens_in), 0),
      search_tokens: 0,
    };
  }
  const sorted = plain.map((r) => n(r.tokens_in)).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length / 2)];

  let prompt = 0;
  let search = 0;
  for (const r of rows) {
    const t = n(r.tokens_in);
    if (n(r.search_calls) > 0 && t > baseline) {
      prompt += baseline;
      search += t - baseline;
    } else {
      prompt += t;
    }
  }
  return { derived: true, baseline_tokens: baseline, prompt_tokens: prompt, search_tokens: search };
}

/**
 * Itemise a cycle.
 *
 * @param {Array}  runs    run rows for the cycle
 * @param {Array}  scores  score rows for the cycle (these carry the judge cost)
 * @param {object} [opts]  { reportedAtTime } a previously published total, preserved verbatim
 */
function decompose(runs, scores = [], opts = {}) {
  const lines = [];
  const byEngine = new Map();
  for (const r of runs) {
    const e = r.engine || 'unknown';
    if (!byEngine.has(e)) byEngine.set(e, []);
    byEngine.get(e).push(r);
  }

  // An engine that reports itemised costs gets itemised lines; the rest get one
  // line each. Reporting a decomposition an adapter cannot supply would be
  // inventing detail, and invented detail is how the first bug got in.
  for (const [engine, rows] of [...byEngine].sort()) {
    const itemised = rows.some((r) => r.cost_input_usd != null);
    if (!itemised) {
      const total = rows.reduce((a, r) => a + n(r.cost_usd), 0);
      lines.push({
        section: 'ENGINE',
        label: engine,
        usd: total,
        // "Zero" and "unpriced" look identical in a total and mean opposite
        // things. A sibling adapter reported $0 for three cycles because its
        // model was unpriced; the provider's own cap then killed a cycle with
        // no warning. Say which one this is.
        note: total === 0 && rows.length ? 'reports no cost — UNPRICED, not free' : null,
      });
      continue;
    }

    const split = splitInputTokens(rows);
    const inputUsd = rows.reduce((a, r) => a + n(r.cost_input_usd), 0);
    const totalTokens = split.prompt_tokens + split.search_tokens;
    const share = split.derived && totalTokens > 0 ? split.search_tokens / totalTokens : 0;
    const calls = rows.reduce((a, r) => a + n(r.search_calls), 0);
    const rateRow = rows.find((r) => r.search_rate_usd != null);

    lines.push({
      section: 'ENGINE',
      label: `${engine} model input`,
      usd: inputUsd * (1 - share),
      note: `${split.prompt_tokens.toLocaleString()} tokens`,
    });
    if (share > 0) {
      lines.push({
        section: 'ENGINE',
        label: `${engine} search content`,
        usd: inputUsd * share,
        note: `${split.search_tokens.toLocaleString()} tokens — DERIVED, baseline ${split.baseline_tokens}`,
      });
    }
    lines.push({
      section: 'ENGINE',
      label: `${engine} output`,
      usd: rows.reduce((a, r) => a + n(r.cost_output_usd), 0),
      note: `${rows.reduce((a, r) => a + n(r.tokens_out), 0).toLocaleString()} tokens`,
    });
    lines.push({
      section: 'ENGINE',
      label: `${engine} web search calls`,
      usd: rows.reduce((a, r) => a + n(r.cost_search_usd), 0),
      note: rateRow ? `${calls} @ $${rateRow.search_rate_usd}` : `${calls} calls`,
    });
  }

  const costEngine = runs.reduce((a, r) => a + n(r.cost_usd), 0);
  const costJudge = scores.reduce((a, s) => a + n(s.cost_usd), 0);
  const judgeModel = (scores.find((s) => s.judge_model) || {}).judge_model || null;

  lines.push({
    section: 'EVALUATION',
    label: `judge${judgeModel ? ` (${judgeModel})` : ''}`,
    usd: costJudge,
    note: costJudge === 0 && scores.length ? 'reports no cost — UNPRICED, not free' : null,
  });

  return {
    lines,
    cost_engine: Number(costEngine.toFixed(4)),
    cost_judge: Number(costJudge.toFixed(4)),
    cost_total_benchmark: Number((costEngine + costJudge).toFixed(4)),
    // Never recomputed. See lesson 3 in the header.
    reported_at_time: opts.reportedAtTime != null ? Number(opts.reportedAtTime) : null,
  };
}

/** Console view. The itemisation is the point, so it prints by default. */
function print(b) {
  console.log('\n  ── COST ──────────────────────────────────────────────');
  const engineLines = b.lines.filter((l) => l.section === 'ENGINE');
  let section = null;
  for (const l of b.lines) {
    if (l.section !== section) {
      section = l.section;
      console.log(`  ${section === 'ENGINE' ? 'Engine answers' : 'Evaluation / scoring'}`);
    }
    console.log(`    ${l.label.padEnd(30)} ${usd(l.usd).padStart(8)}   ${l.note || ''}`);
    if (l === engineLines[engineLines.length - 1]) {
      console.log(`    ${'engine subtotal'.padEnd(30)} ${usd(b.cost_engine).padStart(8)}`);
    }
  }
  console.log(`  ${'TOTAL CYCLE COST'.padEnd(32)} ${usd(b.cost_total_benchmark).padStart(8)}`);
  if (b.reported_at_time != null
      && Math.abs(b.reported_at_time - b.cost_total_benchmark) > 0.005) {
    console.log(`  ${'reported at the time'.padEnd(32)} ${usd(b.reported_at_time).padStart(8)}`
      + '   kept deliberately — see cost.js');
  }
  console.log('');
}

module.exports = { decompose, print, splitInputTokens };
