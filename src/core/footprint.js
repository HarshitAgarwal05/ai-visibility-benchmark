/**
 * PRESENCE AUDIT — what exists about you, whether or not an engine cited it.
 *
 * Different job from the citation data. That records what an engine happened to
 * reach; this checks a FIXED list of places you care about — your own key
 * pages, the directories you are listed in, the ones you are not — and asks
 * whether what is there is correct and current.
 *
 * ── The mistake this file exists to avoid ──────────────────────────────────
 *
 * The obvious implementation sorts responses into "fine" and "missing":
 *
 *     404            -> missing, raise it
 *     anything else  -> fine
 *
 * That treats a 403 as healthy. It is not healthy — it is UNKNOWN, and those
 * are opposites. A blocked fetch tells you nothing at all about whether the
 * profile is filled, empty or gone.
 *
 * In the system this came from, that single conflation silenced an entire
 * workstream: ten of twenty-one watched properties returned 403, all were filed
 * as "manual", and the cycle reported ZERO third-party actions — while the
 * metric those properties feed was falling. The sites that block bots are the
 * established directories, which is exactly why answer engines cite them. The
 * blind spot pointed straight at the highest-value targets.
 *
 * So BLOCKED is its own state, distinct from MANUAL:
 *
 *   MANUAL   you CHOSE not to read it (terms you respect)
 *   BLOCKED  you were REFUSED — state unknown, and a human must look
 *
 * ── One more, learned the same way ─────────────────────────────────────────
 *
 * 410 Gone is not a bot block. It is the server stating the resource was
 * deliberately removed — the same class of fact as a 404, and worth knowing
 * urgently. Lumping it in with 403 hid a deleted profile for four cycles.
 *
 * ── And the mirror image of the first one ──────────────────────────────────
 *
 * BLOCKED fixed a real bug and introduced another. Once a refusal could no
 * longer read as a clean bill of health, eleven rows asked for the same manual
 * check every single cycle — because the hosts kept answering 403, so the
 * checker kept re-deriving BLOCKED, however many times a person had actually
 * gone and looked. Doing the work had no way to make the ask stop.
 *
 * A nagging checklist is not a harmless cost. It trains people to ignore the
 * list, which eventually costs you the real items on it too.
 *
 * So HUMAN_VERIFIED records what a person saw, and three details make it safe:
 *
 *   it EXPIRES         a browser check is a snapshot, not a standing fact.
 *                      Without a TTL one afternoon of checking silences these
 *                      rows forever, which is the original bug again.
 *   it FAILS CLOSED    a missing, undated, malformed or future date is not a
 *                      verification. A row must never go quiet on the strength
 *                      of a note nobody can date.
 *   it RANKS BELOW     404/410/unreachable outrank it. If the host now says the
 *                      page is gone, that is news, and news beats a note from
 *                      weeks ago.
 *
 * And HUMAN_VERIFIED does not mean "no action" — it means the action is now the
 * REAL one. Verified-and-empty is still work, worded as content work, because
 * somebody already confirmed we hold the profile. Verified-and-correct is the
 * only state that drops out, and some rows genuinely reach it: a registry that
 * mirrors a government filing is correct, unchangeable by you, and closed.
 */

'use strict';

const https = require('https');
const http = require('http');

const TIMEOUT_MS = 20000;
const PAUSE_MS = 700;          // polite spacing — these are other people's sites

const UA = 'AIVisibilityBenchmark/1.0 (+https://github.com/; presence self-audit)';
// Some edges reset bare non-browser requests on deeper paths. Retrying once
// with a browser string records a fact about the filter rather than a false
// "unreachable" about the page.
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const STATE = {
  OK: 'OK',                        // reachable, looks populated
  EMPTY: 'EMPTY',                  // reachable and bare, or gone (404/410)
  BLOCKED: 'BLOCKED',              // refused — state genuinely unknown
  MANUAL: 'MANUAL',                // we chose not to read it
  HUMAN_VERIFIED: 'HUMAN_VERIFIED',// a person opened it and told us
  UNREACHABLE: 'UNREACHABLE',
};

/**
 * How long a human verification counts for before the row goes back to asking.
 *
 * A person opening a page in a browser is the ONLY way to learn anything about
 * a host that refuses you — but what they saw is a snapshot. Directories merge
 * listings, review counts move, profiles get claimed. 120 days is roughly eight
 * fortnightly cycles: long enough that doing the work visibly pays off, short
 * enough that nothing hides behind a note from last year.
 */
const VERIFY_TTL_DAYS = 120;

/**
 * Is this item's human verification still inside its shelf life?
 *
 * Fails CLOSED — a missing, undated, malformed or future date returns false and
 * the row falls back to BLOCKED and asks for a fresh look. The one way this
 * feature could do damage is by silencing a row on the strength of a note
 * nobody can date, so every uncertain case resolves towards "needs checking".
 *
 * @param {{verified?: {on?: string, says?: string}}} item  one watchlist entry
 * @param {Date} [now]
 */
function freshVerification(item, now = new Date()) {
  const v = item && item.verified;
  if (!v || !v.on || !v.says) return false;
  const t = Date.parse(`${v.on}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  const ageDays = (now.getTime() - t) / 86400000;
  if (ageDays < -1) return false;          // a future date is a typo, not a check
  return ageDays <= VERIFY_TTL_DAYS;
}

function fetch(url, { redirects = 0, ua = UA } = {}) {
  return new Promise((resolve) => {
    let mod;
    let opts;
    try {
      const u = new URL(url);
      mod = u.protocol === 'http:' ? http : https;
      opts = {
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': ua, Accept: 'text/html,*/*;q=0.8', Connection: 'close' },
      };
    } catch (_) { return resolve({ status: 0, error: 'bad url' }); }

    const req = mod.request(opts, (res) => {
      // A 301 to a live page is not a dead profile.
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(fetch(new URL(res.headers.location, url).toString(),
          { redirects: redirects + 1, ua }));
      }
      let body = '';
      res.on('data', (c) => { if (body.length < 300000) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

/** Cheap, honest heuristic for "live but bare". */
const looksEmpty = (html) => /\b0\.0\s*(?:stars?|out of)|\bnot reviewed\b|\b0 reviews?\b|no reviews? yet/i
  .test(String(html || ''));

const title = (html) => {
  const m = String(html || '').match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
};

/**
 * Check every watched property once.
 *
 * @param {object} cfg
 * @param {object} store
 * @param {object} opts  { runId, runDate }
 */
async function run(cfg, store, { runId, runDate }) {
  const list = cfg.watchlist || [];
  if (!list.length) return { runId, checked: 0, rows: [] };

  const { createClassifier } = require('./classify');
  const classifier = createClassifier(cfg);
  const rows = [];

  console.log(`\n  checking ${list.length} watched properties`);

  for (const item of list) {
    let res = await fetch(item.url);
    if (res.status === 0) res = await fetch(item.url, { ua: UA_BROWSER });

    let state; let says; let action;

    if (res.status === 0) {
      state = STATE.UNREACHABLE;
      says = `unreachable (${res.error})`;
      action = 'Retry next cycle; if it persists, check by hand';
    } else if (res.status === 404 || res.status === 410) {
      // 410 belongs here, not with 403 — see the header.
      state = STATE.EMPTY;
      says = res.status === 410
        ? 'GONE — deliberately removed (HTTP 410)'
        : 'NO PROFILE — not found';
      action = item.expect ? `Expected: ${item.expect}` : 'Create or claim this profile';
    } else if (res.status >= 400 && freshVerification(item)) {
      // A person opened this in a browser and told us what is there. That beats
      // "we were refused, so the state is unknown" — which is all this could
      // ever say otherwise, no matter how many times somebody looked.
      //
      // Note where this sits: BELOW the 404/410/unreachable branches, on
      // purpose. See the header.
      state = STATE.HUMAN_VERIFIED;
      says = `${item.verified.says} (checked by hand`
        + `${item.verified.by ? ` by ${item.verified.by}` : ''} on ${item.verified.on}; `
        + `host still answers HTTP ${res.status} to us)`;
      action = item.verified.action
        || 'Nothing outstanding — verified correct, and not ours to change';
    } else if (res.status >= 400) {
      state = STATE.BLOCKED;
      says = `HTTP ${res.status} — refused to an automated fetch; state UNKNOWN`
        + (item.expect ? `. Last known by hand: ${item.expect}` : '');
      action = 'MANUAL CHECK REQUIRED — a block is not evidence the profile is healthy';
    } else if (item.manualOnly) {
      state = STATE.MANUAL;
      says = item.expect || 'Live. Content behind terms we do not scrape';
      action = 'Verify by hand';
    } else {
      const empty = looksEmpty(res.body);
      state = empty ? STATE.EMPTY : STATE.OK;
      says = title(res.body) || 'live, no title';
      action = empty
        ? 'Live but empty — an empty profile reads as unproven, which is worse than absent'
        : (item.expect ? `Verify: ${item.expect}` : 'Verify details are current');
    }

    rows.push({
      run_id: runId,
      run_date: runDate,
      url: item.url,
      name: item.name || classifier.hostOf(item.url),
      source_class: classifier.classify(item.url).cls,
      state,
      what_it_says: says,
      action_needed: action,
      // Who looked, when, and whether anything was left to do. `null` here is
      // meaningful: a person established there is nothing outstanding.
      verified_on: state === STATE.HUMAN_VERIFIED ? item.verified.on : null,
      verified_by: state === STATE.HUMAN_VERIFIED ? (item.verified.by || null) : null,
      verified_action: state === STATE.HUMAN_VERIFIED ? (item.verified.action || null) : null,
      http_status: res.status || null,
      checked_at: new Date().toISOString(),
    });

    console.log(`    ${String(res.status || '—').padStart(3)}  ${String(item.name || '').padEnd(24)} ${state}`);
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  await store.replaceCycle('footprint', runId, rows);

  const counts = rows.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
  console.log(`  ${rows.length} checked — ${JSON.stringify(counts)}`);
  return { runId, checked: rows.length, rows, counts };
}

/**
 * Actions from the audit.
 *
 * Three states raise something, and the wording differs because the work
 * differs. BLOCKED deliberately does NOT claim the profile is empty — saying so
 * on the strength of a 403 would be inventing a finding.
 */
function buildActions(rows, cfg) {
  const out = [];
  for (const r of rows) {
    const ours = String(r.source_class || '').startsWith('OURS');

    if (r.state === STATE.HUMAN_VERIFIED) {
      // Someone looked. Two outcomes, and the difference is the whole feature:
      //
      //   nothing outstanding  the row goes quiet. Some profiles genuinely
      //                        reach this — a registry mirroring a government
      //                        filing is correct and not yours to change.
      //   something outstanding the row raises the REAL action instead of
      //                        another request to go and look.
      if (!r.verified_action) continue;
      out.push({
        action_id: `PROFILE-${r.name}`,
        action_type: 'THIRD_PARTY_AUTHORITY',
        action: `${r.name}: ${r.verified_action}`,
        why: `Checked by hand${r.verified_by ? ` by ${r.verified_by}` : ''} on ${r.verified_on}: `
          + `${r.what_it_says}. This host refuses automated requests, so the state could not be `
          + 'read any other way — and because somebody has now looked, this is no longer a '
          + 'request to go and check. It is the work itself.',
        evidence: r.url,
        expected_effect: 'The verified gap closed, and the next check confirms it.',
        owner: 'Marketing',
        // A live, claimed, empty profile is a worse signal than no profile at
        // all: it reads as unproven rather than unknown.
        priority: looksEmpty(r.what_it_says) ? 'URGENT' : 'HIGH',
      });
      continue;
    }

    if (r.state === STATE.BLOCKED) {
      if (ours) {
        // Your own host refusing a bot is a different and more interesting
        // problem: whatever rejects this may also reject the crawlers that feed
        // answer engines, and a page an engine cannot fetch cannot be cited.
        out.push({
          action_id: `OURBLOCK-${r.name}`,
          action_type: 'RETRIEVAL',
          action: `${r.name} refuses automated requests (HTTP ${r.http_status}) — confirm AI crawlers are allowed`,
          why: 'Your own edge refused a plain non-browser request. That is a bot filter, not a broken '
            + 'page, so it is probably fine for humans. It matters anyway: a filter that cannot tell '
            + 'your own auditor from a scraper may also be refusing the crawlers that feed answer '
            + 'engines. Verify the allowlist rather than assuming.',
          evidence: r.url,
          expected_effect: 'Named AI crawlers confirmed allowed; page fetchable by a non-browser client.',
          owner: 'Web',
          priority: 'HIGH',
        });
        continue;
      }
      out.push({
        action_id: `PROFILE-${r.name}`,
        action_type: 'THIRD_PARTY_AUTHORITY',
        action: `Verify the ${r.name} profile by hand — refused (HTTP ${r.http_status})`,
        why: `${r.what_it_says}. This site refuses automated requests, so this cycle carries no `
          + 'evidence either way about the profile. That is precisely why a person has to look: '
          + 'treating a block as "fine" is how an entire workstream goes quiet while the metric '
          + 'it feeds is falling.',
        evidence: r.url,
        expected_effect: 'A human-confirmed state recorded, and a real action if it is empty.',
        owner: 'Marketing',
        priority: 'HIGH',
      });
      continue;
    }

    if (r.state !== STATE.EMPTY) continue;

    if (ours) {
      out.push({
        action_id: `OUR404-${r.name}`,
        action_type: 'RETRIEVAL',
        action: `${r.name} is returning ${r.http_status} — fix or redirect`,
        why: `This is your own page and it is not serving. ${r.what_it_says}. A page that 404s `
          + 'cannot be cited, cannot rank, and cannot answer the question it was written for.',
        evidence: r.url,
        expected_effect: 'Page returns 200 next cycle.',
        owner: 'Web',
        priority: 'URGENT',
      });
      continue;
    }

    out.push({
      action_id: `PROFILE-${r.name}`,
      action_type: 'THIRD_PARTY_AUTHORITY',
      action: `${/NO PROFILE|GONE/i.test(r.what_it_says) ? 'Create' : 'Fill'} the ${r.name} profile`,
      why: `${r.what_it_says}. An empty or missing profile is not neutral — when an engine is asked `
        + 'to recommend something it reaches for directories, because a company\'s own site is the '
        + 'weakest possible evidence about itself. A live profile showing nothing reads as unproven, '
        + 'which is worse than not being listed at all.',
      evidence: r.url,
      expected_effect: 'Appear in directory-sourced answers within 2–3 cycles of real reviews landing.',
      owner: 'Marketing',
      priority: 'HIGH',
    });
  }
  return out;
}

module.exports = { run, buildActions, STATE, looksEmpty, freshVerification, VERIFY_TTL_DAYS };
