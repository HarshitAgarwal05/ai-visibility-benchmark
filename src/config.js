/**
 * CONFIGURATION CONTRACT — everything brand-specific lives here, nowhere else.
 *
 * The rule this file enforces: no source file under src/ may contain a brand
 * name, a product fact, a competitor, a URL or a question. If it does, the tool
 * only works for one company, and every user after the first is forking rather
 * than configuring.
 *
 * Load a config with `load()`, and it is validated before anything runs. A
 * benchmark that starts with a half-valid config produces numbers nobody can
 * trust and burns real API credit doing it, so the validation is strict and
 * fails loudly at startup rather than politely at row 400.
 */

'use strict';

const path = require('path');

/** How well the site answers a question. Drives action routing. */
const COVERAGE = { STRONG: 'STRONG', PARTIAL: 'PARTIAL', NONE: 'NONE' };

/** Is the capability actually shipped? COMING_SOON never raises a content task. */
const PRODUCT_STATUS = {
  LIVE: 'LIVE',
  COMING_SOON: 'COMING_SOON',
  ADJACENT: 'ADJACENT',
  NOT_TARGET: 'NOT_TARGET',
};

/** What kind of question it is. A RECOMMENDATION cannot be won from your own site. */
const INTENT = {
  CAPABILITY: 'CAPABILITY',
  HOW_TO: 'HOW_TO',
  RECOMMENDATION: 'RECOMMENDATION',
  COMPARISON: 'COMPARISON',
};

/**
 * How a cited domain relates to you. This taxonomy is the single most valuable
 * derived field in the whole benchmark: it is what turns "46 sources" into
 * "46 sources, none of them about us".
 */
const SOURCE_CLASS = {
  OURS: 'OURS',
  OURS_ABANDONED: 'OURS - ABANDONED',
  OURS_BROKEN: 'OURS - BROKEN',
  THIRD_PARTY_EMPTY: 'THIRD PARTY - EMPTY',
  THEIRS_INDEPENDENT: 'THEIRS - INDEPENDENT',
  THEIRS_REVIEWS: 'THEIRS - REAL REVIEWS',
  THEIRS_COMPARISON: 'THEIRS - COMPARISON',
  WRONG_COMPANY: 'WRONG COMPANY',
  ROUNDUP_TARGET: 'ROUNDUP TARGET',
  COMPETITOR: 'COMPETITOR',
  COMPETITOR_OWNED: 'COMPETITOR-OWNED',
  COMMUNITY: 'COMMUNITY',
  PRESS: 'PRESS',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

/**
 * Classes that count as an INDEPENDENT source — not yours, not a rival talking
 * about themselves.
 */
const INDEPENDENT_CLASSES = new Set([
  SOURCE_CLASS.THEIRS_INDEPENDENT,
  SOURCE_CLASS.THEIRS_REVIEWS,
  SOURCE_CLASS.THEIRS_COMPARISON,
  SOURCE_CLASS.ROUNDUP_TARGET,
  SOURCE_CLASS.COMMUNITY,
  SOURCE_CLASS.PRESS,
]);

/**
 * Classes that CORROBORATE you — someone other than you saying something about
 * you specifically.
 *
 * ⚠️ ROUNDUP_TARGET is deliberately NOT here, and the omission is the point.
 * A roundup is a "best X" listicle you want to be ON. It is a target precisely
 * because it does not mention you yet. Counting it as corroboration inverts the
 * meaning: the metric then rises fastest where you have the least outside
 * support. This was a real defect in the system this tool grew out of — it
 * reported 52.9% corroboration for months when the true figure was 0%, because
 * every "corroborated" answer was carried by listicles that never named the
 * brand. If a roundup does add you, reclassify that host to THEIRS_COMPARISON
 * and it starts corroborating from the next cycle. That reclassification is the
 * win, and it is what the metric should move on.
 */
const CORROBORATING_CLASSES = new Set([
  SOURCE_CLASS.THEIRS_INDEPENDENT,
  SOURCE_CLASS.THEIRS_REVIEWS,
  SOURCE_CLASS.THEIRS_COMPARISON,
  SOURCE_CLASS.PRESS,
]);

/** Sources that purport to be ABOUT you — the denominator for entity confusion. */
const ABOUT_US_CLASSES = new Set([
  SOURCE_CLASS.THEIRS_INDEPENDENT,
  SOURCE_CLASS.THEIRS_REVIEWS,
  SOURCE_CLASS.THEIRS_COMPARISON,
  SOURCE_CLASS.THIRD_PARTY_EMPTY,
]);

const OURS_CLASSES = new Set([
  SOURCE_CLASS.OURS,
  SOURCE_CLASS.OURS_ABANDONED,
  SOURCE_CLASS.OURS_BROKEN,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const oneOf = (v, set) => Object.values(set).includes(v);

function validate(cfg) {
  const e = [];
  const at = (p, m) => e.push(`${p}: ${m}`);

  if (!cfg || typeof cfg !== 'object') return ['config must export an object'];

  // ── brand ──
  if (!cfg.brand || typeof cfg.brand !== 'object') at('brand', 'missing');
  else {
    if (!isStr(cfg.brand.name)) at('brand.name', 'required');
    if (!Array.isArray(cfg.brand.aliases)) at('brand.aliases', 'must be an array (may be empty)');
    if (!isStr(cfg.brand.domain)) at('brand.domain', 'required, e.g. "example.com"');
  }

  // ── questions ──
  if (!Array.isArray(cfg.questions) || !cfg.questions.length) {
    at('questions', 'at least one question required');
  } else {
    const seen = new Set();
    cfg.questions.forEach((q, i) => {
      const p = `questions[${i}]`;
      if (!isStr(q.id)) at(p, 'id required');
      else if (seen.has(q.id)) at(p, `duplicate id "${q.id}"`);
      else seen.add(q.id);
      if (!isStr(q.text)) at(p, 'text required');
      if (!isStr(q.group)) at(p, 'group required (e.g. "A" branded, "B" category)');
      if (q.product_status && !oneOf(q.product_status, PRODUCT_STATUS)) {
        at(p, `product_status must be one of ${Object.keys(PRODUCT_STATUS).join('|')}`);
      }
      if (q.intent_type && !oneOf(q.intent_type, INTENT)) {
        at(p, `intent_type must be one of ${Object.keys(INTENT).join('|')}`);
      }
      if (q.site_coverage && !oneOf(q.site_coverage, COVERAGE)) {
        at(p, `site_coverage must be one of ${Object.keys(COVERAGE).join('|')}`);
      }
      if (q.canonical_pages && !Array.isArray(q.canonical_pages)) {
        at(p, 'canonical_pages must be an array');
      }
    });
  }

  // A branded group is what makes recall measurable. Without it there is no way
  // to tell "the engine does not know us" from "the engine knows us but does not
  // associate us with this category" — a distinction the whole tool turns on.
  if (Array.isArray(cfg.questions) && !cfg.questions.some((q) => q.branded)) {
    at('questions', 'at least one question must be marked branded:true '
      + '(a question that names your brand) — branded recall is the control');
  }

  // ── engines ──
  if (!Array.isArray(cfg.engines) || !cfg.engines.length) {
    at('engines', 'at least one engine required');
  }

  // ── domain rules ──
  if (cfg.domainRules && !Array.isArray(cfg.domainRules)) {
    at('domainRules', 'must be an array');
  } else if (Array.isArray(cfg.domainRules)) {
    cfg.domainRules.forEach((r, i) => {
      if (!isStr(r.host)) at(`domainRules[${i}]`, 'host required');
      if (!oneOf(r.cls, SOURCE_CLASS)) {
        at(`domainRules[${i}]`, `cls must be one of the SOURCE_CLASS values`);
      }
    });
  }

  // ── facts ──
  if (cfg.facts) {
    if (!isStr(cfg.facts.version)) {
      at('facts.version', 'required — bump it whenever you edit a fact, or a '
        + 're-score cannot tell which answers were judged against which sheet');
    }
    if (!Array.isArray(cfg.facts.entries)) at('facts.entries', 'must be an array');
  }

  // ── storage ──
  const store = (cfg.storage && cfg.storage.driver) || 'file';
  if (!['file', 'bigquery'].includes(store)) {
    at('storage.driver', 'must be "file" or "bigquery"');
  }

  return e;
}

/** Fill in everything optional so the rest of the code never guards for undefined. */
function withDefaults(cfg) {
  const q = (cfg.questions || []).map((x) => ({
    product_status: PRODUCT_STATUS.LIVE,
    intent_type: INTENT.CAPABILITY,
    canonical_pages: [],
    site_coverage: COVERAGE.PARTIAL,
    branded: false,
    ...x,
  }));
  return {
    ...cfg,
    questions: q,
    engines: cfg.engines || ['openai'],
    repeats: cfg.repeats || 3,
    domainRules: cfg.domainRules || [],
    watchlist: cfg.watchlist || [],
    facts: cfg.facts || { version: 'none', entries: [] },
    storage: { driver: 'file', dir: './data', ...(cfg.storage || {}) },
    limits: {
      capUsd: 25,
      warnUsd: 18,
      minRunsPerCell: 2,
      engineCoverageFloor: 0.95,
      ...(cfg.limits || {}),
    },
    targets: cfg.targets || {},
  };
}

/**
 * Load and validate. Throws with every problem at once rather than the first —
 * fixing a config one error per run is miserable.
 */
function load(configPath) {
  const abs = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const raw = require(abs);
  const cfg = typeof raw === 'function' ? raw() : raw;
  const errors = validate(cfg);
  if (errors.length) {
    throw new Error(`Invalid config (${abs}):\n  - ${errors.join('\n  - ')}`);
  }
  return withDefaults(cfg);
}

module.exports = {
  load,
  validate,
  withDefaults,
  COVERAGE,
  PRODUCT_STATUS,
  INTENT,
  SOURCE_CLASS,
  INDEPENDENT_CLASSES,
  CORROBORATING_CLASSES,
  ABOUT_US_CLASSES,
  OURS_CLASSES,
};
