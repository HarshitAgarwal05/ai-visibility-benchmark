/**
 * EXAMPLE CONFIG — a fictional B2B SaaS called Orbital.
 *
 * Everything here is invented. Copy this file, change the brand block, replace
 * the questions with ones a buyer would actually type, and you have a working
 * benchmark.
 *
 * ⚠️ THIS FILE WILL CONTAIN COMMERCIALLY SENSITIVE MATERIAL once you fill it
 * in for a real company — your question set is your commercial strategy
 * written down, and `facts` is a reference sheet of things you can prove.
 * Keep your real config out of version control. `.gitignore` already excludes
 * `config/*.config.js` except this example.
 */

'use strict';

const { SOURCE_CLASS, PRODUCT_STATUS, INTENT, COVERAGE } = require('../src/config');

module.exports = {
  // ── Who you are ────────────────────────────────────────────────────────────
  brand: {
    name: 'Orbital',
    // Every spelling an engine might use. Matching is case-insensitive.
    aliases: ['Orbital HQ', 'OrbitalHQ', 'Orbital Software'],
    domain: 'orbital.example',
  },

  // The group the programme exists to move. Its inclusion rate is the headline.
  coreGroup: 'B',

  // Bump when you change a question, a routing field, or the fact sheet. It is
  // stamped on every cycle so a later shift can be attributed to a rule change
  // rather than to reality.
  rulesVersion: '2026-01-01',

  engines: ['openai', 'perplexity'],
  repeats: 3,

  // ── The questions ──────────────────────────────────────────────────────────
  //
  // Freeze these. A benchmark whose questions drift measures nothing over time.
  // Add new ones as additions; never reword an existing one.
  //
  // Group A is branded — it names you. It is the control: if an engine cannot
  // name you when asked about you directly, no other number in the cycle means
  // anything.
  //
  // Group B is the category you want to own. Everything else is context.
  questions: [
    // ── A: branded control ──
    { id: 'A1', group: 'A', branded: true, text: 'What is Orbital?',
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.CAPABILITY,
      canonical_pages: ['/about'], site_coverage: COVERAGE.STRONG },
    { id: 'A2', group: 'A', branded: true, text: 'Orbital pricing',
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.CAPABILITY,
      canonical_pages: ['/pricing'], site_coverage: COVERAGE.STRONG },
    { id: 'A3', group: 'A', branded: true, text: 'Orbital reviews',
      // No page of yours wins "reviews" — that is third-party by nature, which
      // is exactly what an empty canonical_pages array is saying.
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.RECOMMENDATION,
      canonical_pages: [], site_coverage: COVERAGE.NONE },

    // ── B: the category ──
    { id: 'B1', group: 'B', text: 'project management software for agencies',
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.CAPABILITY,
      canonical_pages: ['/solutions/agencies'], site_coverage: COVERAGE.STRONG },
    { id: 'B2', group: 'B', text: 'how do agencies track billable hours?',
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.HOW_TO,
      canonical_pages: ['/solutions/time-tracking'], site_coverage: COVERAGE.STRONG },
    { id: 'B3', group: 'B', text: 'best project management tool for small teams',
      // RECOMMENDATION → routes to Marketing, never to Content. You cannot win
      // "best" by publishing that you are the best.
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.RECOMMENDATION,
      canonical_pages: ['/solutions/small-teams'], site_coverage: COVERAGE.PARTIAL },
    { id: 'B4', group: 'B', text: 'project management software with time tracking built in',
      product_status: PRODUCT_STATUS.LIVE, intent_type: INTENT.CAPABILITY,
      canonical_pages: ['/features/time-tracking'], site_coverage: COVERAGE.STRONG },
    { id: 'B5', group: 'B', text: 'software to manage client retainers',
      // Announced but not shipped. COMING_SOON raises NO action — a task that
      // contradicts your own site costs you credibility on the whole list.
      product_status: PRODUCT_STATUS.COMING_SOON, intent_type: INTENT.CAPABILITY,
      canonical_pages: [], site_coverage: COVERAGE.NONE },

    // ── C: adjacent audience ──
    { id: 'C1', group: 'C', text: 'project tracking for freelance designers',
      product_status: PRODUCT_STATUS.ADJACENT, intent_type: INTENT.CAPABILITY,
      canonical_pages: ['/solutions'], site_coverage: COVERAGE.PARTIAL },
    { id: 'C2', group: 'C', text: 'best tool for managing freelance clients',
      product_status: PRODUCT_STATUS.ADJACENT, intent_type: INTENT.RECOMMENDATION,
      canonical_pages: ['/solutions'], site_coverage: COVERAGE.PARTIAL },
  ],

  // ── How to read a cited domain ─────────────────────────────────────────────
  //
  // Start empty and let the unclassified report tell you what to add. Classify
  // by citation volume, not alphabetically: the top of that list is where your
  // measurement error actually lives.
  domainRules: [
    { host: 'orbital.example', cls: SOURCE_CLASS.OURS, name: 'Our site' },

    // Rivals.
    { host: 'competitor-one.example', cls: SOURCE_CLASS.COMPETITOR, name: 'Competitor One' },
    { host: 'competitor-two.example', cls: SOURCE_CLASS.COMPETITOR, name: 'Competitor Two' },

    // MULTI-TENANT HOST — the pattern that matters most.
    //
    // A directory hosts your listing AND every rival's on the same domain.
    // Without the split, every rival listing counts as a page "about you" that
    // got you wrong, and entity confusion inflates for no reason. `pathContains`
    // claims your path; `elseCls` correctly calls the rest what they are.
    { host: 'directory.example', pathContains: ['/orbital'],
      cls: SOURCE_CLASS.THIRD_PARTY_EMPTY, elseCls: SOURCE_CLASS.COMPETITOR,
      name: 'Software directory',
      note: 'Listing exists but has no reviews — fill it, do not remove it.' },

    // Listicles you want to be ON. Targets, not evidence — see
    // CORROBORATING_CLASSES in src/config.js for why this distinction matters.
    { host: 'roundup-blog.example', cls: SOURCE_CLASS.ROUNDUP_TARGET, name: 'Roundup Blog' },

    // Genuinely independent writing about you. This is what corroboration counts.
    { host: 'trade-press.example', cls: SOURCE_CLASS.PRESS, name: 'Trade Press' },

    { host: 'reddit.com', cls: SOURCE_CLASS.COMMUNITY, name: 'Reddit' },
  ],

  // Names that look like yours but are somebody else. These become
  // WRONG COMPANY and drive the entity-confusion metric. Common for short or
  // generic brand names that collide with tickers, sports teams or acronyms.
  wrongCompanyPatterns: [
    /orbital-?(?:sciences|energy|atk)/i,
  ],

  // ── Presence audit ─────────────────────────────────────────────────────────
  // Checked every cycle whether or not an engine cited them. An empty profile
  // is worse than no profile: it reads as unproven.
  //
  // The established directories — the ones answer engines actually cite — tend
  // to refuse non-browser requests. A 403 is recorded as BLOCKED, never as
  // healthy, which means a person has to look. Record what they saw in a
  // `verified` block and the row stops asking:
  //
  //   verified: { on, by, says, action }
  //
  // `action: null` means they established there is nothing left to do. The
  // check expires after 120 days, and an undated or malformed one does not
  // count at all — a row must never go quiet on a note nobody can date.
  watchlist: [
    { url: 'https://orbital.example', name: 'Website' },
    { url: 'https://orbital.example/pricing', name: 'Pricing page' },
    { url: 'https://directory.example/orbital', name: 'Software directory',
      expect: 'Listing live, zero reviews — needs real ones',
      verified: { on: '2026-01-05', by: 'Sam',
        says: 'Profile live, company name correct, we hold edit access. 0 reviews.',
        action: 'Get the first reviews published — two customers have agreed, '
              + 'neither has posted' } },
    // Correct, and not ours to change. Some rows genuinely finish: this is a
    // registry mirror of a government filing with no edit path, so the honest
    // outcome is no action at all rather than a perpetual "check this".
    { url: 'https://registry.example/company/orbital', name: 'Companies registry',
      verified: { on: '2026-01-05', by: 'Sam',
        says: 'Record live, name correct. Mirrors the statutory filing.',
        action: null } },
    // Deliberately NOT verified: nobody has reported back on this one, and
    // "nobody checked" must not look the same as "checked and fine".
    { url: 'https://reviews.example/orbital', name: 'Review site' },
  ],

  // ── Facts the judge checks answers against ─────────────────────────────────
  //
  // ⚠️ A STALE FACT DOES NOT GO QUIET — IT MANUFACTURES BREACHES. The judge
  // marks an engine wrong for saying something that became true after you last
  // edited this. Tag anything that changes on its own as `mutable` with the
  // date you checked it, and re-verify those on cycle day.
  //
  // This is not hypothetical. A single line saying "no mobile app exists",
  // thirteen days out of date, produced 52 false "serious" findings in one
  // cycle — roughly forty of which were engines telling the truth.
  facts: {
    version: '2026-01-01',
    entries: [
      { text: 'Orbital is a project management tool for agencies and small teams.',
        mutable: false },
      { text: 'Pricing is per-seat, billed monthly or annually.', mutable: false },
      { text: 'Client retainers are announced but NOT yet shipped. An answer saying '
            + 'the feature is available is WRONG.',
        mutable: true, checked: '2026-01-01' },
      { text: 'Orbital has no published star rating on any review site.',
        mutable: true, checked: '2026-01-01' },
    ],
    // Anything the judge must never accept, whatever an engine says.
    never: [
      'a specific customer count',
      'a claim to be "the first" or "the best"',
      'any integration not listed on the integrations page',
    ],
  },

  // ── Guardrails ─────────────────────────────────────────────────────────────
  limits: {
    capUsd: 25,               // hard stop for a whole cycle
    warnUsd: 18,
    minRunsPerCell: 2,        // a cell needs two good runs to be read at all
    engineCoverageFloor: 0.95,
    brandedRecallFloor: 93,
  },

  targets: {
    core_inclusion: 30,
    branded_recall: 100,
    entity_confusion: 20,     // lower is better
    corroboration: 35,
    // Cost is reported as three figures: what you paid to ASK, what you paid
    // to READ, and the sum. Budget against the total — the judge is part of
    // the benchmark, not optional analytics, and leaving it out understated
    // real cycles by a factor of four.
    cost_total_benchmark: 10,
  },

  // ── Where rows land ────────────────────────────────────────────────────────
  // `file` needs nothing. For a warehouse, set driver: 'bigquery' and supply
  // projectId/dataset — or pass your own object implementing the five-method
  // contract in src/storage/index.js.
  storage: { driver: 'file', dir: './data' },
};
