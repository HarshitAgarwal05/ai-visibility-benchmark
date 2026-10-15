/**
 * FILE STORAGE — newline-delimited JSON, one file per table.
 *
 * The default driver, chosen so the project runs on a laptop with no cloud
 * account. NDJSON rather than a single JSON array for two reasons that matter
 * during a long run: appending is O(1) and does not rewrite the file, and a
 * crash mid-write costs you the last line instead of the whole table.
 *
 * `replaceCycle` writes to a temp file and renames, because a cycle rebuild
 * that dies halfway would otherwise leave a table with some of the old rows and
 * some of the new — which produces wrong numbers with no error to notice.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function create(spec = {}) {
  const dir = path.resolve(process.cwd(), spec.dir || './data');
  const file = (table) => path.join(dir, `${table}.ndjson`);

  const readAll = (table) => {
    const f = file(table);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l, i) => {
        try { return JSON.parse(l); } catch (_) {
          // One malformed line must not take out the whole table. Skip it and
          // keep the rest — a truncated final line is the normal cost of a
          // crash, and losing 400 good rows to it would be absurd.
          console.warn(`  [storage] ${table}.ndjson line ${i + 1} is not valid JSON — skipped`);
          return null;
        }
      })
      .filter(Boolean);
  };

  return {
    name: 'file',

    async init() {
      fs.mkdirSync(dir, { recursive: true });
    },

    async append(table, rows) {
      if (!rows || !rows.length) return 0;
      fs.mkdirSync(dir, { recursive: true });
      const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.appendFileSync(file(table), payload, 'utf8');
      return rows.length;
    },

    async replaceCycle(table, runId, rows) {
      fs.mkdirSync(dir, { recursive: true });
      const kept = readAll(table).filter((r) => r.run_id !== runId);
      const next = kept.concat(rows || []);
      const tmp = `${file(table)}.tmp`;
      fs.writeFileSync(tmp, next.map((r) => JSON.stringify(r)).join('\n') + (next.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, file(table));   // atomic on the same filesystem
      return (rows || []).length;
    },

    async read(table, { runId } = {}) {
      const all = readAll(table);
      return runId ? all.filter((r) => r.run_id === runId) : all;
    },

    async distinct(table, column) {
      return [...new Set(readAll(table).map((r) => r[column]).filter((v) => v != null))].sort();
    },
  };
}

module.exports = { create };
