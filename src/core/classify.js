/**
 * SOURCE CLASSIFICATION — what a cited URL actually is to you.
 *
 * Every URL an engine cites gets one class. This is the highest-value derived
 * field in the benchmark, because it is what turns "46 sources" into "46
 * sources, none of them about us" — and those are completely different reports.
 *
 * Rules come from config. Nothing brand-specific lives in this file.
 *
 * ── Three lessons baked into the design ─────────────────────────────────────
 *
 * 1. MULTI-TENANT HOSTS NEED A SPLIT RULE. app stores, marketplaces and
 *    directories host you AND your rivals on the same domain. A flat
 *    host → class rule marks every rival listing on that host as being about
 *    you, which lands them in "wrong company" and inflates entity confusion.
 *    In the system this came from, one app-store host alone accounted for 85%
 *    of apparent entity confusion — the true rate was a tenth of the reported
 *    one. `pathContains` + `elseCls` is the fix: yours by path, everyone
 *    else's by the fallback.
 *
 * 2. UNCLASSIFIED IS A REAL ANSWER, AND IT IS NOT NEUTRAL. A wrong class moves
 *    a metric silently; an unknown is visibly excluded. So the default is
 *    UNCLASSIFIED and the report lists what to classify next. But beware the
 *    other direction: unknowns hide things too. Wrong-entity citations sitting
 *    in the unknown pool made entity confusion read 4% when it was closer to
 *    27% — the pool was flattering, not neutral.
 *
 * 3. RULE CHANGES MOVE METRICS WITHOUT ANY REAL-WORLD CHANGE. That is why
 *    `rulesVersion` exists and is stamped on every cycle. Six months later,
 *    "did the number move or did the rules?" has to be answerable from data
 *    rather than memory.
 */

'use strict';

const { SOURCE_CLASS, INDEPENDENT_CLASSES, CORROBORATING_CLASSES,
        ABOUT_US_CLASSES, OURS_CLASSES } = require('../config');

/** Hostname without `www.`, lowercased. Never throws on a malformed URL. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    const m = String(url || '').match(/^(?:https?:\/\/)?([^/?#]+)/i);
    return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
  }
}

function pathOf(url) {
  try { return new URL(String(url)).pathname.toLowerCase(); } catch (_) { return ''; }
}

/**
 * Build a classifier bound to one config.
 *
 * @param {object} cfg  validated config
 */
function createClassifier(cfg) {
  const ownDomain = String((cfg.brand && cfg.brand.domain) || '').replace(/^www\./i, '').toLowerCase();
  const rules = cfg.domainRules || [];
  const wrongPatterns = (cfg.wrongCompanyPatterns || []).map(
    (p) => (p instanceof RegExp ? p : new RegExp(p, 'i')),
  );

  // Longest host first, so `blog.example.com` beats `example.com`.
  const ordered = [...rules].sort((a, b) => String(b.host).length - String(a.host).length);

  function classify(url) {
    const host = hostOf(url);
    const pth = pathOf(url);
    if (!host) return pack(SOURCE_CLASS.UNCLASSIFIED, null, 'unparseable url');

    for (const rule of ordered) {
      const rHost = String(rule.host).replace(/^www\./i, '').toLowerCase();
      const hit = host === rHost || host.endsWith(`.${rHost}`);
      if (!hit) continue;

      // A rule scoped by path only applies on that path. Off-path, `elseCls`
      // decides — this is the multi-tenant split described in the header.
      if (rule.pathContains) {
        const needles = [].concat(rule.pathContains);
        const onPath = needles.some((n) => pth.includes(String(n).toLowerCase()));
        if (onPath) return pack(rule.cls, rule.name, rule.note);
        if (rule.elseCls) {
          return pack(rule.elseCls, rule.name,
            rule.elseCls === SOURCE_CLASS.COMPETITOR
              ? 'Same host, a rival — not us, and not confusion'
              : 'Same host, different subject');
        }
        continue;   // not our path, no fallback — let a later rule try
      }
      return pack(rule.cls, rule.name, rule.note);
    }

    // Our own domain, even without an explicit rule.
    if (ownDomain && (host === ownDomain || host.endsWith(`.${ownDomain}`))) {
      return pack(SOURCE_CLASS.OURS, cfg.brand.name, 'our own site');
    }

    // Names that look like us but are somebody else entirely.
    for (const re of wrongPatterns) {
      if (re.test(host)) {
        return pack(SOURCE_CLASS.WRONG_COMPANY, null, `matched ${re}`);
      }
    }

    return pack(SOURCE_CLASS.UNCLASSIFIED, null,
      'no rule — classify it once and it is permanent');
  }

  function pack(cls, name, note) {
    return {
      cls,
      name: name || null,
      note: note || null,
      ours: OURS_CLASSES.has(cls),
      independent: INDEPENDENT_CLASSES.has(cls),
      corroborating: CORROBORATING_CLASSES.has(cls),
      aboutUs: ABOUT_US_CLASSES.has(cls),
      wrongCompany: cls === SOURCE_CLASS.WRONG_COMPANY,
    };
  }

  /** Per-answer counts the metrics read. */
  function summarise(urls) {
    const out = {
      total: 0, ours: 0, independent: 0, corroborating: 0, aboutUs: 0, wrongCompany: 0,
      byClass: {}, unclassified: [],
    };
    for (const u of urls || []) {
      const k = classify(u);
      out.total++;
      if (k.ours) out.ours++;
      if (k.independent) out.independent++;
      if (k.corroborating) out.corroborating++;
      if (k.aboutUs) out.aboutUs++;
      if (k.wrongCompany) out.wrongCompany++;
      out.byClass[k.cls] = (out.byClass[k.cls] || 0) + 1;
      if (k.cls === SOURCE_CLASS.UNCLASSIFIED) out.unclassified.push(hostOf(u));
    }
    return out;
  }

  return {
    classify,
    summarise,
    hostOf,
    rulesVersion: cfg.rulesVersion || 'unversioned',
    ruleCount: rules.length,
  };
}

module.exports = { createClassifier, hostOf };
