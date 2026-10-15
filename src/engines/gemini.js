/**
 * Gemini adapter, with Google Search grounding.
 *
 * ── Two things here cost a real programme a cycle each ──────────────────────
 *
 * 1. GROUNDED CITATIONS ARE HIDDEN BEHIND REDIRECTS. Gemini returns its sources
 *    as `vertexaisearch.cloud.google.com/grounding-api-redirect/<opaque>` — the
 *    real domain is inside an opaque token and is NOT in the URL. Classify
 *    those as-is and every grounded citation lands in one meaningless bucket,
 *    which silently erases most of your source data. `resolveRedirects` follows
 *    them with a HEAD request to recover the target. It is off by default
 *    because it costs a round-trip per citation; turn it on and it is the
 *    difference between having source data and not.
 *
 * 2. THE PROVIDER'S OWN SPEND CAP IS NOT YOUR SPEND CAP. Grounding is billed
 *    per request and is easy to leave untracked, so this adapter reports a real
 *    cost rather than zero. An adapter that reports $0 gives you no warning
 *    before the provider's cap stops answering mid-cycle — which is exactly how
 *    one cycle died with 131 failed calls and no explanation in the logs.
 */

'use strict';

const https = require('https');
const { postJson, failure } = require('./http');

const HOST = 'generativelanguage.googleapis.com';

/** Google bills grounded requests per request, separately from tokens. */
const GROUNDING_COST_PER_REQUEST = 0.035;

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
const redirectCache = new Map();

/** Follow one grounding redirect to its real destination. Fail-safe. */
function resolveRedirect(url, timeoutMs = 8000) {
  if (!String(url).includes(REDIRECT_HOST)) return Promise.resolve(url);
  if (redirectCache.has(url)) return Promise.resolve(redirectCache.get(url));
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      redirectCache.set(url, v);
      resolve(v);
    };
    try {
      const u = new URL(url);
      const req = https.request({
        host: u.hostname, path: u.pathname + u.search, method: 'HEAD',
      }, (res) => {
        res.resume();
        finish(res.headers.location || url);   // no Location → keep the wrapper
      });
      req.on('error', () => finish(url));
      req.setTimeout(timeoutMs, () => { req.destroy(); finish(url); });
      req.end();
    } catch (_) { finish(url); }
  });
}

async function run(question, opts = {}) {
  const started = Date.now();
  const model = opts.model || 'gemini-2.0-flash';
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return failure(model, started, 'GEMINI_API_KEY not set');

  const body = {
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: { maxOutputTokens: opts.maxTokens || 1400 },
  };
  if (opts.search !== false) body.tools = [{ google_search: {} }];

  const res = await postJson(
    HOST, `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {}, body, opts.timeoutMs,
  );

  if (res.status !== 200 || !res.json) {
    const msg = (res.json && res.json.error && res.json.error.message) || res.raw;
    // A quota stop is its own status. Reporting it as a generic error hides the
    // one failure mode you can actually do something about.
    const quota = res.status === 429 || /quota|spending cap|RESOURCE_EXHAUSTED/i.test(String(msg));
    const f = failure(model, started, `HTTP ${res.status}: ${msg}`);
    return quota ? { ...f, status: 'quota_capped' } : f;
  }

  const cand = (res.json.candidates || [])[0] || {};
  const text = (cand.content && cand.content.parts || [])
    .map((p) => p.text || '').join('');

  let citations = [];
  const gm = cand.groundingMetadata || {};
  for (const c of gm.groundingChunks || []) {
    const uri = (c.web && c.web.uri) || null;
    if (uri) citations.push(uri);
  }
  citations = [...new Set(citations)];

  if (opts.resolveRedirects && citations.length) {
    citations = await Promise.all(citations.map((u) => resolveRedirect(u, opts.redirectTimeoutMs)));
  }

  const usage = res.json.usageMetadata || {};
  const tokensIn = usage.promptTokenCount || 0;
  const tokensOut = usage.candidatesTokenCount || 0;
  const p = (opts.pricing || {})[model] || {};
  const grounded = !!(gm.groundingChunks || gm.webSearchQueries);

  return {
    text: text || null,
    citations,
    searchCalls: grounded ? (gm.webSearchQueries || []).length || 1 : 0,
    tokensIn,
    tokensOut,
    costUsd: tokensIn * (p.in || 0) / 1e6
           + tokensOut * (p.out || 0) / 1e6
           + (grounded ? GROUNDING_COST_PER_REQUEST : 0),
    model,
    latencyMs: Date.now() - started,
    status: text ? 'ok' : 'empty',
    error: null,
  };
}

module.exports = { run, resolveRedirect, GROUNDING_COST_PER_REQUEST, alwaysSearches: false };
