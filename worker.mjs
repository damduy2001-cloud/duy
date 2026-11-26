const APIVN_BASE = 'https://apivn.vn/v1';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_UPSTREAM = 8 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const MODEL_CACHE_MS = 60_000;
const rates = new Map();
let modelCache = { at: 0, body: null };

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extra,
  },
});

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const u = new URL(origin);
    const same = u.origin === new URL(request.url).origin;
    const extras = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return same || extras.includes(origin);
  } catch { return false; }
}

function rateAllowed(request, env, now = Date.now()) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let row = rates.get(ip);
  if (!row || now - row.start >= RATE_WINDOW_MS) row = { start: now, count: 0 };
  row.count++;
  rates.set(ip, row);
  if (rates.size > 5000) {
    for (const [key, value] of rates) if (now - value.start > RATE_WINDOW_MS) rates.delete(key);
  }
  const limit = Math.max(1, Number(env.RATE_LIMIT || 60));
  return row.count <= limit;
}

function authorized(request, env) {
  const expected = String(env.RELAY_ACCESS_TOKEN || '');
  if (expected.length < 24) return false;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  return !!match && safeEqual(match[1], expected);
}

async function upstream(route, env, options = {}) {
  const key = String(env.APIVN_API_KEY || '');
  if (!key) return { status: 503, body: { error: { message: 'Relay upstream credential is not configured.' } } };
  const timeoutMs = Math.max(10_000, Math.min(300_000, Number(env.UPSTREAM_TIMEOUT_MS || 240_000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${APIVN_BASE}${route}`, {
      ...options,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(options.headers || {}) },
    });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_UPSTREAM) return { status: 502, body: { error: { message: 'Upstream response exceeds relay limit.' } } };
    const raw = new TextDecoder().decode(bytes);
    let body;
    try { body = JSON.parse(raw); }
    catch { body = { error: { message: 'APIVN returned a non-JSON response.', detail: raw.slice(0, 1000) } }; }
    return { status: response.status, body };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return { status: timedOut ? 504 : 502, body: { error: { message: timedOut ? 'APIVN request timed out.' : 'Could not reach APIVN.' } } };
  } finally { clearTimeout(timer); }
}

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ status: 'ok', service: 'ydtt-apivn-relay', version: 'cloudflare-1.0.0', upstreamConfigured: !!env.APIVN_API_KEY, authConfigured: String(env.RELAY_ACCESS_TOKEN || '').length >= 24 });
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/factory')) {
    if (!env.ASSETS) return json({ error: { message: 'Factory static asset binding is missing.' } }, 503);
    const assetUrl = new URL('/index.html', url);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" } });
  }
  if (!['/v1/models', '/v1/chat/completions'].includes(url.pathname)) return json({ error: { message: 'Not found.' } }, 404);
  if (!allowedOrigin(request, env)) return json({ error: { message: 'Origin is not allowed.' } }, 403);
  if (!authorized(request, env)) return json({ error: { message: 'Unauthorized.' } }, 401);
  if (!rateAllowed(request, env)) return json({ error: { message: 'Rate limit exceeded.' } }, 429, { 'retry-after': '60' });

  if (url.pathname === '/v1/models') {
    if (request.method !== 'GET') return json({ error: { message: 'Method not allowed.' } }, 405, { allow: 'GET' });
    if (modelCache.body && Date.now() - modelCache.at < MODEL_CACHE_MS) return json(modelCache.body, 200, { 'x-model-cache': 'HIT' });
    const result = await upstream('/models', env);
    if (result.status >= 200 && result.status < 300) modelCache = { at: Date.now(), body: result.body };
    return json(result.body, result.status, { 'x-model-cache': 'MISS' });
  }

  if (request.method !== 'POST') return json({ error: { message: 'Method not allowed.' } }, 405, { allow: 'POST' });
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return json({ error: { message: 'Content-Type must be application/json.' } }, 415);
  let raw;
  try {
    const reader = request.body?.getReader();
    if (!reader) raw = new ArrayBuffer(0);
    else {
      const chunks = []; let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) { await reader.cancel(); return json({ error: { message: 'Request body exceeds 4 MiB.' } }, 413); }
        chunks.push(value);
      }
      const joined = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      raw = joined.buffer;
    }
  } catch { return json({ error: { message: 'Could not read request body.' } }, 400); }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return json({ error: { message: 'Invalid JSON.' } }, 400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !String(payload.model || '').trim() || !Array.isArray(payload.messages) || payload.stream === true) {
    return json({ error: { message: 'Expected model, messages[], and stream:false.' } }, 400);
  }
  const result = await upstream('/chat/completions', env, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: false }),
  });
  return json(result.body, result.status);
}

export default { fetch: handleRequest };
export const _test = { safeEqual, allowedOrigin, rateAllowed, authorized, constants: { APIVN_BASE, MAX_BODY, MAX_UPSTREAM, RATE_WINDOW_MS } };
