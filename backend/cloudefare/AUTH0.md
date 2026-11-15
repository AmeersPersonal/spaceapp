# Auth0 browser login

The Worker uses `@auth0/auth0-hono` 1.2.6 and its authorization-code flow with PKCE. Auth0 hosts the login/signup screen; the Worker verifies the callback and stores the session in encrypted, HttpOnly, SameSite=Lax cookies. HTTPS responses enforce Secure on session and transaction cookies. Sessions have a fixed one-hour lifetime; users then sign in again. No local users table is needed.

## Routes

| Route | Behavior |
|---|---|
| `GET /auth/login` | Redirect to Auth0 Universal Login. Successful login returns to `FRONTEND_URL` when set, otherwise `/api/auth/me`. `?screen_hint=signup` opens Auth0's sign-up screen. |
| `GET /auth/callback` | SDK callback; requires the login transaction cookie and valid code/ID token. |
| `GET /auth/logout` | Clear the local session and redirect through Auth0 logout, then back to the API root. |
| `GET /api/auth/me` | `{user:{sub,name?,email?,picture?}}`; 401 when logged out. Never returns tokens. |

`POST /api/ingest`, `POST /api/events/earthquake`, and `POST /api/ask` require a user session and `Content-Type: application/json`. A legacy `INGEST_API_KEY` no longer grants access to these endpoints or adds an extra requirement for signed-in users. Public catalog, discovery, tiles, ingest status and replay routes remain public. Every signed-in user can use those three write operations. Persistent chats enforce per-user ownership; administrator permissions and ownership of catalog/ingest resources are not implemented.

All `/api/chats` routes require authentication and owner-scoped access, including reads; see [CHAT_STORAGE.md](CHAT_STORAGE.md). Authentication routes, profile responses and protected operations use `Cache-Control: no-store`. Missing Auth0 configuration returns 503 on these routes; missing or invalid sessions return 401 on API operations. Invalid callbacks return a generic 400. Cross-site write origins return 403 and non-JSON writes return 415.

## Local setup

The `Earth Replay` Regular Web Application is configured in tenant `dev-8j8602hv217j1z36.us.auth0.com`, client ID `NEQOILq4iAhXRzN15kDBsrM8weJg6tgp`. Token endpoint authentication is `client_secret_post`, matching the installed server SDK. Only the `authorization_code` grant is enabled.

All local Worker credentials live in ignored `.dev.vars`, which Wrangler loads automatically. Auth0 credentials previously written to `.env.local` have been consolidated there, preserving service credentials. `npm run dev` starts the API on port 8787. For a fresh checkout copy `.dev.vars.example` to `.dev.vars`, configure the required variables below and set `FRONTEND_URL=http://localhost:5173/`. Use a cryptographically random session key of at least 32 characters. Frontend configuration remains in `Frontend/.env.local` and must contain no secrets.

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
| `FRONTEND_URL` | Optional URL of the browser app (`http://localhost:5173/` locally). Login and logout return the browser there and its origin may send protected writes. |
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

For a frontend on another origin, set `CORS_ORIGIN` to its exact origin; the Worker sends credentialed CORS headers only for that allowlist. Write requests also validate Origin (or reject `Sec-Fetch-Site: cross-site` when Origin is absent). Keep frontend and API on the same site, such as `app.example.com` and `api.example.com`, or proxy the API through the frontend origin. An unrelated frontend domain cannot use these SameSite=Lax cookies for cross-site fetches. Without `FRONTEND_URL`, login lands on the profile JSON.

### Frontend in this repository (`Frontend/`)

The Vite dev server (port 5173) proxies `/api`, `/auth` and `/tiles` to the Worker (`VITE_API_TARGET`, default `http://localhost:8787`), so the app uses relative URLs and one origin. Cookies are scoped to the host, not the port, so the session cookie set at `localhost:8787/auth/callback` is sent with requests to `localhost:5173`. Flow: the app links to `/auth/login` (or `?screen_hint=signup`) → Auth0 → `http://localhost:8787/auth/callback` → redirect to `FRONTEND_URL`. Logout: `/auth/logout` → Auth0 → API root → redirect to `FRONTEND_URL`. The SDK only accepts a post-login return URL on the API's own hostname; on any other hostname it falls back to `/`, which then forwards browsers to `FRONTEND_URL`. Set `FRONTEND_URL=http://localhost:5173/` in `.dev.vars`. Sign-in does not work when the dev proxy targets the deployed Worker, because Auth0 returns to that Worker's host and the cookie never reaches localhost. Verified locally on 2026-11-14: proxy, public catalog reads, 503 handling without a client secret and the root redirect. A real sign-in through the frontend is not yet verified.

## Production and verification

### Custom hostname transition (2026-11-15)

The custom hostname `doomsday.compare` serves the same Worker. Its production
configuration must use `APP_BASE_URL=https://doomsday.compare` and
`FRONTEND_URL=https://doomsday.compare/`, with the hostname retained in Wrangler
`routes` as a Custom Domain. Keep `workers_dev=true` to retain the original API
endpoint. Browser visits to the original root are forwarded to the custom frontend;
start login on the custom hostname so its transaction cookie reaches the callback.

The Auth0 application must additionally allow
`https://doomsday.compare/auth/callback` as a callback and
`https://doomsday.compare` as a logout URL. Preserve the localhost and original
Worker entries. A login started on the custom hostname with the old callback
fails because the transaction cookie belongs to another hostname. Auth0 also
rejects the new callback until its allowlist is updated. These two mismatches
were independently reproduced against the live endpoints.

The origin configuration was published as Worker version
`933b95b5-a141-4755-b034-68269f4e0907` after the Auth0 callback/logout allowlist
entries were saved and independently verified. All 17 existing auth tests and
the deployment dry run passed. A live browser reached Auth0's login form with
the Secure/HttpOnly transaction cookie scoped to `doomsday.compare`; live
redirect checks confirmed the matching callback and the original root's redirect
to the new frontend. A complete end-user sign-in has not been repeated by the
agent. Earlier verification below refers to the original Worker hostname.

The merged integration is deployed at `https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev`, version `1ca56909-55b9-4f03-9b8d-ca34b24d42e4`. Wrangler config sets `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `APP_BASE_URL`. Auth0 secrets were uploaded through Wrangler stdin, with a new production-only session key. Existing service secrets and production vars were preserved (`--keep-vars`). Both chat migrations are applied remotely. Local env files are not uploaded automatically. The Auth0 application allows the production callback/logout URLs. `CORS_ORIGIN` remains `*`; cross-origin frontend authentication still requires an exact allowlist and a compatible same-site deployment.

Run `npm test`. Auth tests use the actual SDK, encrypted cookies and an RSA-signed test ID token, with Auth0 discovery/token/JWKS calls mocked. They cover callback exchange, forged/expired/missing sessions, logout, CSRF/origin and JSON checks, CORS, fail-closed configuration, no-store headers and the three protected operations. Browser sign-in with a real end-user account is still a manual check.

`npm audit` reports two high-severity entries for the SDK's transitive Zod 3 dependency (GHSA-mrhx-c7xc-m3w5), with no compatible fix available. The affected schema validation here processes server-owned SDK configuration, not user-supplied collections. Revisit when Auth0 publishes an SDK with a patched dependency; do not force a breaking Zod major upgrade.

Client secrets are redacted from MCP responses. View the full secret in [Auth0 application settings](https://manage.auth0.com/dashboard/us/dev-8j8602hv217j1z36/applications/NEQOILq4iAhXRzN15kDBsrM8weJg6tgp/settings), or through authenticated `GET https://dev-8j8602hv217j1z36.us.auth0.com/api/v2/clients/NEQOILq4iAhXRzN15kDBsrM8weJg6tgp`. Do not paste secrets into chat or commit env files.

## Browser E2E verification status (2026-11-14)

All 203 backend tests across 14 files passed in a fresh deployment run. The deployment dry run passed, and the merged backend is active in production with both chat migrations applied.

The production browser E2E passed on 2026-11-14 (EST). Real Auth0 login established Secure/HttpOnly/SameSite=Lax session cookies. Two owner-scoped chats each saved two user/assistant AI turns. After the user confirmed Auth0's logout page, the session cookie was absent and profile, chat reads and AI writes returned 401. A second real login returned the same Auth0 subject and restored both histories exactly, including message IDs, content, ordering and metadata. A follow-up generated another user/assistant pair; the first chat then had six messages after a page reload. The same isolated browser profile was reopened between logout and re-login. No forged sessions or mocked providers were used for this browser check.

Auth0 logout can pause at `/oidc/logout/confirm`; confirm Yes before checking the return to the API root. Session policy and stored history are independent: logout clears browser authentication without deleting D1 chats. The frontend's sign-in form remains unintegrated, so these checks used the deployed Worker directly. Credentialed cross-origin frontend behavior is not verified. See [DEPLOYMENT_VERIFICATION.md](DEPLOYMENT_VERIFICATION.md) for the deployment version, live checks and limits.
