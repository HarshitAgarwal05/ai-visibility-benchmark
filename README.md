# AI Visibility Benchmark

**When someone asks an AI for what you sell — without naming you — does it recommend you?**

That question is now a distribution channel, and most brands cannot answer it. This is a
longitudinal benchmark that measures it: a frozen question set, asked repeatedly across
ChatGPT, Gemini and Perplexity, scored the same way every cycle so the numbers can be
compared over months rather than admired once.

```bash
npm install
cp config/example.config.js config/my.config.js   # edit the brand block
node src/index.js --config config/my.config.js
```

No database required. Results land as newline-delimited JSON you can open in a text
editor. Point it at a warehouse when you outgrow that.

---

## Why this is harder than it looks

Anyone can ask ChatGPT about their brand and screenshot the answer. Turning that into a
number you can act on takes more care than it appears, and most of this codebase is the
scar tissue from getting it wrong.

Six decisions, each of which produced a wrong number before it produced a right one:

### 1. Macro-average across engines. Never pool.

If one engine answers twice as often as another, pooling lets that engine's behaviour set
your headline. Equal weight per engine means the number describes the *category*, not your
sampling.

### 2. A cell needs two good runs

Generative answers vary between identical calls. One observation is an anecdote. Cells
below the threshold are excluded and the cycle's coverage is reported, so nobody
accidentally compares a thin cycle against a full one.

### 3. Branded recall is a control, not a score

If an engine cannot name you when the question *contains your name*, nothing else in the
cycle means anything. It belongs with the guardrails, sitting near 100%, and a single
branded question at zero across a whole engine is flagged separately — that is a different
and much worse event than a scattered miss.

### 4. A roundup is a target, not a witness

The costliest bug this tool exists to prevent.

"Best project management software" listicles get cited constantly. It is tempting to count
them as independent corroboration. They are the opposite: a listicle is a *pitch target*
precisely because it does not mention you yet. Counting them inverts the metric — it rises
fastest where you have the *least* outside support.

A real programme reported **52.9% corroboration for months. The true figure was 0%.** Every
"corroborated" answer was carried by listicles that never named the brand.

When a roundup does add you, reclassify that host and it starts corroborating from the next
cycle. *That reclassification is the win.*

### 5. Multi-tenant hosts need a split rule

App stores, marketplaces and directories host your listing **and every rival's** on one
domain. A flat `host → class` rule marks every rival listing as a page about you that got
you wrong, and entity confusion inflates for no reason.

In one programme a single app-store host accounted for **85% of apparent entity confusion.**
The true rate was a tenth of the reported one.

```js
{ host: 'directory.example', pathContains: ['/orbital'],
  cls: THIRD_PARTY_EMPTY, elseCls: COMPETITOR }
```

### 6. A blocked page is not a healthy page

The presence audit checks a fixed list of places you care about — your pages, the
directories you are listed in, the ones you are not. The obvious implementation sorts
responses into "404 = missing" and "everything else = fine", which quietly files a **403 as
healthy.**

It is not healthy. It is *unknown*, and those are opposites.

Ten of twenty-one watched properties in one programme returned 403. All were filed as
benign, the cycle reported **zero** third-party actions, and the metric those properties
feed kept falling. The sites that block bots are the established directories — which is
exactly why answer engines cite them. The blind spot pointed straight at the highest-value
targets.

`BLOCKED` is therefore its own state, distinct from `MANUAL` (you *chose* not to read it),
and it raises an action worded as *"a human must look"* rather than inventing a finding.
`410 Gone` is grouped with `404`, not with `403` — it means deliberately deleted, which is
worth knowing urgently.

**And then the mirror image of the same bug.** Once a refusal could no longer read as
healthy, eleven rows asked for the same manual check *every cycle* — the host kept answering
403, so the checker kept re-deriving `BLOCKED`, however many times somebody had actually
gone and looked. Doing the work had no way to make the ask stop, and a nagging checklist is
not a harmless cost: it trains people to ignore the list, which eventually costs you the
real items on it.

So a human check is recordable (`verified: { on, by, says, action }`), and three details
keep it honest: it **expires** (a browser check is a snapshot, not a standing fact), it
**fails closed** (undated, malformed or future-dated counts as no check at all), and it
**ranks below** 404/410 — if the host now says the page is gone, that outranks a note from
weeks ago. `action: null` is how a row legitimately finishes; a registry mirroring a
statutory filing is correct, unchangeable by you, and done.

### 7. A stale fact does not go quiet — it manufactures breaches

The judge scores answers against a reference sheet you maintain. When a fact in that sheet
goes out of date, the judge marks engines **wrong for telling the truth.**

One line saying "no mobile app exists", thirteen days stale, produced **52 false "serious"
findings in a single cycle** — about forty of which were engines being accurate. Facts that
move on their own are tagged `mutable` with a checked-on date, and the tool warns when they
age.

---

## What it measures

| Metric | Question it answers |
|---|---|
| **Core inclusion** | Of the questions in your category, in how many does the engine name you? |
| Inclusion (any) | Named in *any* run — a looser early signal |
| **Branded recall** | Control. Can it name you when asked about you directly? |
| **Entity confusion** | Of sources claiming to be about you, how many were about someone else? |
| **Independent corroboration** | When you're named, does anyone *other than you* back it up? |
| Independent share | What fraction of all citations are neither yours nor a rival's? |
| **Accuracy breaches** | What did an engine state about you that is untrue? |
| Presence audit | Of the profiles you care about, which are empty, gone, or unreadable? |
| **Cycle integrity** | Is this cycle safe to compare with the last one? |
| Cost | What did it cost to *ask*, what to *read*, and what in total? |

Every metric carries its denominator. A percentage without one is a rumour.

---

## The part worth stealing: action routing

Most tools stop at "you didn't appear". That is not actionable, and the obvious next step is
wrong:

```js
if (weDidNotAppear) assignTo(contentTeam)    // ← produces phantom work
```

In one cycle that line produced **33 writing tasks**. Someone opened the live site and
checked all 33 by hand. The real writing backlog was **zero**:

| | Count | What it actually was |
|---|---|---|
| "best / most accurate X" | 19 | Needs third-party authority — unwinnable from your own site |
| Page already existed | 12 | Retrieval or quotability |
| Feature not shipped | 1 | Should raise nothing at all |
| Factual error | 1 | A different kind of problem |

So this tool asks four questions before blaming anyone:

```
absent from every run
   │
   ├─ not shipped / not a target  ──► nothing at all
   ├─ "best X" / "X vs Y"         ──► third-party authority   (Marketing)
   ├─ no page exists              ──► content gap             (Content)  ← the only writing
   ├─ page exists, never cited    ──► retrieval               (Web)
   └─ page cited, brand unnamed   ──► selection               (Content, LOW)
```

**The last two carry the whole idea:**

- **Retrieval** — your page exists and was never fetched. *Nobody read it.* Rewriting text
  no engine retrieves changes nothing. Evidence: a direct, quotable answer shipped ten days
  before a cycle; that cycle still returned zero, with zero of our pages cited.
- **Selection** — your page *was* cited and you still weren't named. Reachable but not
  quotable. The one place a small copy change earns its keep.

Routing is a pure function so this is [asserted in tests](test/routing.test.js) rather than
discovered in production — which is exactly why the original one-liner survived so long.

### Closing them honestly is a separate problem

**A condition that stops firing is not a condition that was fixed.** With three runs per
question, one lucky mention clears an action. In one cycle all **seven** "resolutions"
carried no recorded fix of any kind, and every one was marked Closed — so the completion
rate rose on nothing but run-to-run variance. A benchmark that reports its own noise as
progress is worse than none, because people act on it.

```
OPEN → ASSIGNED → SHIPPED → AWAITING VALIDATION
     → OBSERVED RECOVERY / VERIFIED → CLOSED
```

A resolution with a recorded fix closes immediately — that is the one case where the
intervention can be *credited* rather than the number merely having moved. One without has
to earn it: `OBSERVED RECOVERY`, and it must hold through a second consecutive cycle.
Firing again in between resets it to open. Nothing infers the fix; a person records it or
it stays null, because if nobody will claim the fix the tool must not claim it for them.

**And "open for four cycles" is not one kind of debt.** The useful question is not *why has
this been open so long* but *has anything actually been shipped against it*. Asked that way,
38 items stopped being 38 failures:

| | Count | What it is |
|---|---|---|
| `EXECUTION` | 29 | Nothing done. Real backlog. |
| `AUTHORITY` | 8 | Retrieval debt where the page is already strong — written, findable, still not fetched. The team cannot close this on the site, and filing it as web debt blames them for it. |
| `VALIDATION` | 1 | A fix shipped, waiting on cycles. Not debt — the measurement working. |

---

## Configuration

Everything brand-specific lives in one file. No source file under `src/` contains a brand
name, product fact, competitor or question.

```js
module.exports = {
  brand: { name: 'Orbital', aliases: ['OrbitalHQ'], domain: 'orbital.example' },
  coreGroup: 'B',
  engines: ['openai', 'perplexity'],
  repeats: 3,

  questions: [
    { id: 'A1', group: 'A', branded: true, text: 'What is Orbital?' },
    { id: 'B3', group: 'B', text: 'best project management tool for small teams',
      intent_type: 'RECOMMENDATION',          // → Marketing, never Content
      canonical_pages: ['/solutions/small-teams'],
      site_coverage: 'PARTIAL' },
    { id: 'B5', group: 'B', text: 'software to manage client retainers',
      product_status: 'COMING_SOON' },        // → raises nothing
  ],

  domainRules: [ /* host → class */ ],
  facts: { version: '2026-01-01', entries: [ /* what the judge checks against */ ] },
  storage: { driver: 'file', dir: './data' },
};
```

See [`config/example.config.js`](config/example.config.js) — it is a complete, commented,
working example.

> **Freeze your questions.** A benchmark whose questions drift measures nothing over time.
> Add new ones as additions; never reword an existing one.

---

## Storage

`file` by default — NDJSON, one file per table, no account needed. Append is O(1) and a
crash costs you the last line rather than the table.

Bring your own by implementing five methods:

```js
init() · append(table, rows) · replaceCycle(table, runId, rows)
read(table, { runId }) · distinct(table, column)
```

Pass the object as `storage.driver`. A BigQuery adapter ships as an optional dependency.

---

## Cost

Roughly **$5–10 per cycle** for 70 questions × 3 engines × 3 repeats, dominated by
per-search fees rather than tokens when engines are allowed to browse.

Reported as three figures, never one: what you paid to **ask**, what you paid to **read**,
and the total. Every one of those is a lesson.

### One total cannot be audited

A cycle cost is four or five unrelated things added together. Collapsed into one number, any
of them can be wrong by a factor of two and the total still looks plausible — so nobody
checks it.

A doubled search fee survived four days for exactly that reason. **The per-call search rate
depends on the tool you send, not the model**, and providers ship more than one tool billing
on opposite principles:

| | Per 1,000 calls | Search-result tokens |
|---|---|---|
| `web_search` | $10 | **billed** at the model's input rate |
| `web_search_preview` | $25 | free |

A hardcoded rate sitting next to a request body that names a tool is two facts that must
agree and nothing forcing them to. They drifted: the preview fee was charged while the
modern tool was sent, so every search was paid for twice — the higher fee *plus* the result
tokens only the modern tool bills. A cycle reported **$8.70 against a true $6.48**. Nothing
was overspent; it was mis-recorded, which is worse, because the budget conversation that
follows is about a number nobody can reproduce.

So the rate is *derived* from the tool constant, and the request body uses that same
constant. Itemise the bill and the wrong line is obvious in a second.

### The judge is part of the benchmark

Counting only what you pay the engines is tempting — scoring feels like analytics overhead
sitting outside the measurement. It is not outside: no metric on the card exists without it.

Leaving it out understated three cycles by **more than the engine bill itself** — $1.41
reported against a true $5.47, because the judge was a frontier model at $4.06 a cycle. The
engine figure was accurate and the headline was wrong fourfold.

But merged into one opaque number they hide each other. Asking and reading are different
questions with different fixes — a cheaper judge and a narrower question set are unrelated
levers. So the judge is *in* the total and it is its *own* line.

### Do not overwrite what you published

When a pricing bug is fixed, the instinct is to re-derive history so the chart is "right".
That destroys the ability to explain the chart. `reported_at_time` sits beside the reconciled
total and is never recomputed — because "what the dashboard said then" and "what it really
cost" are different questions, and a reader who remembers the old figure deserves a better
answer than silence. Add the audit column *before* the correction; afterwards, one cycle's
original figure has to be written back from memory.

### Two guards on the way out

- **A hard spend cap per cycle**, checked between calls.
- **An unknown model is billed at the highest known rate**, not a default. Pricing a model
  too *low* means the cap never fires and the first warning is a dead cycle. Too high just
  stops the run early — loud, and recoverable. Relatedly, `$0.00` and "unpriced" look
  identical in a total and mean opposite things, so the report says which it is.

---

## Status

Extracted from a production system that has run continuously since August 2026. The
measurement decisions above are load-bearing: each one changed a reported number by enough
to change a decision.

MIT licensed. Contributions welcome — particularly additional engine adapters.
