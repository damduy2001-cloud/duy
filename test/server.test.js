'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { server, allowedOrigin } = require('../server');

let base;
const originalFetch = global.fetch;
const httpFetch = global.fetch;
const originalEnv = { ...process.env };
let calls = [];
test.before(async () => {
  process.env.RELAY_ACCESS_TOKEN = 'test-secret-token-which-is-long-enough-123456';
  process.env.APIVN_API_KEY = 'test-apivn-key';
  process.env.RATE_LIMIT = '100';
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model-test' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'YDTT_TEST_OK' } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  global.fetch = originalFetch;
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});
function auth(extra = {}) { return { authorization: `Bearer ${process.env.RELAY_ACCESS_TOKEN}`, ...extra }; }

test('health is available without exposing secrets', async () => {
  const r = await httpFetch(base + '/health'); const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.status, 'ok');
  assert.equal(JSON.stringify(d).includes(process.env.APIVN_API_KEY), false);
  assert.equal(JSON.stringify(d).includes(process.env.RELAY_ACCESS_TOKEN), false);
});
test('serves R1.5 Factory and isolated namespace marker', async () => {
  const r = await httpFetch(base + '/'); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /ydtt_factory_v271/); assert.match(html, /R1\.5 PRODUCTION HARDENING/);
});
test('rejects missing or invalid bearer token', async () => {
  assert.equal((await httpFetch(base + '/v1/models')).status, 401);
  assert.equal((await httpFetch(base + '/v1/models', { headers: auth().authorization ? { authorization: 'Bearer wrong' } : {} })).status, 401);
});
test('rejects cross-origin and null-origin browser requests', async () => {
  assert.equal((await httpFetch(base + '/v1/models', { headers: auth({ origin: 'https://evil.example' }) })).status, 403);
  assert.equal((await httpFetch(base + '/v1/models', { headers: auth({ origin: 'null' }) })).status, 403);
});
test('model discovery route is GET-only', async () => {
  const r = await httpFetch(base + '/v1/models', { method: 'POST', headers: auth({ origin: base, 'content-type': 'application/json' }), body: '{}' });
  assert.equal(r.status, 405); assert.equal(r.headers.get('allow'), 'GET');
});
test('accepts same-origin HTTPS behind a TLS-terminating reverse proxy', () => {
  const req = { headers: { origin: 'https://factory.example', host: 'factory.example', 'x-forwarded-proto': 'https' }, socket: { encrypted: false } };
  assert.equal(allowedOrigin(req), true);
});
test('model discovery routes to fixed APIVN endpoint with server credential', async () => {
  calls = []; const r = await httpFetch(base + '/v1/models', { headers: auth({ origin: base }) }); const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.data[0].id, 'model-test');
  assert.equal(calls[0].url, 'https://apivn.vn/v1/models');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${process.env.APIVN_API_KEY}`);
});
test('chat completions routes correctly and forces non-streaming', async () => {
  calls = []; const r = await httpFetch(base + '/v1/chat/completions', { method: 'POST', headers: auth({ origin: base, 'content-type': 'application/json' }), body: JSON.stringify({ model: 'model-test', messages: [{ role: 'user', content: 'hi' }], stream: false }) });
  const d = await r.json(); assert.equal(r.status, 200); assert.equal(d.choices[0].message.content, 'YDTT_TEST_OK');
  assert.equal(calls[0].url, 'https://apivn.vn/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${process.env.APIVN_API_KEY}`);
  assert.equal(JSON.parse(calls[0].options.body).stream, false);
});
test('rejects streaming, malformed payload and wrong content type', async () => {
  const headers = auth({ origin: base, 'content-type': 'application/json' });
  assert.equal((await httpFetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'x', messages: [], stream: true }) })).status, 400);
  assert.equal((await httpFetch(base + '/v1/chat/completions', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await httpFetch(base + '/v1/chat/completions', { method: 'POST', headers: auth({ origin: base }), body: '{}' })).status, 415);
});
test('missing APIVN credential fails closed', async () => {
  const key = process.env.APIVN_API_KEY; delete process.env.APIVN_API_KEY;
  try { const r = await httpFetch(base + '/v1/chat/completions', { method: 'POST', headers: auth({ origin: base, 'content-type': 'application/json' }), body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) }); assert.equal(r.status, 503); }
  finally { process.env.APIVN_API_KEY = key; }
});
test('rejects oversized chat payload', async () => {
  const body = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024 + 32) }] });
  const r = await httpFetch(base + '/v1/chat/completions', { method: 'POST', headers: auth({ origin: base, 'content-type': 'application/json' }), body });
  assert.equal(r.status, 413);
});
test('uses same-origin security headers', async () => {
  const r = await httpFetch(base + '/'); assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
});
