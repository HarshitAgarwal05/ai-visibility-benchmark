/**
 * Minimal HTTPS helper. No dependency, because a benchmark that pulls in a
 * request library ages badly and this needs exactly one verb.
 */

'use strict';

const https = require('https');

function postJson(host, path, headers, body, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: host,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* leave null */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

/** A failure shaped like a success, so callers never branch on two shapes. */
function failure(model, started, message) {
  return {
    text: null,
    citations: [],
    searchCalls: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    model,
    latencyMs: Date.now() - started,
    status: 'error',
    error: String(message).slice(0, 300),
  };
}

module.exports = { postJson, failure };
