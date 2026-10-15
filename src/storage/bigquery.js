/**
 * BigQuery driver — optional.
 *
 * `@google-cloud/bigquery` is an optionalDependency, so the project installs
 * and runs without it. This file only loads when you ask for it.
 *
 * ── Two things about BigQuery that will bite you ────────────────────────────
 *
 * 1. THE STREAMING BUFFER BLOCKS DELETES FOR ~90 MINUTES. Rows written through
 *    the streaming API cannot be UPDATEd or DELETEd until they leave the
 *    buffer, and the attempt fails rather than waiting. A `replaceCycle` built
 *    on DELETE-then-stream therefore appears to work while silently leaving the
 *    old rows in place, so a rebuilt cycle ends up with two of everything and
 *    every count doubles. This driver uses DML INSERT, which is slower per
 *    statement and immediately deletable — the right trade for a job that runs
 *    twice a month.
 *
 * 2. SCHEMAS ARE NOT FREE-FORM. Unlike the file driver, an unknown column is an
 *    error. `ensure()` adds missing columns rather than failing, because the
 *    alternative is a coordinated deploy every time a field is added — and
 *    discovering the mismatch at the END of a paid run is the worst possible
 *    moment.
 */

'use strict';

const TYPES = {
  // Anything not listed is inferred from the first row that has a value.
  run_date: 'DATE',
  branded: 'BOOL',
  mentioned: 'BOOL',
  search_used: 'BOOL',
  is_ours: 'BOOL',
  is_independent: 'BOOL',
  is_wrong_company: 'BOOL',
  breached: 'BOOL',
  cap_hit: 'BOOL',
};

const infer = (name, v) => TYPES[name]
  || (typeof v === 'boolean' ? 'BOOL'
    : typeof v === 'number' ? (Number.isInteger(v) ? 'INT64' : 'FLOAT64')
      : 'STRING');

const lit = (v) => {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
};

function create(spec = {}) {
  let BigQuery;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    ({ BigQuery } = require('@google-cloud/bigquery'));
  } catch (_) {
    throw new Error('storage.driver "bigquery" needs @google-cloud/bigquery — '
      + 'run `npm install @google-cloud/bigquery`');
  }

  const projectId = spec.projectId || process.env.BIGQUERY_PROJECT_ID;
  const datasetId = spec.dataset || 'ai_visibility';
  const location = spec.location || 'US';
  const prefix = spec.tablePrefix || 'aivb_';
  const bq = new BigQuery({ projectId, keyFilename: spec.keyFilename });
  const full = (t) => `\`${projectId}.${datasetId}.${prefix}${t}\``;
  const query = (sql) => bq.query({ query: sql, location }).then(([r]) => r);
  const ensured = new Set();

  async function ensure(table, rows) {
    if (!rows || !rows.length) return;
    const ds = bq.dataset(datasetId);
    const [dsExists] = await ds.exists();
    if (!dsExists) await bq.createDataset(datasetId, { location });

    // Union the keys across rows — the first row may have nulls where a later
    // one carries the only example of a column.
    const cols = new Map();
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (!cols.has(k) || (cols.get(k) === 'STRING' && v != null)) cols.set(k, infer(k, v));
      }
    }

    const tbl = ds.table(`${prefix}${table}`);
    const [exists] = await tbl.exists();
    if (!exists) {
      await ds.createTable(`${prefix}${table}`, {
        schema: { fields: [...cols].map(([name, type]) => ({ name, type })) },
      });
      ensured.add(table);
      return;
    }
    if (ensured.has(table)) return;
    const [meta] = await tbl.getMetadata();
    const have = new Set((meta.schema.fields || []).map((f) => f.name));
    const missing = [...cols].filter(([n]) => !have.has(n));
    for (const [name, type] of missing) {
      await query(`ALTER TABLE ${full(table)} ADD COLUMN IF NOT EXISTS \`${name}\` ${type}`);
    }
    ensured.add(table);
  }

  async function insert(table, rows) {
    if (!rows || !rows.length) return 0;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    // Chunked: BigQuery rejects very large single statements.
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const values = chunk
        .map((r) => `(${cols.map((c) => lit(r[c])).join(',')})`)
        .join(',');
      await query(`INSERT INTO ${full(table)} (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ${values}`);
    }
    return rows.length;
  }

  return {
    name: 'bigquery',

    async init() {
      const [exists] = await bq.dataset(datasetId).exists();
      if (!exists) await bq.createDataset(datasetId, { location });
    },

    async append(table, rows) {
      await ensure(table, rows);
      return insert(table, rows);
    },

    async replaceCycle(table, runId, rows) {
      await ensure(table, rows);
      // DELETE first, and only then insert. See note 1 — this ordering is only
      // safe because writes are DML rather than streamed.
      await query(`DELETE FROM ${full(table)} WHERE run_id = ${lit(runId)}`)
        .catch((e) => {
          if (/not found/i.test(e.message)) return;   // table does not exist yet
          throw e;
        });
      return insert(table, rows);
    },

    async read(table, { runId } = {}) {
      try {
        return await query(`SELECT * FROM ${full(table)}`
          + (runId ? ` WHERE run_id = ${lit(runId)}` : ''));
      } catch (e) {
        if (/not found/i.test(e.message)) return [];
        throw e;
      }
    },

    async distinct(table, column) {
      try {
        const rows = await query(
          `SELECT DISTINCT \`${column}\` AS v FROM ${full(table)} ORDER BY v`,
        );
        return rows.map((r) => (r.v && r.v.value ? r.v.value : r.v)).filter((v) => v != null);
      } catch (e) {
        if (/not found/i.test(e.message)) return [];
        throw e;
      }
    },
  };
}

module.exports = { create };
