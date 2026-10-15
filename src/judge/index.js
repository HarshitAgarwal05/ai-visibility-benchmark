/**
 * THE JUDGE — turns an answer into the columns a regex cannot decide.
 *
 * Fills: recommended · position · wrong_facts · severity · competitors.
 *
 * ── Why this is a separate step ────────────────────────────────────────────
 *
 * Scoring runs apart from asking, so changing HOW you score never means paying
 * for the answers again. Any past cycle can be re-judged under a corrected fact
 * sheet and compared like for like. That is not a nicety — it is the only way
 * to fix a scoring bug without throwing away your history.
 *
 * To make that possible, every score records `facts_version`. Re-scoring then
 * has a cheap question to ask: which answers were judged against a sheet that
 * has since changed? Without that field the choice is re-score everything or
 * nothing, and both are wrong.
 *
 * ── The failure mode to design against ─────────────────────────────────────
 *
 * A stale fact does not go quiet. It manufactures breaches: the judge marks an
 * engine WRONG for stating something that became true after you last edited the
 * sheet. One line saying a product did not exist, thirteen days out of date,
 * produced 52 false "serious" findings in a single cycle — roughly forty of
 * which were engines being accurate.
 *
 * So facts carry `mutable` and `checked`, and `staleFacts()` warns before a run
 * rather than after the report.
 *
 * ── Calibration ────────────────────────────────────────────────────────────
 *
 * The prompt tells the judge to choose the LOWER severity when unsure. An
 * inflated breach count corrupts a multi-year series and sends people to fix
 * things that are not broken. Under-reporting costs a cycle; over-reporting
 * costs trust in the whole instrument.
 */

'use strict';

const { postJson } = require('../engines/http');

const BATCH_SIZE = 10;

const SYSTEM = `You score AI answers for a longitudinal brand-visibility benchmark.

You are NOT promoting the brand. You are measuring it, and an inflated score
corrupts a multi-year series. When genuinely unsure, choose the LOWER
classification.

For each answer decide:

1. recommended — did the answer actively put the brand forward as an option?
   "Yes"     recommends, endorses or lists it as a suggested option
   "Neutral" named only descriptively, or with balanced caveats
   "No"      absent, dismissed, or mentioned only as something to avoid
   "N/A"     the QUESTION ITSELF names the brand, so recommendation is meaningless

2. position — where in the answer it first appears as an option:
   "1st" | "2nd" | "3rd" | "later" | "n/a"

3. wrong_facts — anything the answer states about the brand that contradicts
   the FACTS below. Quote the claim. Write "none" when there is nothing.
   Judge ONLY against the FACTS. If the facts do not cover a claim, it is not a
   breach — say nothing rather than guessing.

4. wrong_facts_severity — "none" | "minor" | "serious".
   serious = a buyer could act on it and be misled (a product that does not
             exist, a fabricated metric, the wrong company entirely)
   minor   = imprecise, outdated phrasing, or a figure close to a real one
   A claim the facts can neither confirm nor deny is MINOR at most, never serious.

5. competitors — other products named in the answer, comma separated, or "none".

Return strict JSON only.`;

function factSheet(cfg) {
  const f = cfg.facts || {};
  const lines = (f.entries || []).map((e) => {
    const tag = e.mutable ? `[MUTABLE — last checked ${e.checked || 'unknown'}] ` : '';
    return `- ${tag}${e.text}`;
  });
  const never = (f.never || []).map((n) => `- ${n}`);
  return [
    `BRAND: ${cfg.brand.name}`,
    cfg.brand.aliases && cfg.brand.aliases.length
      ? `Also written as: ${cfg.brand.aliases.join(', ')}` : '',
    '',
    'VERIFIED FACTS — judge against THIS, not against general knowledge:',
    ...lines,
    never.length ? '\nNEVER ACCEPT, whatever an engine says:' : '',
    ...never,
  ].filter(Boolean).join('\n');
}

/**
 * Facts that move on their own and have not been checked recently.
 *
 * Surfaced BEFORE a run, because the cost of discovering it afterwards is a
 * cycle of false breaches that look exactly like real ones.
 */
function staleFacts(cfg, maxAgeDays = 30) {
  const now = Date.now();
  return (cfg.facts.entries || [])
    .filter((e) => e.mutable)
    .map((e) => {
      const age = e.checked
        ? Math.floor((now - new Date(e.checked).getTime()) / 86400000)
        : Infinity;
      return { ...e, ageDays: age };
    })
    .filter((e) => e.ageDays > maxAgeDays);
}

const SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          row_id: { type: 'string' },
          recommended: { type: 'string', enum: ['Yes', 'Neutral', 'No', 'N/A'] },
          position: { type: 'string', enum: ['1st', '2nd', '3rd', 'later', 'n/a'] },
          wrong_facts: { type: 'string' },
          wrong_facts_severity: { type: 'string', enum: ['none', 'minor', 'serious'] },
          competitors: { type: 'string' },
        },
        required: ['row_id', 'recommended', 'position', 'wrong_facts',
          'wrong_facts_severity', 'competitors'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
};

const trim = (s, max = 6000) => {
  const t = String(s || '');
  return t.length <= max ? t : `${t.slice(0, max)}\n…[truncated]`;
};

async function judgeBatch(batch, cfg, opts) {
  const apiKey = opts.apiKey || process.env.JUDGE_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('JUDGE_API_KEY (or OPENAI_API_KEY) not set');
  const model = opts.model || process.env.JUDGE_MODEL || 'gpt-4o-mini';

  const payload = batch.map((r) => ({
    row_id: r.row_id,
    question: r.question_text,
    question_names_the_brand: !!r.branded,
    answer: trim(r.response_text),
  }));

  const res = await postJson('api.openai.com', '/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` }, {
      model,
      messages: [
        { role: 'system', content: `${SYSTEM}\n\n${factSheet(cfg)}` },
        { role: 'user', content: JSON.stringify({ answers: payload }) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'scores', schema: SCHEMA, strict: true },
      },
      temperature: 0,
    }, opts.timeoutMs || 120000);

  if (res.status !== 200 || !res.json) {
    const msg = (res.json && res.json.error && res.json.error.message) || res.raw;
    throw new Error(`judge HTTP ${res.status}: ${String(msg).slice(0, 200)}`);
  }

  const content = ((res.json.choices || [])[0] || {}).message || {};
  let parsed;
  try { parsed = JSON.parse(content.content || '{}'); } catch (_) {
    throw new Error('judge returned unparseable JSON');
  }
  const usage = res.json.usage || {};
  const p = (opts.pricing || {})[model] || {};
  return {
    scores: parsed.scores || [],
    costUsd: (usage.prompt_tokens || 0) * (p.in || 0) / 1e6
           + (usage.completion_tokens || 0) * (p.out || 0) / 1e6,
    model,
  };
}

/**
 * Score answers. Returns score rows ready to store.
 *
 * @param {Array}  rows  run rows with response_text
 * @param {object} cfg
 * @param {object} opts  { apiKey, model, pricing, capUsd, onProgress }
 */
async function score(rows, cfg, opts = {}) {
  const todo = rows.filter((r) => r.status === 'ok' && r.response_text);
  const out = [];
  let spend = 0;
  const cap = opts.capUsd != null ? opts.capUsd : 5;
  const factsVersion = (cfg.facts && cfg.facts.version) || 'none';

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    if (spend >= cap) {
      console.warn(`  [judge] cap $${cap} reached — ${todo.length - i} answers left unscored`);
      break;
    }
    const batch = todo.slice(i, i + BATCH_SIZE);
    let res;
    try {
      res = await judgeBatch(batch, cfg, opts);
    } catch (e) {
      console.warn(`  [judge] batch failed (${e.message}) — retrying once`);
      try { res = await judgeBatch(batch, cfg, opts); } catch (e2) {
        console.error(`  [judge] batch abandoned: ${e2.message}`);
        continue;
      }
    }
    spend += res.costUsd;

    const byId = new Map(res.scores.map((s) => [s.row_id, s]));
    // Judge cost, carried on the score row rather than only returned.
    //
    // It has to be durable. A cycle total assembled from "engine rows in
    // storage" plus "whatever the judge happened to return in this process" is
    // not reproducible: re-run the report tomorrow and the judge line is zero.
    // That is exactly how a programme came to publish $1.41 for cycles that
    // truly cost $5.47 — the missing $4.06 was the judge, and nothing on disk
    // remembered it. Split evenly across the batch; per-answer precision is not
    // available from a batched call and pretending otherwise would be worse.
    const perRow = res.costUsd / Math.max(1, batch.length);
    for (const r of batch) {
      const s = byId.get(r.row_id);
      if (!s) continue;
      out.push({
        run_id: r.run_id,
        row_id: r.row_id,
        cost_usd: perRow,
        recommended: s.recommended,
        position: s.position,
        wrong_facts: s.wrong_facts,
        wrong_facts_severity: s.wrong_facts_severity,
        competitors: s.competitors,
        // The field that makes a targeted re-score possible at all.
        facts_version: factsVersion,
        judge_model: res.model,
        scored_at: new Date().toISOString(),
      });
    }
    if (opts.onProgress) opts.onProgress(Math.min(i + BATCH_SIZE, todo.length), todo.length, spend);
  }

  return { scores: out, costUsd: spend };
}

module.exports = { score, staleFacts, factSheet, SYSTEM };
