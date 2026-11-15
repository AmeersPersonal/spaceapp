# Run the frontend and backend locally

Commands below use **PowerShell** and start from the repository root:

```powershell
cd E:\Work\Projects\spaceapp
```

The frontend runs at **http://localhost:5173/** and the backend at
**http://localhost:8787/**. Use `localhost` consistently for login cookies.

## Quick start for an already configured checkout

Open two terminals at the repository root and leave both running.

**Terminal 1 — backend:**

```powershell
npm --prefix backend/cloudefare run dev
```

Wait for Wrangler to report that it is ready on port **8787**.

**Terminal 2 — frontend:**

```powershell
npm --prefix Frontend run dev
```

Open **http://localhost:5173/**. Vite forwards `/api`, `/auth`, `/tiles` and
replay WebSockets to the backend. Stop each server with **Ctrl+C**.

If this is your first run, complete the setup below first.

## First-time setup

### 1. Check Node.js and install dependencies

Use **Node.js 22.12 or newer**, as required by the installed Wrangler version.
This checkout was checked with Node.js **24.13.0** and npm **10.9.0**.

```powershell
node --version
npm --version
npm --prefix Frontend ci
npm --prefix backend/cloudefare ci
```

The applications have separate package files; there is no root `npm install`.
Python and Docker are not needed to run the React app and Worker API.

### 2. Confirm the local Wrangler configuration exists

```powershell
Test-Path backend/cloudefare/wrangler.jsonc
```

This must return `True`. The file is intentionally ignored by Git, so a fresh
clone does not include it. Obtain the project's configured copy from the
maintainer. For a new Cloudflare account, follow
[the Cloudflare setup guide](backend/cloudefare/cloudflare.md) to configure
your own resources and binding IDs.

The configuration needs the API entry point `worker.js` and its bindings:
`DB`, `TILES`, `CACHE`, `INGEST_QUEUE`, `INGEST_WORKFLOW`, `REPLAY_ROOM`,
`AI` and `VECTORS`. The current local configuration also has an `ASSETS`
binding pointing to `../../Frontend/dist`.

Build those static assets before starting Wrangler:

```powershell
npm --prefix Frontend run build
```

Repeat this build after frontend changes if you also want the Worker to serve
the latest built app. The Vite server on port 5173 updates source changes
automatically.

### 3. Configure local environment files

Create missing files without overwriting existing credentials:

```powershell
if (-not (Test-Path backend/cloudefare/.dev.vars)) {
    Copy-Item backend/cloudefare/.dev.vars.example backend/cloudefare/.dev.vars
}
if (-not (Test-Path Frontend/.env.local)) {
    Copy-Item Frontend/.env.example Frontend/.env.local
}
```

In **`Frontend/.env.local`**, use:

```dotenv
VITE_API_TARGET=http://localhost:8787
```

This is also Vite's default when the file is absent. Frontend environment
variables must contain no secrets.

In **`backend/cloudefare/.dev.vars`**, preserve existing service credentials
and configure these values for local sign-in:

```dotenv
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
AUTH0_SESSION_ENCRYPTION_KEY=your-random-secret-at-least-32-characters
APP_BASE_URL=http://localhost:8787
FRONTEND_URL=http://localhost:5173/
```

Replace the example Auth0 values with the project's application settings.
Generate a session encryption key if one is not already configured:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set that output as `AUTH0_SESSION_ENCRYPTION_KEY`. Wrangler loads `.dev.vars`
automatically; `backend/cloudefare/.env.local` is not needed by the current
startup script. Keep credentials in the ignored files.

The Auth0 Regular Web Application must allow:

| Setting | Local URL |
| --- | --- |
| Allowed Callback URLs | `http://localhost:8787/auth/callback` |
| Allowed Logout URLs | `http://localhost:8787` |

See [AUTH0.md](backend/cloudefare/AUTH0.md) for the full authentication contract.
Without Auth0 configuration, public catalog browsing and sample mode remain
available, but sign-in and protected operations return `auth_not_configured`.

### 4. Authenticate Wrangler with Cloudflare

The configured `AI` binding calls real Workers AI even during local development,
so the normal backend startup requires Cloudflare authentication.

Use device authorization:

```powershell
Push-Location backend/cloudefare
npx wrangler login --device
npx wrangler whoami
Pop-Location
```

Approve Wrangler on the Cloudflare page that opens. Enter the temporary
code printed in the terminal if prompted, then confirm that `whoami` lists
the account configured in `wrangler.jsonc`. If the code expires, run the
device login command again to get a fresh one.
Cloudflare credentials are separate from the Auth0 login credentials.

To reset the Wrangler login or switch Cloudflare accounts, stop the backend
and run:

```powershell
Push-Location backend/cloudefare
npx wrangler logout
npx wrangler login --device
npx wrangler whoami
Pop-Location
```

Complete the authorization in your browser. If it selects the wrong account,
sign in to the intended Cloudflare account before approving Wrangler. Confirm
that `whoami` lists the `account_id` configured in `wrangler.jsonc`; switching
to a different account also requires that account's project bindings.
This resets the CLI login while preserving `.dev.vars`, `wrangler.jsonc`,
local development data and deployed resources.

### 5. Apply local database migrations

Run this before starting the backend:

```powershell
npm --prefix backend/cloudefare run db:migrate:local
```

Confirm the prompt if migrations are pending. This command uses local D1
storage under `backend/cloudefare/.wrangler/`; it does not migrate production.
Run it again after pulling changes that add migrations.

Now start both terminals using the quick-start commands above.

## Verify the connection

From a third terminal:

```powershell
Invoke-RestMethod http://localhost:8787/api/events
Invoke-RestMethod http://localhost:5173/api/events
```

Both should return the same catalog response, including an `events` array.
The second request verifies that the frontend proxy reaches the local API.
A fresh local database has no events; choose **Sample data** in the app to
explore the seven bundled scenarios.

For authentication, open **Sign In** in the frontend. With Auth0 configured,
`/api/auth/me` returns **401** while signed out and the user profile after a
successful login. A **503** with `auth_not_configured` means required Auth0
settings are missing.

## Optional services and current limits

| Feature | Additional setup |
| --- | --- |
| AI briefings and questions | Cloudflare authentication and the configured Workers AI / AI Gateway services. Calls use remote resources. |
| Real scene processing | A configured `PROCESSOR` container binding or an external `PROCESSOR_URL`, a shared `PROCESSOR_TOKEN`, and an `EARTHDATA_TOKEN`. The Python service is in `backend/cloudefare/processor/`; `npm run dev` does not start it separately. Without a processor, scenes remain `awaiting_processor`. |
| Semantic search | The configured Vectorize binding does not support local emulation. It needs additional remote-binding setup. |
| Place-name geocoding | `GOOGLE_MAPS_API_KEY` with the Geocoding API enabled. |
| FIRMS fire detections | `FIRMS_MAP_KEY`. Other supplementary sources have their own availability limits. |

Local catalog data and files are separate from the deployed application's
D1, R2 and KV data. The scheduled ingest poll does not run automatically in
local development.

To browse the deployed public catalog without running a local Worker, set
`VITE_API_TARGET=https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev`
in `Frontend/.env.local` and restart Vite. Localhost sign-in does not work in
that mode because the Auth0 callback and session cookie belong to the deployed
Worker's host. Restore the local target to test frontend authentication.

## Checks

Frontend lint and production build, from the repository root:

```powershell
npm --prefix Frontend run lint
npm --prefix Frontend run build
```

Backend tests, with serial execution to avoid the previously observed parallel
Workflow/replay test timing failures:

```powershell
Push-Location backend/cloudefare
node node_modules/vitest/vitest.mjs run --no-file-parallelism
Pop-Location
```

Tests use local bindings and mocked external services; they do not require
real Auth0 end-user login. Build `Frontend/dist` first when the Wrangler
configuration includes the `ASSETS` binding.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Frontend loads, but API requests return 500/502 | Start the backend and check its terminal. Confirm `VITE_API_TARGET` points to port 8787. |
| Wrangler fails to start its remote proxy session | Run `npx wrangler login --device` from `backend/cloudefare`, approve the request on Cloudflare, and confirm the account with `npx wrangler whoami`. |
| Missing static assets directory | Run `npm --prefix Frontend run build` before starting Wrangler. |
| `no such table` from D1 | Run `npm --prefix backend/cloudefare run db:migrate:local`. |
| Port 5173 or 8787 is already in use | Stop the other development server. Keep the documented ports because the proxy and Auth0 URLs depend on them. |
| Login redirects incorrectly | Use `localhost` consistently and check `APP_BASE_URL`, `FRONTEND_URL`, the Auth0 allowlists, and the local API target. Restart servers after changing environment files. |
| Empty local NISAR catalog | Expected on first setup. Use sample mode or sign in and ingest data. Signed-out map browsing also filters to Japan. |
| Processed imagery is blank and tile requests contain `%7Bz%7D` | This is the separately identified tile-template bug in `Frontend/src/NisarMap.jsx`, not a missing startup step. |

Setup-command verification on 2026-11-15: local D1 migrations completed and
Vite served the frontend successfully. After `wrangler login --device`,
`wrangler whoami` confirmed the configured account and the local Worker
started successfully. `/api/events` and `/api/agents` returned HTTP 200;
`/api/auth/me` correctly returned HTTP 401 while signed out.
