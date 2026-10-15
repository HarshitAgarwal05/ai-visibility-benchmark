#!/usr/bin/env node
/**
 * CLI.
 *
 * Steps run independently on purpose. Asking costs money; everything after it
 * is free and reads what was already bought. So scoring, actions and the report
 * can all be re-run against a corrected fact sheet or a corrected rule set
 * without paying for a single answer again. That separation is what makes a
 * measurement mistake survivable rather than permanent.
 *
 *   aivb --config path            run the whole cycle
 *   aivb --config path --step=run|score|actions|report
 *   aivb --config path --dry-run  plan the calls, spend nothing
 *   aivb --config path --rescore  re-judge answers scored against an older
 *                                 fact sheet, and only those
 */

'use strict';

const path = require('path');
const { load } = require('./config');
const storage = require('./storage');
const runner = require('./core/runner');
const judge = require('./judge');
const actions = require('./core/actions');
const footprint = require('./core/footprint');
const report = require('./core/report');
const metricsLib = require('./core/metrics');

/**
 * Accepts both `--key=value` and `--key value`. Supporting only the first is a
 * small cruelty: the help text reads `--config <path>`, everyone types it that
 * way, and the flag silently becomes `true` with the path dropped on the floor.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const s = a.slice(2);
    const eq = s.indexOf('=');
    if (eq > 0) { args[s.slice(0, eq)] = s.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[s] = next; i++; } else { args[s] = true; }
  }
  return args;
}

const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.config) {
    console.log(`
  AI Visibility Benchmark

    --config <path>     required — see config/example.config.js
    --step <name>       run | score | footprint | actions | report  (default: all)
    --run-date <date>   YYYY-MM-DD. Defaults to today.
    --run-id <id>       override the cycle id (use for test runs)
    --engines a,b       override config.engines
    --questions a,b     limit to specific question ids
    --repeats <n>       override config.repeats
    --cap-usd <n>       override the spend cap
    --rescore           re-judge only answers scored against an older fact sheet
    --dry-run           plan the calls without making them

  Steps are independent. Only 'run' costs money.
`);
    process.exit(args.config ? 0 : 1);
  }

  const cfg = load(args.config);
  const store = storage.create(cfg);
  await store.init();

  const runDate = args['run-date'] || today();
  const runId = args['run-id'] || `cycle_${runDate.replace(/-/g, '')}`;
  const step = args.step || 'all';
  const wants = (s) => step === 'all' || step === s;

  console.log(`\n  ${cfg.brand.name} — AI visibility`);
  console.log(`  config ${path.basename(args.config)} · storage ${store.name} `
    + `· rules ${cfg.rulesVersion || 'unversioned'} · facts ${cfg.facts.version}`);

  // ── Fact freshness, before anything is spent ───────────────────────────────
  // A stale mutable fact does not go quiet — it manufactures breaches that look
  // exactly like real ones. Cheaper to hear about it now than to spend a cycle
  // discovering it in the report.
  const stale = judge.staleFacts(cfg);
  if (stale.length) {
    console.warn(`\n  !! ${stale.length} fact(s) may be out of date:`);
    for (const f of stale) {
      console.warn(`     ${f.ageDays === Infinity ? 'never checked' : `${f.ageDays}d old`} — `
        + `${f.text.slice(0, 80)}`);
    }
    console.warn('     A frozen mutable fact marks truthful engines as wrong.\n');
  }

  // ── 1. Ask ─────────────────────────────────────────────────────────────────
  if (wants('run')) {
    await runner.run(cfg, store, {
      runId,
      runDate,
      engines: args.engines ? String(args.engines).split(',') : undefined,
      questions: args.questions,
      repeats: args.repeats,
      capUsd: args['cap-usd'] != null ? Number(args['cap-usd']) : undefined,
      dryRun: !!args['dry-run'],
    });
  }

  if (args['dry-run']) {
    console.log('\n  dry run — nothing scored, nothing written.\n');
    return;
  }

  // ── 2. Score ───────────────────────────────────────────────────────────────
  if (wants('score')) {
    const runs = await store.read('runs', { runId });
    const existing = await store.read('scores', { runId });
    const scoredIds = new Map(existing.map((s) => [s.row_id, s]));

    // Default: score what has no score. With --rescore: also re-judge anything
    // scored against a DIFFERENT fact sheet, and nothing else. That is the
    // whole point of stamping facts_version — without it the only choices are
    // re-score everything or nothing.
    const current = cfg.facts.version;
    const todo = runs.filter((r) => {
      const s = scoredIds.get(r.row_id);
      if (!s) return true;
      return args.rescore ? s.facts_version !== current : false;
    });

    if (!todo.length) {
      console.log(`\n  nothing to score — every answer already judged against facts ${current}`);
    } else {
      console.log(`\n  scoring ${todo.length} answers${args.rescore ? ' (re-score: stale sheet)' : ''}`);
      const res = await judge.score(todo, cfg, {
        pricing: cfg.pricing || {},
        capUsd: cfg.limits.judgeCapUsd || 5,
        onProgress: (n, t, spend) => process.stdout.write(`\r     ${n}/${t}  $${spend.toFixed(3)}   `),
      });
      // Replace only what was re-judged; keep the rest.
      const keep = existing.filter((s) => !todo.some((r) => r.row_id === s.row_id));
      await store.replaceCycle('scores', runId, keep.concat(res.scores));
      console.log(`\n     scored ${res.scores.length}, $${res.costUsd.toFixed(3)}`);
    }
  }

  // ── 3. Presence audit ──────────────────────────────────────────────────────
  // Separate from the citation data: this checks a fixed list whether or not an
  // engine happened to reach it. Skipped when no watchlist is configured.
  if (wants('footprint') && (cfg.watchlist || []).length) {
    await footprint.run(cfg, store, { runId, runDate });
  }

  // ── 4. Actions ─────────────────────────────────────────────────────────────
  if (wants('actions')) {
    const runs = await store.read('runs', { runId });
    const scores = await store.read('scores', { runId });
    const rows = report.joinScores(runs, scores);
    const m = metricsLib.computeAll(rows, cfg);
    const fp = await store.read('footprint', { runId });
    const built = actions.build(rows, m, cfg).concat(footprint.buildActions(fp, cfg));

    // Carry the lifecycle forward. An action that stopped firing gets a row of
    // its own rather than vanishing — a disappearance is the most interesting
    // thing that can happen to an action, and it has to be judged, not assumed.
    const allActions = await store.read('actions');
    const earlier = allActions.filter((a) => a.run_date < runDate);
    const prevDate = earlier.length ? earlier.map((a) => a.run_date).sort().pop() : null;
    const previous = prevDate ? earlier.filter((a) => a.run_date === prevDate) : [];

    const list = actions.reconcile(built, previous, cfg).map((a) => ({
      ...a,
      run_id: runId,
      run_date: runDate,
      first_seen: a.first_seen || runDate,
      built_at: new Date().toISOString(),
    }));
    await store.replaceCycle('actions', runId, list);

    const byOwner = {};
    const byType = {};
    for (const a of list) {
      byOwner[a.owner] = (byOwner[a.owner] || 0) + 1;
      byType[a.action_type] = (byType[a.action_type] || 0) + 1;
    }
    console.log(`\n  ── ACTIONS (${list.length}) ─────────────────────────────`);
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(24)} ${v}`);
    }
    console.log(`  ${''.padEnd(24)} ${JSON.stringify(byOwner)}`);

    // Status and debt type, because "38 open" is not a finding on its own.
    const byStatus = {};
    const byBacklog = {};
    for (const a of list) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      // Debt means still firing and still needing work. A row in observed
      // recovery is neither closed nor debt — it is being watched.
      if (a.status !== actions.STATUS.CLOSED && a.status !== actions.STATUS.OBSERVED_RECOVERY) {
        byBacklog[a.backlog_type] = (byBacklog[a.backlog_type] || 0) + 1;
      }
    }
    console.log(`  status                   ${JSON.stringify(byStatus)}`);
    console.log(`  open debt                ${JSON.stringify(byBacklog)}`);
    const observed = list.filter((a) => a.status === actions.STATUS.OBSERVED_RECOVERY).length;
    if (observed) {
      console.log(`  ${observed} stopped firing with no recorded fix — held, not closed`);
    }
    if (byBacklog.AUTHORITY) {
      console.log(`  ${byBacklog.AUTHORITY} of the open items cannot be closed on your own site`);
    }
    // The number worth watching. A pile of content gaps usually means the
    // routing metadata is wrong, not that the writing backlog is real.
    if (!byType.CONTENT_GAP) {
      console.log('  no genuine content gaps — every absence has a specific owner');
    }
  }

  // ── 5. Report ──────────────────────────────────────────────────────────────
  if (wants('report')) {
    const res = await report.build(cfg, store, { runId, runDate });
    if (res.rows && res.rows.length) report.print(res.rows, cfg);
    if (res.cost) require('./core/cost').print(res.cost);
  }

  console.log(`  stored in ${cfg.storage.dir || './data'}\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n  ERROR: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
