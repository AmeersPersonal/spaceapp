# cloudefare

## Purpose
The Cloudflare Worker that serves the Earth Replay API. It catalogs NISAR scenes from ASF DAAC, runs the durable ingest pipeline, serves precomputed tiles from R2, answers AI questions and hosts shared replay rooms. HDF5 is never parsed here: an external Python processor makes the tiles.

## Contents
| Path | Description |
|---|---|
| `worker.js` | Entry point. Hono app with all routes, plus the `queue`/`scheduled` handlers; re-exports `IngestWorkflow` and `ReplayRoom`. |
| `auth0.js` | Auth0 SDK setup, browser login/callback/logout/profile, session protection for writes, origin and JSON checks, secure-cookie enforcement. |
| `AUTH0.md` | Local credentials, Auth0 tenant/application, frontend cookie contract, deployment steps and verification limitations. |
| `.gitignore` | Ignores Auth0 helper credentials, state and write audit logs. |
| `workFlowManger.js` | Ingest request validation, `IngestWorkflow`, queue consumer + DLQ handler, cron poller. |
| `dataManger.js` | D1 catalog queries, R2 key layout/manifest reads, KV cache helpers, `DATA_CREDIT`. |
| `events.js` | USGS, NISAR, geocoding, seven supplementary NASA dataset adapters, and event/batch/queue handlers. |
| `DATASET_ACCESS.md` | Dataset integration scope, query examples, credentials, live checks and limitations. |
| `ENDPOINT_REFERENCE.md` | Deployed endpoint inputs, authentication, outputs, observed verification results and operational limits. |
| `ENDPOINT_CHECKS.json` | Credential-checked production HTTP/WebSocket verification evidence from November 14, 2026. |
| `asf.js` | ASF DAAC search client and NISAR GeoJSON normalizer (metadata only). |
| `oAuth.js` | Earthdata/processor token helpers and legacy ingest-key helper; HTTP writes now use Auth0 sessions instead. |
| `sessionManger.js` | Room-code validation and the pure replay-state reducer. |
| `replay.js` | `ReplayRoom` Durable Object (hibernating WebSockets). |
| `AI/` | Workers AI via AI Gateway: captions, Vectorize search, `/api/ask` answers. See [AI/SPEC.md](AI/SPEC.md). |
| `migrations/` | D1 schema. See [migrations/SPEC.md](migrations/SPEC.md). |
| `tests/` | Vitest suites + fixtures. See [tests/SPEC.md](tests/SPEC.md). |
| `wrangler.jsonc` | Bindings, vars, queues, workflow, DO, cron. |
| `vitest.config.js` | `@cloudflare/vitest-plugin` config (local bindings, D1 migrations, offline env). |
| `package.json` / `.npmrc` | Deps and scripts. `.npmrc` sets `legacy-peer-deps` to work around an npm 10 peer-resolution crash with vitest 4. |
| `.dev.vars.example` | Template for local secrets. |
| `.env` | Local secrets for `wrangler dev` (gitignored, values blank). Wrangler ignores it if a `.dev.vars` exists. |

## Interfaces

### HTTP routes (frontend contract)
All JSON responses from catalog/ingest routes include `credit` (NASA/JPL-Caltech, ISRO, ASF DAAC). Errors look like `{error, message?|details?}`.

| Route | Notes |
|---|---|
| `GET /` | Service info and route list. |
| `GET /auth/login` | Redirect to Auth0 Universal Login using authorization code + PKCE; success lands on `/api/auth/me`. |
| `GET /auth/callback` | Verify login transaction/code/ID token and establish encrypted HttpOnly session. |
| `GET /auth/logout` | Clear local session and redirect through Auth0 logout to the API root. |
| `GET /api/auth/me` | `{user:{sub,name?,email?,picture?}}` or 401. Never returns tokens; no-store. |
| `GET /api/events` | `{events:[{id,name,type,bbox,products,startDate,endDate,watch,sceneCount,...}], credit}`. Cached in KV for 60 s. |
| `GET /api/events/:id` | `{event, scenes[], dates[], polarizations[], layers[{layer,date,minZoom,maxZoom,bounds,units,tiles}], captions[], credit}`. Returns 404 for an unknown id. |
| `GET /tiles/:event/:layer/:date/:z/:x/:y.png` | PNG from R2 at `tiles/{event}/{layer}/{date}/{z}/{x}/{y}.png`. Sends ETag and supports 304. Returns 404 if the tile is missing and 400 for bad coordinates (z ≤ 22, x,y < 2^z). |
| `GET /api/discover/earthquakes` | Query `minMagnitude` (4.5–9.9, default 6), `days` (1–365, default 30), optional `bbox`. Returns `{earthquakes:[{sourceId,title,magnitude,time,latitude,longitude,depthKm,tsunami,alert,url,registered,suggested:{eventId,aoi,dateRange,products,...}}], credit}`. USGS data, cached 10 min, and quakes before 2025-07-30 are dropped. |
| `POST /api/events/earthquake` | Body `{usgsId}`. Fetches the quake from USGS, creates event `usgs-<id>` if new, and starts a GUNW ingest (36 days before to 60 days after, clipped to launch/today). Returns 202 `{eventId, created, ingest:{id,status,dateRange,statusUrl}}`. Requires an Auth0 session and JSON; errors include 400, 401, 403, 404, 415, 502 and 503. |
| `GET /api/nisar/search` | Query `bbox=w,s,e,n&start&end&products?`. Live ASF preview without cataloging: `{query,count,byProduct,dates,polarizations,scenes[],truncated,credit}`. |
| `GET /api/geocode` | Query `q` (2–200 chars). Returns `{formattedAddress,location,bbox,aoi,credit}` where `aoi` is capped at 5° per side. 503 without `GOOGLE_MAPS_API_KEY`, 404 for no match. |
| `GET /api/datasets` | `{sources:[{id,name,kind,configured,requiredSecret?,shortNames?,notes,credit,...}]}`. `configured` indicates whether required credentials exist, not provider health. Never returns keys. |
| `GET /api/datasets/:source` | `source`: firms/gpm/smap/hls/geos/terrain/grace. Requires `bbox=w,s,e,n`, `start`, `end`; optional `limit` (1–50, default 10), `page` (1–10000, default 1), GEOS `runDate` (default start), `cycle` (00/06/12/18, default 00). Region ≤5° per side, range ≤366 days, independent of NISAR launch. Returns `{source,name,kind,query,credit,notes,measurementsRetrieved,items,count,total,nextPage,truncated,...}`. CMR returns granule metadata/download references; GEOS returns global forecast file references; FIRMS returns detections, requires `FIRMS_MAP_KEY` and ≤5 inclusive days. Errors: 400 invalid input, 503 missing key, 404 absent GEOS archive, 502 provider/network/size failure. |
| `GET /api/datasets/context` | Same query plus optional comma-separated `sources` (default all seven). `{query,partial,results:{source:{ok,result? ,error?,message?,retryable?}}}`. Individual failures preserve successful results; valid queries return 200 even when some/all providers fail. |
| `POST /api/ingest` | Body `{aoi, dateRange:{start,end}, eventId?, name?, type?, products?, description?, watch?}`. `aoi` is `[w,s,e,n]` or a GeoJSON Polygon of at most 5°×5°. Dates are `YYYY-MM-DD`, span ≤ 366 days, end on/after 2025-07-30 and start no later than today. `type` is one of earthquake, flood, wetland, forest, crop, glacier, soil_moisture, other. `products` is a subset of GCOV/GUNW/GOFF/SME2, defaulting by type (earthquake→GUNW, glacier→GOFF, soil_moisture→SME2, else GCOV). Returns 202 `{id, eventId, status:'queued', dateRange, statusUrl}`. Requires an Auth0 session and JSON; missing login returns 401. |
| `GET /api/ingest/:id` | `{id, eventId, dateRange, trigger, status, sceneCount, error, workflow:{status,error}, progress:{total, <sceneStatus>:n}, scenes[{id,product,acquiredAt,status,error,url}], credit}`. `status` is queued, searching, dispatched, complete or failed. It reads complete once all scenes are ready or failed. |
| `POST /api/ask` | Body `{eventId, question}` (question 3–500 chars). Returns `{answer, sources[{captionId,sceneId,score}], sceneCount, model, aiGenerated:true, disclaimer, credit}`. Cached in KV for 1 h. Errors: 400, 404, or 502 `ai_unavailable`. |
| `WS /api/room/:code` | `code` is 4–12 alphanumerics, case-insensitive. A request without `Upgrade: websocket` gets 426. |

### Browser authentication
Browser authentication: `POST /api/ingest`, `POST /api/events/earthquake` and `POST /api/ask` require an Auth0 session cookie and JSON content type. All other listed data endpoints remain public. Missing Auth0 configuration fails closed with 503; missing/invalid sessions return 401; disallowed write origins return 403; non-JSON writes return 415. Auth/profile and protected operations use no-store. Credentialed CORS requires exact origins in `CORS_ORIGIN`. Sessions have a fixed one-hour lifetime and HTTPS Secure/HttpOnly/SameSite=Lax cookies. See [AUTH0.md](AUTH0.md) for same-site frontend requirements and complete setup.

### Replay WebSocket protocol
Client→server: `load {eventId, layer?}`, `play`, `pause {frame?}`, `seek {frame}`, `speed {speed 0.25–8}`, `layer {layer}`, `sync`, `ping`.
Server→client: `state {state:{eventId,layer,frame,playing,speed,updatedAt,version}, serverTime}`, `presence {count}`, `error {error}`, `pong`. Clients extrapolate the playback position from `updatedAt`/`speed` while `playing`.

### Queue messages (`earth-replay-ingest`, DLQ `earth-replay-ingest-dlq`)
- `{type:'process', ingestId, eventId, sceneId}` comes from the Workflow. It POSTs a job to `PROCESSOR_URL` and marks the scene `processing`, or `awaiting_processor` when no URL is set. A 5xx/429 or network error retries with backoff (15 s·2^n, max 300 s). A 4xx marks the scene `failed`.
- An R2 event notification `{bucket, action, object:{key}}` for `manifests/{eventId}/{sceneId}.json` registers layers, marks the scene `ready` and creates one AI caption. If the manifest is unreadable or AI fails, the message retries. An invalid manifest or unknown scene marks the scene `failed`. Other keys and actions are acked and ignored.
- When messages land in the DLQ, the scene is marked `failed` with a reason.

### Processor contract (external Python, h5py/rasterio)
- Job POST body: `{eventId, sceneId, product, url, polarizations, bbox, output:{tilePrefix, manifestKey}}` with `Authorization: Bearer PROCESSOR_TOKEN`.
- The processor writes tiles under `tiles/{eventId}/{layer}/{YYYY-MM-DD}/{z}/{x}/{y}.png`, then the manifest last: `{layers:[{layer, date, minZoom?, maxZoom?, bounds?, units?}], stats?, context?}`. `layer` must match `[a-z0-9][a-z0-9_-]*`.
- Without a processor, run it locally against the `awaiting_processor` scenes listed by `GET /api/ingest/:id` and upload to R2.

### Workflow `IngestWorkflow` (binding `INGEST_WORKFLOW`)
Params `{ingestId, eventId, wkt, start, end, products, maxScenes}`. Steps: `mark-searching` → `search-asf` (3 retries, exponential; a 4xx is non-retryable) → `catalog-scenes` → `enqueue-scenes` → `finalize`. On error it runs `mark-failed`. Output is `{ingestId, sceneCount, sceneIds}`.

### Cron
`0 */6 * * *` starts an ingest (trigger `cron`) for every event with `watch=1`, covering `last_polled_at` (or `end_date`, or 12 days ago) through today.

### Bindings
`DB` (D1 `earth-replay`), `TILES` (R2 `earth-replay-tiles`), `CACHE` (KV), `INGEST_QUEUE` (Queue), `INGEST_WORKFLOW` (Workflow), `REPLAY_ROOM` (DO, SQLite), `AI` (Workers AI), `VECTORS` (Vectorize `earth-replay-captions`, 768-dim cosine).

### Env vars / secrets
Vars: `GOOGLE_GEOCODE_URL` (optional override), `AI_GATEWAY_ID`, `LLM_MODEL`, `EMBEDDING_MODEL`, `ASF_SEARCH_URL`, `PROCESSOR_URL`, `MAX_SCENES_PER_INGEST`, `CORS_ORIGIN`. Secrets: `EARTHDATA_TOKEN`, `INGEST_API_KEY`, `PROCESSOR_TOKEN`, `GOOGLE_MAPS_API_KEY`, `FIRMS_MAP_KEY` (separate from Earthdata Login; see `.dev.vars.example`).

Auth0 requires `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `APP_BASE_URL`, and secrets `AUTH0_CLIENT_SECRET`, `AUTH0_SESSION_ENCRYPTION_KEY` (32+ characters). `INGEST_API_KEY` is legacy and no longer grants write access. `npm run dev` explicitly loads `.dev.vars` then `.env.local` on port 8787. Never commit local credentials.

### Dataset handlers
`listDatasets(env)`, `parseDatasetQuery(URLSearchParams)`, `fetchDataset(source, query, env, deps)`, and `datasetContext(query, env, deps)` are exported from `events.js`. All provider adapters support `deps.fetch`; query validation applies to direct callers too. Generic event messages support `{type:'dataset', source, bbox, start, end, ...}` and `{type:'dataset_context', sources?, bbox, start, end, ...}`. Results are returned to callers; no raster download, D1 persistence, R2 upload or AI prompt enrichment is triggered. Calls have a 10-second timeout and streamed response limits (2 MB, 4 MB for GEOS). CMR requests are anonymous; Earthdata credentials belong in the external download processor.

### Setup commands (one-time)
```sh
npx wrangler d1 create earth-replay            # put the id in wrangler.jsonc
npx wrangler kv namespace create CACHE         # put the id in wrangler.jsonc
npx wrangler r2 bucket create earth-replay-tiles
npx wrangler queues create earth-replay-ingest
npx wrangler queues create earth-replay-ingest-dlq
npx wrangler vectorize create earth-replay-captions --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index earth-replay-captions --property-name=eventId --type=string
npx wrangler r2 bucket notification create earth-replay-tiles --event-type object-create --queue earth-replay-ingest --prefix manifests/ --suffix .json
npm run db:migrate:remote
# Create AI Gateway "earth-replay" in the dashboard (AI > AI Gateway).
```

## Dependencies
- Cloudflare: Workers, Workflows, Queues + DLQ, Durable Objects, R2 (+ event notifications), D1, KV, Workers AI, AI Gateway, Vectorize, Cron Triggers.
- External: USGS FDSN event API; Google Geocoding API; ASF DAAC; NASA CMR `search/granules.json` (GPM, SMAP, HLS, NASADEM, GRACE); NCCS GEOS-FP forecast directory; NASA FIRMS area CSV API (separate key); the external Python processor (not in this folder).
- npm: `hono`, `@auth0/auth0-hono` 1.2.6; dev: `wrangler`, `vitest` 4.1, `@cloudflare/vitest-plugin`, `@auth0/auth0-server-js` for real encrypted session fixtures.

## Tests
`npm test` (from this folder) runs Vitest in workerd with local D1/R2/KV/Queues/DO/Workflows. Workers AI and Vectorize are replaced by in-memory fakes, and external provider calls are mocked, so tests make no external calls. All 146 tests passed across 10 files on 2026-11-14; see [tests/SPEC.md](tests/SPEC.md). Gaps: Google and FIRMS live credentialed access are unverified; real Vectorize/AI behavior is untested, as is the R2 notification wiring itself (only the message handler is tested). Supplementary NASA live catalog checks are documented separately in DATASET_ACCESS.md.

## Status
Auth0 is implemented in source, and the tenant application/local credentials are configured. This authentication change is not deployed. The 146-test suite passes; live localhost login redirects to Auth0's hosted `/u/login`. A real browser end-user sign-in remains a manual check. The full dev server requires Cloudflare credentials for its preexisting AI remote binding. The SDK's transitive Zod advisory and same-site browser-cookie limitation are documented in AUTH0.md.

Done: discovery/geocode/preview routes in events.js, every route in the contract, the ingest Workflow, queue/DLQ, cron, the replay DO, AI captions/ask, and KV caching.
TODO:
- Deployed via MCP to `earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev`; real D1/KV/account IDs are now in wrangler.jsonc. Gateway, Vectorize event metadata filter and R2 manifest notifications are configured; traces enabled. See ENDPOINT_REFERENCE.md for verification scope.
- The Python processor (and an optional Container) does not exist yet. Scenes stay `awaiting_processor` until it does.
- Supplementary NASA discovery is implemented; raster extraction, cross-source alignment, persistence, automatic `manifest.context` enrichment and predictive modeling are not. FIRMS live access requires a map key. JRC Surface Water/WorldPop/WorldCover connectors remain unimplemented.
- `handleEventQueue` is not bound to a queue yet (events are handled inline by the routes).
- `compatibility_date` is pinned to 2026-08-15 because the local workerd bundled with the test plugin does not support later dates.

## Changelog
- 2026-11-14 - Added Auth0 browser login/logout/profile and encrypted sessions; protect ingest/AI writes, validate origins/JSON, enforce Secure auth cookies on HTTPS and document frontend/deployment setup.
- 2026-11-14 - Verified existing production setup; reconciled resource IDs; deployed dataset adapters and local secrets through MCP while preserving Google key; configured Gateway/filter/manifest notifications; checked 34 HTTP requests and three WebSocket interactions and documented every endpoint.
- 2026-11-14 - Isolated tests from local FIRMS and Google credentials; prevents missing-key cases from accessing live APIs.
- 2026-11-14 - Added seven NASA dataset adapters, bounded regional queries, combined partial results, API routes, credential template, tests and live access notes.
- 2026-11-14 - Implemented events.js: USGS earthquake discovery/registration, NISAR preview, Google geocoding, event handlers; four new routes; fixture and 35 tests.
- 2026-11-14 - Added gitignored `.env` for local secrets and ignored `.env*` in backend/.gitignore.
- 2026-11-14 - Initial Worker: Hono API, IngestWorkflow, ingest queue + DLQ, cron poller, ReplayRoom DO, AI captions/ask with Vectorize, D1 schema, tests. Validated ASF NISAR field names against live search responses.
