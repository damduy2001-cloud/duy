'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const APIVN_BASE = 'https://apivn.vn/v1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 4 * 1024 * 1024;
const MAX_UPSTREAM = 8 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Math.max(1, Number(process.env.RATE_LIMIT || 60));
const UPSTREAM_TIMEOUT_MS = Math.max(10_000, Math.min(300_000, Number(process.env.UPSTREAM_TIMEOUT_MS || 240_000)));
const MODEL_CACHE_MS = 60_000;
const rates = new Map();
let modelCache = { at: 0, body: null };

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(payload);
}
function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients still require the bearer token
  if (origin === 'null') return false;
  try {
    const u = new URL(origin);
    const host = req.headers.host;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const transport = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
    const same = `${u.host}`.toLowerCase() === String(host || '').toLowerCase() && u.protocol === `${transport}:`;
    const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
    return same || extra.includes(origin);
  } catch { return false; }
}
function rateAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',').at(-1).trim();
  const now = Date.now(); let row = rates.get(ip);
  if (!row || now - row.start >= RATE_WINDOW_MS) row = { start: now, count: 0 };
  row.count++; rates.set(ip, row);
  if (rates.size > 5000) for (const [k, v] of rates) if (now - v.start > RATE_WINDOW_MS) rates.delete(k);
  return row.count <= RATE_LIMIT;
}
function authorized(req) {
  const expected = process.env.RELAY_ACCESS_TOKEN;
  if (!expected || expected.length < 24) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return !!match && safeEqual(match[1], expected);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, overflow = false, settled = false; const chunks = [];
    req.on('data', chunk => { if (overflow) return; size += chunk.length; if (size > MAX_BODY) { overflow = true; chunks.length = 0; settled = true; reject(Object.assign(new Error('Request body exceeds 4 MiB.'), { status: 413 })); return; } chunks.push(chunk); });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function upstream(route, options = {}) {
  const key = process.env.APIVN_API_KEY;
  if (!key) return { status: 503, body: { error: { message: 'Relay upstream credential is not configured.' } } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(`${APIVN_BASE}${route}`, {
      ...options, signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(options.headers || {}) }
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_UPSTREAM) return { status: 502, body: { error: { message: 'Upstream response exceeds relay limit.' } } };
    const text = bytes.toString('utf8');
    let body; try { body = JSON.parse(text); } catch { body = { error: { message: 'APIVN returned a non-JSON response.', detail: text.slice(0, 1000) } }; }
    return { status: response.status, body };
  } catch (e) {
    return { status: e.name === 'AbortError' ? 504 : 502, body: { error: { message: e.name === 'AbortError' ? 'APIVN request timed out.' : 'Could not reach APIVN.' } } };
  } finally { clearTimeout(timer); }
}
async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'ydtt-apivn-relay', version: '1.5.0', upstreamConfigured: !!process.env.APIVN_API_KEY, authConfigured: !!process.env.RELAY_ACCESS_TOKEN });
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/factory')) {
    const file = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(file)) return send(res, 503, { error: { message: 'Factory static file is missing.' } });
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-cache' }); return res.end(data);
  }
  if (!['/v1/models', '/v1/chat/completions'].includes(url.pathname)) return send(res, 404, { error: { message: 'Not found.' } });
  if (!allowedOrigin(req)) return send(res, 403, { error: { message: 'Origin is not allowed.' } });
  if (!authorized(req)) return send(res, 401, { error: { message: 'Unauthorized.' } });
  if (!rateAllowed(req)) return send(res, 429, { error: { message: 'Rate limit exceeded.' } }, { 'retry-after': '60' });
  if (url.pathname === '/v1/models') {
    if (req.method !== 'GET') return send(res, 405, { error: { message: 'Method not allowed.' } }, { allow: 'GET' });
    if (modelCache.body && Date.now() - modelCache.at < MODEL_CACHE_MS) return send(res, 200, modelCache.body, { 'x-model-cache': 'HIT' });
    const result = await upstream('/models');
    if (result.status >= 200 && result.status < 300) modelCache = { at: Date.now(), body: result.body };
    return send(res, result.status, result.body, { 'x-model-cache': 'MISS' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: { message: 'Method not allowed.' } }, { allow: 'POST' });
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return send(res, 415, { error: { message: 'Content-Type must be application/json.' } });
  let raw; try { raw = await readBody(req); } catch (e) { return send(res, e.status || 400, { error: { message: e.message } }); }
  let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: { message: 'Invalid JSON.' } }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !String(payload.model || '').trim() || !Array.isArray(payload.messages) || payload.stream === true) return send(res, 400, { error: { message: 'Expected model, messages[], and stream:false.' } });
  const result = await upstream('/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, stream: false }) });
  return send(res, result.status, result.body);
}
const server = http.createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: { message: 'Internal relay error.' } }); else res.destroy(); }); });
if (require.main === module) server.listen(PORT, HOST, () => process.stdout.write(`YDTT APIVN Relay listening on ${HOST}:${PORT}\n`));
module.exports = { server, handle, safeEqual, allowedOrigin, rateAllowed, constants: { APIVN_BASE, MAX_BODY, RATE_LIMIT, UPSTREAM_TIMEOUT_MS } };
