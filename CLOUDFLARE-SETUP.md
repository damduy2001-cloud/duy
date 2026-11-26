# YDTT APIVN Relay — Cloudflare Workers Free

## What this deploys
- Serves the existing YDTT Factory R1.5.1 APIVN Direct Guard build at `/` and `/factory` from `public/index.html`.
- `GET /health` reports configuration status without exposing secrets.
- `GET /v1/models` and `POST /v1/chat/completions` proxy only to the fixed APIVN v1 host.
- Requires a separate `RELAY_ACCESS_TOKEN`; the APIVN key remains a Cloudflare secret and is never sent to the browser.

## Deploy
1. Create a Cloudflare account and open Workers & Pages.
2. From this repository root, install Wrangler and authenticate: `npx wrangler@latest login`.
3. Create secrets (enter values in the terminal prompt; never commit them):
   - `npx wrangler@latest secret put APIVN_API_KEY`
   - `npx wrangler@latest secret put RELAY_ACCESS_TOKEN`
4. Deploy with `npx wrangler@latest deploy`.
5. Open the `workers.dev` URL and verify `/health` reports `upstreamConfigured: true` and `authConfigured: true`.
6. In Factory choose **Server Relay**, set Relay URL to the Worker origin only, paste the Relay Access Token into the session-only field, scan models, and test a non-streaming completion.

Generate a high-entropy Relay token locally, e.g. `openssl rand -hex 32`. Do not paste either secret into ChatGPT or GitHub.

## Optional variables
- `ALLOWED_ORIGINS`: comma-separated exact origin allowlist. Same-origin is already allowed; never use `*`.
- `RATE_LIMIT`: requests per minute per isolate/IP key (default 60).
- `UPSTREAM_TIMEOUT_MS`: 10,000–300,000 (default 240,000).

## Security and limitations
- APIVN key is stored only as a Cloudflare secret.
- Relay bearer token is shared access, not per-user identity; rotate it if exposed.
- Rate limiting is isolate-local best effort, not a global quota.
- Request bodies are capped at 4 MiB; upstream responses at 8 MiB.
- No prompt, completion, or credential logging is implemented.
- Cloudflare Workers hosting may fit its Free plan, but APIVN API usage may still incur provider charges. Verify current Cloudflare plan limits before production.
- Not deployed or live-tested against an APIVN account. Local automated tests do not establish production acceptance.
