# Auth0 browser login

The Worker uses `@auth0/auth0-hono` 1.2.6 and its authorization-code flow with PKCE. Auth0 hosts the login/signup screen; the Worker verifies the callback and stores the session in encrypted, HttpOnly, SameSite=Lax cookies. HTTPS responses enforce Secure on session and transaction cookies. Sessions have a fixed one-hour lifetime; users then sign in again. No local users table is needed.

## Routes

| Route | Behavior |
|---|---|
| `GET /auth/login` | Redirect to Auth0 Universal Login. Successful login returns to `/api/auth/me`. |
| `GET /auth/callback` | SDK callback; requires the login transaction cookie and valid code/ID token. |
| `GET /auth/logout` | Clear the local session and redirect through Auth0 logout, then back to the API root. |
| `GET /api/auth/me` | `{user:{sub,name?,email?,picture?}}`; 401 when logged out. Never returns tokens. |

`POST /api/ingest`, `POST /api/events/earthquake`, and `POST /api/ask` require a user session and `Content-Type: application/json`. A legacy `INGEST_API_KEY` no longer grants access to these endpoints or adds an extra requirement for signed-in users. Public catalog, discovery, tiles, ingest status and replay routes remain public. Every signed-in user can use those three write operations. Persistent chats enforce per-user ownership; administrator permissions and ownership of catalog/ingest resources are not implemented.

All `/api/chats` routes require authentication and owner-scoped access, including reads; see [CHAT_STORAGE.md](CHAT_STORAGE.md). Authentication routes, profile responses and protected operations use `Cache-Control: no-store`. Missing Auth0 configuration returns 503 on these routes; missing or invalid sessions return 401 on API operations. Invalid callbacks return a generic 400. Cross-site write origins return 403 and non-JSON writes return 415.

## Local setup

The `Earth Replay` Regular Web Application is configured in tenant `dev-8j8602hv217j1z36.us.auth0.com`, client ID `NEQOILq4iAhXRzN15kDBsrM8weJg6tgp`. Token endpoint authentication is `client_secret_post`, matching the installed server SDK. Only the `authorization_code` grant is enabled.

The Auth0 MCP credential tool saved credentials to ignored `.env.local`. A random session encryption key and `APP_BASE_URL=http://localhost:8787` were added without displaying secrets. Existing `.dev.vars` service credentials are preserved. `npm run dev` loads `.dev.vars` first and `.env.local` second, on port 8787. For a fresh checkout copy `.dev.vars.example` to `.dev.vars` and configure the five variables below; use a cryptographically random key of at least 32 characters.

```sh
npm run dev
# Open http://localhost:8787/auth/login
```

The full dev server's existing Workers AI binding requires Cloudflare authentication. Automated tests run offline with fake AI/Vectorize bindings. A temporary configuration without those bindings can verify login independently; it cannot serve catalog/AI/ingest functionality.

Required Worker environment:

| Variable | Meaning |
|---|---|
| `AUTH0_DOMAIN` | Auth0 tenant hostname, without `https://`. |
| `AUTH0_CLIENT_ID` | Regular Web Application client ID. |
| `AUTH0_CLIENT_SECRET` | Application secret, server-side only. |
| `AUTH0_SESSION_ENCRYPTION_KEY` | Cryptographically random cookie-encryption secret, at least 32 characters. |
| `APP_BASE_URL` | Exact Worker origin: `http://localhost:8787` locally, HTTPS in production. |
| `CORS_ORIGIN` | Optional comma-separated exact frontend origins. `*` permits public reads but never credentialed cross-origin requests. |

Registered callbacks: `http://localhost:8787/auth/callback` and `https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev/auth/callback`. Registered logout URLs are the corresponding origins. The MCP server automatically set `skip_non_verifiable_callback_uri_confirmation_prompt=true` for localhost callbacks.

## Frontend contract

Navigate the browser to `/auth/login` to sign in and `/auth/logout` to sign out. Fetch `/api/auth/me` to show the current profile. Send cookies and JSON on protected requests:

```js
const response = await fetch(`${apiOrigin}/api/ask`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ eventId, question }),
});
if (response.status === 401) window.location.assign(`${apiOrigin}/auth/login`);
```

For a frontend on another origin, set `CORS_ORIGIN` to its exact origin; the Worker sends credentialed CORS headers only for that allowlist. Write requests also validate Origin (or reject `Sec-Fetch-Site: cross-site` when Origin is absent). Keep frontend and API on the same site, such as `app.example.com` and `api.example.com`, or proxy the API through the frontend origin. An unrelated frontend domain cannot use these SameSite=Lax cookies for cross-site fetches. Login currently lands on the profile JSON; the frontend owner can connect a landing page in a later change. Frontend UI is maintained outside this repository.

## Production and verification

The source integration has not been deployed. Before deploying, configure `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `APP_BASE_URL` and the exact frontend origin, then store `AUTH0_CLIENT_SECRET` and `AUTH0_SESSION_ENCRYPTION_KEY` using Wrangler secrets. Local env files are not uploaded automatically. Preserve existing Worker bindings and service secrets. The Auth0 application already allows the current production Worker callback URL.

Run `npm test`. Auth tests use the actual SDK, encrypted cookies and an RSA-signed test ID token, with Auth0 discovery/token/JWKS calls mocked. They cover callback exchange, forged/expired/missing sessions, logout, CSRF/origin and JSON checks, CORS, fail-closed configuration, no-store headers and the three protected operations. Browser sign-in with a real end-user account is still a manual check.

`npm audit` reports two high-severity entries for the SDK's transitive Zod 3 dependency (GHSA-mrhx-c7xc-m3w5), with no compatible fix available. The affected schema validation here processes server-owned SDK configuration, not user-supplied collections. Revisit when Auth0 publishes an SDK with a patched dependency; do not force a breaking Zod major upgrade.

Client secrets are redacted from MCP responses. View the full secret in [Auth0 application settings](https://manage.auth0.com/dashboard/us/dev-8j8602hv217j1z36/applications/NEQOILq4iAhXRzN15kDBsrM8weJg6tgp/settings), or through authenticated `GET https://dev-8j8602hv217j1z36.us.auth0.com/api/v2/clients/NEQOILq4iAhXRzN15kDBsrM8weJg6tgp`. Do not paste secrets into chat or commit env files.

## Browser E2E verification status (2026-11-14)

The pre-merge automated suite passed 157 tests in 11 files. It uses mocked Auth0 endpoints and AI services; it does not establish real end-user sign-in or real AI chat persistence. The main/Auth0 merge is now resolved; its combined automated suite passes 203 tests across 14 files. Real browser E2E remains pending.

The attempted full local startup failed because Wrangler did not receive `CLOUDFLARE_API_TOKEN` for its remote AI proxy. Auth0 client credentials do not authenticate Wrangler to Cloudflare. Configure Cloudflare credentials securely outside chat before retrying. The Vectorize binding also needs supported remote access for live retrieval. No deployment was performed during this check.

After starting the complete Worker, verify in the same browser:

1. Visit `/auth/login`, complete real Auth0 login, and confirm `/api/auth/me` returns the signed-in profile.
2. Select an existing event, create an event-bound chat with `POST /api/chats`, and send `/api/ask` with its `chatId`. Confirm both user and assistant messages appear in its message history.
3. Visit `/auth/logout`; confirm `/api/auth/me` and owned chat reads return 401 after logout.
4. Log in again to the same account; confirm the Auth0 subject is unchanged and the same chat and messages are restored.
5. Send a follow-up using the same `chatId`; confirm the history grows and continuation succeeds.

This sequence remains pending. A deployed environment is additionally required to verify deployed secrets, HTTPS cookie behavior and actual frontend/API origin integration. The public specialist `/api/chat` thread is separate from owner-scoped `/api/chats` and does not verify private chat access controls.
