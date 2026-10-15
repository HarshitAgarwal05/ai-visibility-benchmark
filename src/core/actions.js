/**
 * ACTION ROUTING — deciding what an absence actually MEANS.
 *
 * This is the part most worth stealing from this project.
 *
 * The obvious implementation, and the one almost everybody writes first, is:
 *
 *     if (weDidNotAppear) assignTo(contentTeam)
 *
 * It is wrong, and expensively so. In the programme this came from, that line
 * produced 33 writing tasks in one cycle. Someone then opened the live site and
 * checked all 33 by hand. The real writing backlog was ZERO:
 *
 *   19  were "best / most accurate X" questions, which no page of your own can
 *       ever win — a site calling itself the best is the weakest evidence there
 *       is, and engines discount it accordingly
 *   12  already had a live page that answered the question
 *    1  was a feature that had not shipped, so the task contradicted the site
 *    1  was a factual error, which is a different kind of problem entirely
 *
 * Writing pages for any of those would have been wasted work, and the same
 * waste would have recurred every cycle. Worse, one task asked for content that
 * the organisation's own published policy forbade.
 *
 * So the ladder below asks four questions before it blames anyone, and the last
 * two carry the distinction the whole thing turns on:
 *
 *   RETRIEVAL — your page exists and was never cited. Nobody read it. Rewriting
 *               text no engine fetches changes nothing; this is indexing,
 *               ranking and authority. The evidence for this being real: a
 *               direct, quotable answer shipped ten days before a cycle, and
 *               that cycle still returned zero, with zero of our pages cited.
 *
 *   SELECTION — your page WAS cited and you still were not named. It is
 *               reachable but not quotable. This is the one case where a small
 *               copy change earns its keep — usually leading the sentence with
 *               the brand so the extracted passage stands on its own.
 */

'use strict';

const { PRODUCT_STATUS, INTENT, COVERAGE } = require('../config');

const ACTION_TYPE = {
  THIRD_PARTY_AUTHORITY: 'THIRD_PARTY_AUTHORITY',
  CONTENT_GAP: 'CONTENT_GAP',
  RETRIEVAL: 'RETRIEVAL',
  SELECTION: 'SELECTION',
  ACCURACY: 'ACCURACY',
};

const OWNER = {
  MARKETING: 'Marketing',
  CONTENT: 'Content',
  WEB: 'Web',
  ENGINEERING: 'Engineering',
};

const PRIORITY = { URGENT: 'URGENT', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

/**
 * LIFECYCLE — and the state that stops a benchmark flattering itself.
 *
 *   OPEN → ASSIGNED → SHIPPED → AWAITING VALIDATION
 *        → OBSERVED RECOVERY / VERIFIED → CLOSED
 *
 * OBSERVED RECOVERY is the one that matters, and it exists because of a
 * specific embarrassment. A condition that stops firing is not a condition that
 * was fixed. With three runs per question, one lucky mention clears an action —
 * and in the programme this came from, all seven "resolutions" in a cycle had
 * no recorded fix behind them whatsoever. Every one was marked Closed, and the
 * completion rate went up on nothing but ordinary engine variance. A benchmark
 * that reports its own noise as progress is worse than no benchmark, because
 * people act on it.
 *
 * So: a resolution with a recorded fix closes immediately — that is the one
 * case where you can say the intervention worked rather than merely that the
 * number moved. A resolution without one has to earn it. It enters OBSERVED
 * RECOVERY and must hold through a second consecutive cycle. Firing again in
 * between resets it to OPEN, which is the honest outcome.
 */
const STATUS = {
  OPEN: 'OPEN',
  ASSIGNED: 'ASSIGNED',
  SHIPPED: 'SHIPPED',
  AWAITING_VALIDATION: 'AWAITING VALIDATION',
  OBSERVED_RECOVERY: 'OBSERVED RECOVERY',
  VERIFIED: 'VERIFIED',
  CLOSED: 'CLOSED',
};

/**
 * WHAT KIND OF DEBT is an old action?
 *
 * "Why has this been open four cycles?" is the wrong question. The useful one
 * is "has anything actually been SHIPPED against it?" — and once you ask that,
 * a single pile of neglect turns out to be three unrelated situations:
 *
 *   EXECUTION   nothing has been done. This is real backlog.
 *   VALIDATION  a fix shipped and we are waiting on cycles to judge it. Not
 *               debt at all — it is the measurement working as designed.
 *   AUTHORITY   a RETRIEVAL action whose canonical page coverage is already
 *               STRONG. The page is written, findable, and still not fetched.
 *               The team cannot close this on the site, so counting it as web
 *               debt blames people for something outside their reach.
 *
 * Without the split, 38 items read as 38 failures. Twenty-nine were. Eight were
 * unwinnable where they had been filed, and one was a success in progress.
 */
const BACKLOG = {
  EXECUTION: 'EXECUTION',
  VALIDATION: 'VALIDATION',
  AUTHORITY: 'AUTHORITY',
};

/** Absence actions are keyed ABSENT-<QUESTIONID>; nothing else carries one. */
function questionIdOf(actionId) {
  const m = /^ABSENT-(.+)$/.exec(String(actionId || ''));
  return m ? m[1] : null;
}

/**
 * @param {string}  actionType
 * @param {*}       fix  a recorded fix, or falsy
 * @param {object}  q    the question this action came from, if any
 */
function backlogType(actionType, fix, q) {
  if (fix) return BACKLOG.VALIDATION;
  if (actionType === ACTION_TYPE.RETRIEVAL && q && q.site_coverage === COVERAGE.STRONG) {
    return BACKLOG.AUTHORITY;
  }
  return BACKLOG.EXECUTION;
}

/**
 * Route one absence.
 *
 * Pure and exported so the split can be asserted in tests without a cycle, a
 * network call or a cent of spend. The one-line version it replaces was wrong
 * for a year because nothing could check it.
 *
 * @param {object} q    the question, with its routing metadata
 * @param {object} obs  { runs, sourcesOurs } observed this cycle
 * @param {object} cfg  validated config
 * @returns {object|null} null means HOLD — raise nothing at all
 */
function routeAbsence(q, obs, cfg) {
  const pages = q.canonical_pages || [];
  const isCore = q.group === (cfg.coreGroup || 'B');
  const weight = isCore ? 'This is the category you are trying to own, so it counts double. ' : '';

  // 1. Not shipped, or not a target. Silence is correct.
  //    Asking someone to write about an unshipped feature is worse than doing
  //    nothing: the task contradicts your own site, and whoever picks it up
  //    loses trust in every other task on the list.
  if (q.product_status === PRODUCT_STATUS.COMING_SOON
      || q.product_status === PRODUCT_STATUS.NOT_TARGET) {
    return null;
  }

  // 2. A recommendation question. Unwinnable from your own site, by nature.
  if (q.intent_type === INTENT.RECOMMENDATION || q.intent_type === INTENT.COMPARISON) {
    return {
      type: ACTION_TYPE.THIRD_PARTY_AUTHORITY,
      title: `Build third-party authority for ${q.id} — "${q.text}"`,
      owner: OWNER.MARKETING,
      priority: isCore ? PRIORITY.HIGH : PRIORITY.MEDIUM,
      evidence: pages.length ? `Your pages: ${pages.join(', ')}` : 'No page of yours can win this',
      why: `Absent from all ${obs.runs} runs. This question asks for a RECOMMENDATION, and no page `
        + 'of yours can answer it credibly — a site that calls itself the best is the weakest '
        + 'evidence there is. What moves it is other people: directory listings with real reviews, '
        + `comparison articles that include you, editorial coverage. ${weight}`
        + 'Writing more of your own copy has no path to this answer.',
      effect: 'Appear once independent sources naming you exist for this category.',
    };
  }

  // 3. Nothing written. The only genuine writing job.
  if (!pages.length || q.site_coverage === COVERAGE.NONE) {
    return {
      type: ACTION_TYPE.CONTENT_GAP,
      title: `Write the missing answer for ${q.id} — "${q.text}"`,
      owner: OWNER.CONTENT,
      priority: isCore ? PRIORITY.URGENT : PRIORITY.MEDIUM,
      evidence: 'No canonical page covers this question',
      why: `Absent from all ${obs.runs} runs, and you have no page that answers this. ${weight}`
        + 'This is a genuine content gap — the only kind that is.',
      effect: 'Appear in at least 1 of 3 runs within 2–4 cycles of a page shipping.',
    };
  }

  // 4. Page exists, never cited → nobody read it.
  if (!obs.sourcesOurs) {
    return {
      type: ACTION_TYPE.RETRIEVAL,
      title: `Fix retrieval for ${q.id} — "${q.text}"`,
      owner: OWNER.WEB,
      priority: isCore ? PRIORITY.URGENT : PRIORITY.MEDIUM,
      evidence: `Page exists: ${pages.join(', ')}`,
      why: `Absent from all ${obs.runs} runs, and not one cited source was yours — the page was `
        + `never fetched. The answer is already written; nobody read it. ${weight}`
        + 'This is indexing, ranking and authority, not copy. Rewriting a page no engine '
        + 'retrieves changes nothing.',
      effect: 'Your page appears among the cited sources for this phrase.',
    };
  }

  // 5. Page cited, brand not named → reachable but not quotable.
  return {
    type: ACTION_TYPE.SELECTION,
    title: `Make the answer quotable for ${q.id} — "${q.text}"`,
    owner: OWNER.CONTENT,
    priority: PRIORITY.LOW,
    evidence: `Cited but brand not named: ${pages.join(', ')}`,
    why: `Absent from all ${obs.runs} runs, but your own pages WERE cited ${obs.sourcesOurs} time(s). `
      + 'The engine reached you and still did not name you, so the page is findable but the '
      + `sentence it lifted does not carry the brand. ${weight}`
      + 'This is the one case where a small copy change earns its keep: lead the answer with '
      + 'your brand name so the extracted sentence stands on its own. Do not write a new page.',
    effect: 'Brand named in at least 1 of 3 runs within 1–2 cycles.',
  };
}

/**
 * Build the action list for a cycle.
 *
 * @param {Array}  rows     joined run + score rows
 * @param {object} metrics  output of metrics.computeAll
 * @param {object} cfg      validated config
 */
function build(rows, metrics, cfg) {
  const actions = [];
  const byId = new Map((cfg.questions || []).map((q) => [q.id, q]));

  // ── absences ──
  const tally = new Map();
  for (const r of rows) {
    if (r.status !== 'ok' || r.branded) continue;
    if (!tally.has(r.question_id)) {
      tally.set(r.question_id, { runs: 0, hits: 0, sourcesOurs: 0 });
    }
    const t = tally.get(r.question_id);
    t.runs++;
    if (r.mentioned) t.hits++;
    t.sourcesOurs += Number(r.sources_ours) || 0;
  }

  for (const [qid, obs] of tally) {
    if (obs.runs < cfg.limits.minRunsPerCell || obs.hits > 0) continue;
    const q = byId.get(qid);
    if (!q) continue;
    const route = routeAbsence(q, obs, cfg);
    if (!route) continue;                       // HOLD
    actions.push({
      action_id: `ABSENT-${qid}`,
      action_type: route.type,
      action: route.title,
      why: route.why,
      evidence: route.evidence,
      expected_effect: route.effect,
      owner: route.owner,
      priority: route.priority,
    });
  }

  // ── accuracy ──
  // Typed separately and owned by engineering on purpose. A breach is almost
  // never a page that needs prose, and counting it as writing work is exactly
  // what the routing above exists to stop. Triage comes first: a stale fact in
  // your own reference sheet manufactures breaches indistinguishable from real
  // ones. That has cost a full cycle before — 52 "serious" findings of which
  // roughly 40 were one reference line thirteen days out of date.
  if (metrics.accuracy.serious > 0) {
    actions.push({
      action_id: 'ACCURACY',
      action_type: ACTION_TYPE.ACCURACY,
      action: `Correct ${metrics.accuracy.serious} serious factual error(s) appearing in AI answers`,
      why: 'An engine stated something false about you to a prospective buyer. These compound, '
        + 'because engines cite each other. TRIAGE FIRST: check each finding against the live '
        + 'source before assigning it — a stale entry in your own fact sheet produces breaches '
        + 'that look identical to real ones. Only a confirmed finding belongs to a team.',
      evidence: `${metrics.accuracy.serious} serious of ${metrics.accuracy.flagged} flagged`,
      expected_effect: 'Zero serious findings next cycle, or each survivor traced to a real source.',
      owner: OWNER.ENGINEERING,
      priority: PRIORITY.URGENT,
    });
  }

  // ── branded regression ──
  if (metrics.branded_recall.breached) {
    const bl = metrics.branded_recall.blackouts;
    actions.push({
      action_id: 'BRANDED-RECALL',
      action_type: ACTION_TYPE.RETRIEVAL,
      action: `Branded recall breached — ${(metrics.branded_recall.rate || 0).toFixed(1)}%`,
      why: 'An engine could not name you even when the question contained your name. That is the '
        + 'floor everything else stands on: category visibility is meaningless if the brand '
        + 'itself is not resolvable.'
        + (bl.length ? ` Blackouts: ${bl.map((b) => `${b.question_id}/${b.engine}`).join(', ')}.` : ''),
      evidence: `${metrics.branded_recall.hits} of ${metrics.branded_recall.answers} branded answers`,
      expected_effect: 'Branded recall back above the floor with no blackouts.',
      owner: OWNER.MARKETING,
      priority: PRIORITY.URGENT,
    });
  }

  return actions;
}

/**
 * Carry the lifecycle across cycles.
 *
 * Takes what this cycle built and what the previous cycle stored, and returns
 * the rows to persist — including rows for actions that did NOT fire this time,
 * because an action disappearing is the most interesting thing that can happen
 * to it and dropping the row throws that away.
 *
 * `fix_shipped` is the field everything hinges on: free text, set by whoever
 * did the work. Nothing can infer it — which is deliberate. Closing an action
 * requires a person to claim a fix, and if nobody will, the benchmark should
 * not claim one on their behalf.
 *
 * @param {Array}  built     actions built from this cycle
 * @param {Array}  previous  action rows from the previous cycle
 * @param {object} cfg
 */
function reconcile(built, previous = [], cfg = {}) {
  const byId = new Map(previous.map((a) => [a.action_id, a]));
  const questions = new Map((cfg.questions || []).map((q) => [q.id, q]));
  const firing = new Set(built.map((a) => a.action_id));
  const rows = [];

  for (const a of built) {
    const before = byId.get(a.action_id);
    const fix = before ? before.fix_shipped || null : null;
    const q = questions.get(questionIdOf(a.action_id));

    // An action that fires again after an observed recovery is NOT recovered.
    // Reset it rather than carrying the optimistic state forward.
    const carried = before && before.status && before.status !== STATUS.OBSERVED_RECOVERY
      && before.status !== STATUS.CLOSED
      ? before.status
      : STATUS.OPEN;

    rows.push({
      ...a,
      status: carried,
      backlog_type: backlogType(a.action_type, fix, q),
      fix_shipped: fix,
      first_seen: (before && before.first_seen) || null,
      cycles_open: before ? (Number(before.cycles_open) || 0) + 1 : 1,
    });
  }

  for (const before of previous) {
    if (firing.has(before.action_id)) continue;
    if (String(before.status || '') === STATUS.CLOSED) continue;

    const fix = before.fix_shipped || null;
    const heldOneCycle = String(before.status || '') === STATUS.OBSERVED_RECOVERY;
    const status = fix || heldOneCycle ? STATUS.CLOSED : STATUS.OBSERVED_RECOVERY;

    rows.push({
      ...before,
      status,
      backlog_type: fix ? BACKLOG.VALIDATION : before.backlog_type || BACKLOG.EXECUTION,
      why: fix
        ? 'Resolved — the condition that raised this is no longer present, and a fix was '
          + 'recorded against it. This is the one case where the intervention can be credited.'
        : heldOneCycle
          ? 'Closed — absent for two consecutive cycles. No fix was recorded, so the cause is '
            + 'unknown, but it has now outlasted ordinary run-to-run variance.'
          : 'ABSENT THIS CYCLE, BUT NOT CLOSED. Nothing was recorded as shipped against this, so '
            + 'one clean cycle is not evidence: with repeated runs per question a single mention '
            + 'clears the condition. It must hold through the next cycle to count as resolved.',
      expected_effect: fix || heldOneCycle
        ? 'Stays closed. If it fires again, the fix regressed.'
        : 'Stays absent through the next cycle, at which point it closes.',
      cycles_open: Number(before.cycles_open) || 1,
    });
  }

  return rows;
}

module.exports = {
  build,
  reconcile,
  routeAbsence,
  backlogType,
  questionIdOf,
  ACTION_TYPE,
  OWNER,
  PRIORITY,
  STATUS,
  BACKLOG,
};
