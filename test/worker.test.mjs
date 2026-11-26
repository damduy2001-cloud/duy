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
test('API routes require bearer token', async () => {
  assert.equal((await handleRequest(req('/v1/models'), env)).status, 401);
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
test('rate limiter enforces configured per-isolate threshold', () => {
  const local = { RATE_LIMIT: '1' };
  assert.equal(_test.rateAllowed(req('/v1/models', { headers: { 'CF-Connecting-IP': '198.51.100.1' } }), local, 10_000), true);
  assert.equal(_test.rateAllowed(req('/v1/models', { headers: { 'CF-Connecting-IP': '198.51.100.1' } }), local, 10_001), false);
});
