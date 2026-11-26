import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, _test } from '../worker.mjs';

const TOKEN = 'test-relay-token-0123456789abcdef';
const env = { RELAY_ACCESS_TOKEN: TOKEN, APIVN_API_KEY: 'test-apivn-key', RATE_LIMIT: '60' };
const req = (path, init = {}) => new Request(`https://relay.example${path}`, init);

test('constant-time comparison helper rejects unequal values', () => {
  assert.equal(_test.safeEqual('abc', 'abc'), true);
  assert.equal(_test.safeEqual('abc', 'abd'), false);
  assert.equal(_test.safeEqual('abc', 'abcd'), false);
});
test('health route reveals configuration booleans but no secret', async () => {
  const r = await handleRequest(req('/health'), env);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.upstreamConfigured, true);
  assert.equal(body.authConfigured, true);
  assert.equal(JSON.stringify(body).includes('test-apivn-key'), false);
});
test('unknown routes are 404', async () => {
  assert.equal((await handleRequest(req('/other'), env)).status, 404);
});
test('API routes require valid bearer token and reject wrong or short tokens', async () => {
  assert.equal((await handleRequest(req('/v1/models'), env)).status, 401);
  assert.equal(_test.authorized(req('/v1/models', { headers: { Authorization: `Bearer ${TOKEN}` } }), env), true);
  assert.equal(_test.authorized(req('/v1/models', { headers: { Authorization: 'Bearer test-relay-token-0123456789abcdeg' } }), env), false);
  assert.equal(_test.authorized(req('/v1/models', { headers: { Authorization: `Bearer ${TOKEN}` } }), { RELAY_ACCESS_TOKEN: 'short' }), false);
});
test('null and foreign origins are rejected', async () => {
  const a = await handleRequest(req('/v1/models', { headers: { Origin: 'null', Authorization: `Bearer ${TOKEN}` } }), env);
  const b = await handleRequest(req('/v1/models', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` } }), env);
  assert.equal(a.status, 403); assert.equal(b.status, 403);
});
test('same origin is accepted', () => {
  assert.equal(_test.allowedOrigin(req('/v1/models', { headers: { Origin: 'https://relay.example' } }), env), true);
});
test('model route rejects wrong method', async () => {
  const r = await handleRequest(req('/v1/models', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }), env);
  assert.equal(r.status, 405);
});
test('chat route validates content type and schema', async () => {
  const a = await handleRequest(req('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' }), env);
  const b = await handleRequest(req('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [], stream: true }) }), env);
  assert.equal(a.status, 415); assert.equal(b.status, 400);
});
test('chat route rejects oversized request body', async () => {
  const huge = 'x'.repeat(_test.constants.MAX_BODY + 1);
  const r = await handleRequest(req('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: huge }), env);
  assert.equal(r.status, 413);
});
test('missing APIVN secret produces safe 503', async () => {
  const r = await handleRequest(req('/v1/models', { headers: { Authorization: `Bearer ${TOKEN}` } }), { RELAY_ACCESS_TOKEN: TOKEN });
  assert.equal(r.status, 503);
});
test('rate limiter allows first request and blocks requests above limit', () => {
  const local = { RATE_LIMIT: '1' };
  assert.equal(_test.rateAllowed(req('/v1/models', { headers: { 'CF-Connecting-IP': '198.51.100.11' } }), local, 10_000), true);
  assert.equal(_test.rateAllowed(req('/v1/models', { headers: { 'CF-Connecting-IP': '198.51.100.11' } }), local, 10_001), false);
});
test('root and factory routes serve configured static asset without redirects', async () => {
  const assets = { fetch: async () => new Response('factory-index', { status: 200, headers: { 'content-type': 'text/html' } }) };
  const root = await handleRequest(req('/'), { ASSETS: assets });
  const factory = await handleRequest(req('/factory'), { ASSETS: assets });
  assert.equal(root.status, 200); assert.equal(factory.status, 200);
  assert.equal(await root.text(), 'factory-index');
});
test('models cache only successful upstream responses and serves a fresh cache hit', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 }); };
  try {
    const headers = { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': '198.51.100.12' };
    const first = await handleRequest(req('/v1/models', { headers }), env);
    const second = await handleRequest(req('/v1/models', { headers }), env);
    assert.equal(first.status, 200); assert.equal(first.headers.get('x-model-cache'), 'MISS');
    assert.equal(second.status, 200); assert.equal(second.headers.get('x-model-cache'), 'HIT');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
test('chat completion forwards non-streaming JSON upstream', async () => {
  const originalFetch = globalThis.fetch; let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body), authorization: init.headers.Authorization };
    return new Response(JSON.stringify({ id: 'chat-test', choices: [] }), { status: 200 });
  };
  try {
    const response = await handleRequest(req('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.13' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'ping' }] })
    }), env);
    assert.equal(response.status, 200);
    assert.equal(captured.url, 'https://apivn.vn/v1/chat/completions');
    assert.equal(captured.body.stream, false); assert.equal(captured.body.model, 'test-model');
    assert.equal(captured.authorization, 'Bearer test-apivn-key');
  } finally { globalThis.fetch = originalFetch; }
});
