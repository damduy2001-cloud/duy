# YDTT APIVN Relay R1.5

## Local run

Requires Node.js 20+. Copy `.env.example` to `.env` only for local development and set secrets in your shell/server environment. Do not commit `.env`.

```sh
APIVN_API_KEY='...' RELAY_ACCESS_TOKEN='a-random-secret-at-least-32-bytes' npm start
```

Open `http://localhost:8787`. The Factory and API routes share one origin. In Factory settings, select **Server Relay**, set Relay URL to `http://localhost:8787` (origin only), enter the Relay Access Token, scan models, select an actual model ID, and test it.

## Routes

- `GET /health` — non-secret health/configuration status.
- `GET /v1/models` — authenticated, rate-limited APIVN model discovery; 60-second cache.
- `POST /v1/chat/completions` — authenticated, rate-limited non-streaming chat completions.

APIVN upstream is fixed to `https://apivn.vn/v1`; no arbitrary upstream URL forwarding is exposed.

## Production notes

Set `APIVN_API_KEY` and `RELAY_ACCESS_TOKEN` as server secrets. Never put them in HTML, Git, browser local storage, project preferences, or backup files. The relay token is a shared bearer secret; rotate it if exposed. For public deployment use HTTPS. Render deployment is intentionally not performed in this delivery.

## Tests

Run `npm test`. Tests use a mocked APIVN upstream and do not consume APIVN credits.
