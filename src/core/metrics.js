/**
 * METRICS — the definitions, and the reasoning behind each one.
 *
 * Every metric here is stated with its denominator, because a percentage
 * without one is a rumour. Each is also versioned: change a definition and the
 * series breaks, so the version travels with the number.
 *
 * The hard-won rules, all of which cost a real programme real cycles:
 *
 *   MACRO-AVERAGE ACROSS ENGINES, NEVER POOLED. If one engine answers twice as
 *   often as another, pooling lets that engine's behaviour set your headline.
 *   Equal weight per engine means the number describes the category, not the
 *   sampling.
 *
 *   A CELL NEEDS TWO GOOD RUNS. Generative answers vary. One observation is an
 *   anecdote; a cell with fewer than two successful runs is excluded and the
 *   cycle's coverage is reported so nobody quietly compares a thin cycle with
 *   a full one.
 *
 *   BRANDED RECALL IS A CONTROL, NOT A SCORE. If the engine cannot name you
 *   when the question contains your name, nothing else in the cycle means
 *   anything. It belongs with the guardrails and should sit near 100%.
 *
 *   COUNT THE UNKNOWN POOL. Unclassified citations are excluded from the
 *   independence metrics, which makes those metrics an optimistic bound. Report
 *   the size of the pool next to them or the reader cannot tell.
 */

'use strict';

const { CORROBORATING_CLASSES } = require('../config');

const METRICS_VERSION = '1.0.0';
const VALIDITY = { VALID: 'VALID', PARTIAL: 'PARTIAL', INVALID: 'INVALID' };

const sum = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * Cells with enough successful runs to be read at all, grouped per engine.
 * `okRuns >= minRuns` is the whole gate — everything downstream trusts it.
 */
function engineCells(rows, opts) {
  const cells = groupBy(rows, (r) => `${r.engine}||${r.question_id}`);
  const out = new Map();
  for (const [key, rs] of cells) {
    const [engine, questionId] = key.split('||');
    const ok = rs.filter((r) => r.status === 'ok');
    if (!out.has(engine)) out.set(engine, []);
    out.get(engine).push({
      questionId,
      ok: ok.length,
      hits: ok.filter((r) => r.mentioned === true).length,
      usable: ok.length >= opts.minRunsPerCell,
    });
  }
  return out;
}

/**
 * INCLUSION — of the questions in this group, in how many does the engine name
 * us? Majority rule within a cell: named in more than half its good runs.
 *
 * Reported per engine AND as an equal-weight average of the engines.
 */
function inclusion(rows, opts, filter) {
  const eligible = rows.filter(filter);
  const perEngine = {};
  const rates = [];

  for (const [engine, cells] of engineCells(eligible, opts)) {
    const usable = cells.filter((c) => c.usable);
    const included = usable.filter((c) => c.hits * 2 > c.ok).length;
    const coverage = cells.length ? usable.length / cells.length : 0;
    const rate = usable.length ? (included / usable.length) * 100 : null;
    perEngine[engine] = {
      included,
      usable_cells: usable.length,
      total_cells: cells.length,
      coverage,
      rate,
      validity: coverage >= opts.engineCoverageFloor ? VALIDITY.VALID
        : coverage >= 0.5 ? VALIDITY.PARTIAL : VALIDITY.INVALID,
    };
    if (rate != null) rates.push(rate);
  }

  return {
    version: METRICS_VERSION,
    engines: perEngine,
    // Equal weight per engine — see the header.
    rate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    method: 'macro-average across engines (equal weight)',
  };
}

/** Named in ANY one run of a cell. A looser read, useful as an early signal. */
function inclusionAny(rows, opts, filter) {
  const eligible = rows.filter(filter);
  const rates = [];
  for (const [, cells] of engineCells(eligible, opts)) {
    const usable = cells.filter((c) => c.usable);
    if (usable.length) rates.push((usable.filter((c) => c.hits > 0).length / usable.length) * 100);
  }
  return {
    version: METRICS_VERSION,
    rate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
  };
}

/**
 * BRANDED RECALL — a regression detector.
 *
 * A scattered miss is noise. A whole branded question at zero on a whole engine
 * means that engine stopped knowing you, which is a different and much worse
 * event. Blackouts are reported separately for that reason.
 */
function brandedRecall(rows, opts) {
  const ok = rows.filter((r) => r.branded && r.status === 'ok');
  const hits = ok.filter((r) => r.mentioned === true).length;
  const rate = ok.length ? (hits / ok.length) * 100 : null;

  const blackouts = [];
  for (const [key, rs] of groupBy(ok, (r) => `${r.question_id}||${r.engine}`)) {
    if (rs.length && rs.every((r) => r.mentioned !== true)) {
      const [question_id, engine] = key.split('||');
      blackouts.push({ question_id, engine });
    }
  }
  const floor = opts.brandedRecallFloor != null ? opts.brandedRecallFloor : 93;
  return {
    version: METRICS_VERSION,
    hits, answers: ok.length, rate, blackouts,
    breached: (rate != null && rate < floor) || blackouts.length > 0,
  };
}

/**
 * ENTITY CONFUSION — of the sources that purported to be about you, how many
 * were about somebody else?
 *
 * Denominator is deliberately "pages about us" (ours + third-party-about-us +
 * wrong-company), not all citations. Rival and generic pages would otherwise
 * dilute the rate until a real problem looked small.
 */
function entityConfusion(rows) {
  const ok = rows.filter((r) => r.status === 'ok');
  const wrong = sum(ok, (r) => r.sources_wrong_company);
  const ours = sum(ok, (r) => r.sources_ours);
  const aboutUs = sum(ok, (r) => r.sources_about_us);
  const denom = wrong + ours + aboutUs;
  return {
    version: METRICS_VERSION,
    wrong, ours, about_us: aboutUs, denominator: denom,
    rate: denom ? (wrong / denom) * 100 : null,
  };
}

/**
 * INDEPENDENT CORROBORATION — of the answers that named you, how many cited at
 * least one independent source ABOUT you?
 *
 * The metric that separates "we are visible" from "we are believed". Inclusion
 * can rise on your own pages alone; this cannot.
 *
 * See CORROBORATING_CLASSES in config.js for why roundups are excluded — the
 * single most expensive measurement mistake in this tool's history.
 */
function corroboration(rows, filter) {
  const mentions = rows.filter((r) => filter(r) && r.status === 'ok' && r.mentioned === true);
  const backed = mentions.filter((r) => (Number(r.sources_corroborating) || 0) > 0);
  return {
    version: METRICS_VERSION,
    corroborated: backed.length,
    mentions: mentions.length,
    rate: mentions.length ? (backed.length / mentions.length) * 100 : null,
    counts: [...CORROBORATING_CLASSES],
  };
}

/** Share of ALL citations that are independent. Context for the above. */
function independentShare(rows) {
  const ok = rows.filter((r) => r.status === 'ok');
  const total = sum(ok, (r) => r.sources_total);
  const indep = sum(ok, (r) => r.sources_independent);
  const unclassified = sum(ok, (r) => r.sources_unclassified);
  return {
    version: METRICS_VERSION,
    independent: indep, total, unclassified,
    rate: total ? (indep / total) * 100 : null,
    // Say it out loud: unknowns are excluded, so this is an optimistic bound.
    note: total
      ? `${unclassified} of ${total} citations are unclassified and excluded`
      : null,
  };
}

/**
 * CYCLE INTEGRITY — is this cycle safe to compare with the last one?
 *
 * Reported rather than hidden. A cycle that ran thin is still worth recording;
 * it is just not worth quoting, and the difference has to be visible.
 */
function integrity(rows, opts, filter) {
  const engines = {};
  for (const [engine, cells] of engineCells(rows.filter(filter), opts)) {
    const usable = cells.filter((c) => c.usable).length;
    const coverage = cells.length ? usable / cells.length : 0;
    engines[engine] = {
      usable_cells: usable,
      total_cells: cells.length,
      coverage,
      validity: coverage >= opts.engineCoverageFloor ? VALIDITY.VALID
        : coverage >= 0.5 ? VALIDITY.PARTIAL : VALIDITY.INVALID,
    };
  }
  const vals = Object.values(engines).map((e) => e.validity);
  const overall = vals.includes(VALIDITY.INVALID) ? VALIDITY.INVALID
    : vals.includes(VALIDITY.PARTIAL) ? VALIDITY.PARTIAL
      : VALIDITY.VALID;
  return { version: METRICS_VERSION, engines, overall, floor: opts.engineCoverageFloor };
}

/** Accuracy guardrail — what engines said about you that is untrue. */
/**
 * "Did the judge flag anything?" — deliberately paranoid about what counts.
 *
 * The judge contract says a string, and the word "none" when there is nothing.
 * But this predicate decides a headline denominator, and the ways it can go
 * wrong are all silent: an empty ARRAY is truthy in JavaScript, so a judge
 * adapter returning `[]` would flag every clean answer in the cycle and report
 * a 100% breach rate with no error anywhere. Capitalisation, whitespace and
 * "n/a" fail the same way in the opposite direction.
 *
 * Cheap to be explicit here, and the failure it prevents is the kind that gets
 * presented to somebody before anyone notices.
 */
const flaggedBreach = (v) => {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== 'none' && s !== 'n/a';
};

function accuracy(rows) {
  const flagged = rows.filter((r) => flaggedBreach(r.wrong_facts));
  const serious = flagged.filter(
    (r) => String(r.wrong_facts_severity).trim().toLowerCase() === 'serious',
  );
  return {
    version: METRICS_VERSION,
    flagged: flagged.length,
    serious: serious.length,
    breached: serious.length > 0,
  };
}

/**
 * Everything, computed once.
 *
 * @param {Array}  rows  joined run + score rows for one cycle
 * @param {object} cfg   validated config
 */
function computeAll(rows, cfg) {
  const opts = cfg.limits;
  const nonBranded = (r) => !r.branded;
  const coreGroup = cfg.coreGroup || 'B';
  const inCore = (r) => r.question_group === coreGroup;

  return {
    version: METRICS_VERSION,
    core_inclusion: inclusion(rows, opts, inCore),
    core_inclusion_any: inclusionAny(rows, opts, inCore),
    total_non_branded: inclusion(rows, opts, nonBranded),
    branded_recall: brandedRecall(rows, opts),
    entity_confusion: entityConfusion(rows),
    corroboration: corroboration(rows, nonBranded),
    independent_share: independentShare(rows),
    accuracy: accuracy(rows),
    integrity: integrity(rows, opts, nonBranded),
  };
}

module.exports = {
  METRICS_VERSION, VALIDITY, computeAll,
  inclusion, inclusionAny, brandedRecall, entityConfusion,
  corroboration, independentShare, integrity, accuracy, flaggedBreach,
};
