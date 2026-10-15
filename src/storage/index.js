/**
 * STORAGE — a benchmark is a time series, so where rows land is a real decision.
 *
 * The contract below is deliberately tiny. Everything the pipeline needs is
 * append, replace-a-cycle, and query-a-cycle. No joins, no migrations, no SQL
 * in the callers. That is what lets the default be a JSON directory you can
 * read in a text editor, while someone with a warehouse points the same
 * pipeline at BigQuery by changing one line of config.
 *
 * WHY the default is files: a benchmark nobody can run is a benchmark nobody
 * checks. `npm install && npm start` has to work on a laptop with no cloud
 * account, or the first thing a new user meets is a credentials error.
 *
 * ── Writing your own driver ──────────────────────────────────────────────────
 *
 * Implement these five methods and pass it as `storage.driver`:
 *
 *   init()                        prepare tables/dirs — called once at startup
 *   append(table, rows)           add rows, never replacing
 *   replaceCycle(table, runId, rows)
 *                                 delete every row for runId, then insert.
 *                                 MUST be atomic enough that a crash cannot
 *                                 leave the cycle half-deleted — a partly
 *                                 rebuilt cycle reports wrong numbers silently.
 *   read(table, { runId })        rows for one cycle, or all if runId omitted
 *   distinct(table, column)       used for cycle lists and classification sweeps
 *
 * Rows are plain objects. Dates are ISO strings. There is no schema migration
 * step by design: a driver that cannot store an unexpected column should ignore
 * it rather than throw, so adding a field never needs a coordinated deploy.
 */

'use strict';

const TABLES = {
  RUNS: 'runs',              // one row per question × engine × repeat
  CITATIONS: 'citations',    // every cited URL, classified
  SCORES: 'scores',          // judge output, joined to runs by row_id
  SITES: 'sites',            // cited domains, aggregated per cycle
  FOOTPRINT: 'footprint',    // presence audit of a fixed watchlist
  COMPETITORS: 'competitors',
  ACTIONS: 'actions',
  SUMMARY: 'summary',        // one row per metric per cycle
  RUN_LOG: 'run_log',        // operational: cost, duration, failures
};

function create(cfg) {
  const spec = cfg.storage || { driver: 'file' };

  // An object with the methods on it IS a driver. This is the extension point:
  // point `storage.driver` at your own module and nothing else changes.
  if (spec.driver && typeof spec.driver === 'object') {
    const missing = ['init', 'append', 'replaceCycle', 'read', 'distinct']
      .filter((m) => typeof spec.driver[m] !== 'function');
    if (missing.length) {
      throw new Error(`custom storage driver is missing: ${missing.join(', ')}`);
    }
    return spec.driver;
  }

  switch (spec.driver) {
    case 'bigquery':
      // eslint-disable-next-line global-require
      return require('./bigquery').create(spec);
    case 'file':
    case undefined:
      // eslint-disable-next-line global-require
      return require('./file').create(spec);
    default:
      throw new Error(`unknown storage driver "${spec.driver}" — use "file", "bigquery", `
        + 'or pass an object implementing the driver contract');
  }
}

module.exports = { create, TABLES };
