# cloudefare

## Purpose
The Cloudflare Worker that serves the Earth Replay API. It catalogs NISAR scenes from ASF DAAC, runs the durable ingest pipeline, serves precomputed tiles from R2, answers AI questions and hosts shared replay rooms. HDF5 is never parsed here: an external Python processor makes the tiles.

## Contents
| Path | Description |
|---|---|
| `worker.js` | Entry point. Hono app with all routes, plus the `queue`/`scheduled` handlers; re-exports `IngestWorkflow` and `ReplayRoom`. |
| `workFlowManger.js` | Ingest request validation, `IngestWorkflow`, queue consumer + DLQ handler, cron poller. |
| `dataManger.js` | D1 catalog queries, R2 key layout/manifest reads, KV cache helpers, `DATA_CREDIT`. |
| `events.js` | USGS, NISAR, geocoding, seven supplementary NASA dataset adapters, and event/batch/queue handlers. |
| `DATASET_ACCESS.md` | Dataset integration scope, query examples, credentials, live checks and limitations. |
| `ENDPOINT_REFERENCE.md` | Deployed endpoint inputs, authentication, outputs, observed verification results and operational limits. |
| `ENDPOINT_CHECKS.json` | Credential-checked production HTTP/WebSocket verification evidence from November 14, 2026. |
| `asf.js` | ASF DAAC search client and NISAR GeoJSON normalizer (metadata only). |
| `cloudflare.md` | Step-by-step setup and deploy guide: account login, resource creation, secrets, deploy, troubleshooting. |
| `oAuth.js` | Earthdata token helpers, optional ingest API key middleware, processor auth header. |
| `sessionManger.js` | Room-code validation and the pure replay-state reducer. |
| `replay.js` | `ReplayRoom` Durable Object (hibernating WebSockets). |
| `bench/` | Developer-only benchmark of Gemini and Groq models on the real AI prompts. See [bench/SPEC.md](bench/SPEC.md). |
| `AI/` | Workers AI via AI Gateway: captions, Vectorize search, `/api/ask`, the multi-agent chat, summaries and predictions. See [AI/SPEC.md](AI/SPEC.md). |
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
| `GET /api/events` | `{events:[{id,name,type,bbox,products,startDate,endDate,watch,sceneCount,...}], credit}`. Cached in KV for 60 s. |
| `GET /api/events/:id` | `{event, scenes[], dates[], polarizations[], layers[{layer,date,minZoom,maxZoom,bounds,units,tiles}], captions[], credit}`. Returns 404 for an unknown id. |
| `GET /tiles/:event/:layer/:date/:z/:x/:y.png` | PNG from R2 at `tiles/{event}/{layer}/{date}/{z}/{x}/{y}.png`. Sends ETag and supports 304. Returns 404 if the tile is missing and 400 for bad coordinates (z ≤ 22, x,y < 2^z). |
| `GET /api/discover/earthquakes` | Query `minMagnitude` (4.5–9.9, default 6), `days` (1–365, default 30), optional `bbox`. Returns `{earthquakes:[{sourceId,title,magnitude,time,latitude,longitude,depthKm,tsunami,alert,url,registered,suggested:{eventId,aoi,dateRange,products,...}}], credit}`. USGS data, cached 10 min, and quakes before 2025-07-30 are dropped. |
| `POST /api/events/earthquake` | Body `{usgsId}`. Fetches the quake from USGS, creates event `usgs-<id>` if new, and starts a GUNW ingest (36 days before to 60 days after, clipped to launch/today). Returns 202 `{eventId, created, ingest:{id,status,dateRange,statusUrl}}`. Errors: 400, 404, 502, or 401 with `INGEST_API_KEY`. |
| `GET /api/nisar/search` | Query `bbox=w,s,e,n&start&end&products?`. Live ASF preview without cataloging: `{query,count,byProduct,dates,polarizations,scenes[],truncated,credit}`. |
| `GET /api/geocode` | Query `q` (2–200 chars). Returns `{formattedAddress,location,bbox,aoi,credit}` where `aoi` is capped at 5° per side. 503 without `GOOGLE_MAPS_API_KEY`, 404 for no match. |
| `GET /api/datasets` | `{sources:[{id,name,kind,configured,requiredSecret?,shortNames?,notes,credit,...}]}`. `configured` indicates whether required credentials exist, not provider health. Never returns keys. |
| `GET /api/datasets/:source` | `source`: firms/gpm/smap/hls/geos/terrain/grace. Requires `bbox=w,s,e,n`, `start`, `end`; optional `limit` (1–50, default 10), `page` (1–10000, default 1), GEOS `runDate` (default start), `cycle` (00/06/12/18, default 00). Region ≤5° per side, range ≤366 days, independent of NISAR launch. Returns `{source,name,kind,query,credit,notes,measurementsRetrieved,items,count,total,nextPage,truncated,...}`. CMR returns granule metadata/download references; GEOS returns global forecast file references; FIRMS returns detections, requires `FIRMS_MAP_KEY` and ≤5 inclusive days. Errors: 400 invalid input, 503 missing key, 404 absent GEOS archive, 502 provider/network/size failure. |
| `GET /api/datasets/context` | Same query plus optional comma-separated `sources` (default all seven). `{query,partial,results:{source:{ok,result? ,error?,message?,retryable?}}}`. Individual failures preserve successful results; valid queries return 200 even when some/all providers fail. |
| `POST /api/ingest` | Body `{aoi, dateRange:{start,end}, eventId?, name?, type?, products?, description?, watch?}`. `aoi` is `[w,s,e,n]` or a GeoJSON Polygon of at most 5°×5°. Dates are `YYYY-MM-DD`, span ≤ 366 days, end on/after 2025-07-30 and start no later than today. `type` is one of earthquake, flood, wetland, forest, crop, glacier, soil_moisture, other. `products` is a subset of GCOV/GUNW/GOFF/SME2, defaulting by type (earthquake→GUNW, glacier→GOFF, soil_moisture→SME2, else GCOV). Returns 202 `{id, eventId, status:'queued', dateRange, statusUrl}`. If `INGEST_API_KEY` is set, a missing or wrong key returns 401. |
| `GET /api/ingest/:id` | `{id, eventId, dateRange, trigger, status, sceneCount, error, workflow:{status,error}, progress:{total, <sceneStatus>:n}, scenes[{id,product,acquiredAt,status,error,url}], credit}`. `status` is queued, searching, dispatched, complete or failed. It reads complete once all scenes are ready or failed. |
| `POST /api/ask` | Body `{eventId, question}` (question 3–500 chars). Returns `{answer, sources[{captionId,sceneId,score}], sceneCount, model, aiGenerated:true, disclaimer, credit}`. Cached in KV for 1 h. Errors: 400, 404, or 502 `ai_unavailable`. |
| `GET /api/agents` | `{agents:[{id,name,expertise,eventTypes,model}]}`. |
| `POST /api/chat` | Body `{eventId, message (2-1000 chars), conversationId?, agent?}`. Routes to a specialist (or the requested `agent`), who may consult up to 2 others. Returns `{conversationId, eventId, reply:{agent,name,model,text}, consults:[{agent,name,model,text}], consultsFailed[], sources[], aiGenerated:true, disclaimer, credit}`. Pass `conversationId` back to continue the shared thread. Errors: 400, 404 (event or conversation, including one from another event), 502 `ai_unavailable`. |
| `GET /api/chat/:conversationId` | `{conversationId, eventId, createdAt, updatedAt, messages:[{id,role,agent,model,content,createdAt}], credit}` (role is user, consult or assistant). 404 if unknown. |
| `GET /api/events/:id/summary` | `{eventId, summary, agent, name, model, coverage:{sceneCount,byStatus,byProduct,firstDate,lastDate,layers}, captionCount, aiGenerated:true, disclaimer, credit}`. Cached in KV for 1 h, keyed on scene/ready/caption counts. 404 or 502. |
| `GET /api/events/:id/predict` | Query `horizonDays` (1-90, default 30). Returns `{eventId, modeled:true, horizonDays, status:'ok' or 'insufficient_data', observations:{count,firstDate,lastDate,cadenceDays,nextExpectedAcquisition}, metrics:[{key,product,metric,n,slopePerDay,r2,latest,projected:{date,value,low,high},direction,confidence}], skipped[], narrative, agent, model, aiGenerated, method, disclaimer, credit}`. A projection, never an observation. 400, 404 or 502. |
| `WS /api/room/:code` | `code` is 4–12 alphanumerics, case-insensitive. A request without `Upgrade: websocket` gets 426. |

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

### Dataset handlers
`listDatasets(env)`, `parseDatasetQuery(URLSearchParams)`, `fetchDataset(source, query, env, deps)`, and `datasetContext(query, env, deps)` are exported from `events.js`. All provider adapters support `deps.fetch`; query validation applies to direct callers too. Generic event messages support `{type:'dataset', source, bbox, start, end, ...}` and `{type:'dataset_context', sources?, bbox, start, end, ...}`. Results are returned to callers; no raster download, D1 persistence, R2 upload or AI prompt enrichment is triggered. Calls have a 10-second timeout and streamed response limits (2 MB, 4 MB for GEOS). CMR requests are anonymous; Earthdata credentials belong in the external download processor.
Vars: `AGENT_MODEL_<ID>` (optional per-agent model override, e.g. `AGENT_MODEL_FORECASTER`), `GOOGLE_GEOCODE_URL` (optional override), `AI_GATEWAY_ID`, `LLM_MODEL`, `EMBEDDING_MODEL`, `ASF_SEARCH_URL`, `PROCESSOR_URL`, `MAX_SCENES_PER_INGEST`, `CORS_ORIGIN`. Secrets: `EARTHDATA_TOKEN`, `INGEST_API_KEY`, `PROCESSOR_TOKEN`, `GOOGLE_MAPS_API_KEY`.

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
- npm: `hono`; dev: `wrangler`, `vitest` 4.1, `@cloudflare/vitest-plugin`.

## Tests
`npm test` (from this folder) runs Vitest in workerd with local D1/R2/KV/Queues/DO/Workflows. Workers AI and Vectorize are replaced by in-memory fakes, and ASF uses a recorded fixture, so tests make no external calls. There are 141 tests across 10 files; see [tests/SPEC.md](tests/SPEC.md). Gaps: Google responses are shaped from its documentation (no key to record one); real Vectorize/AI behavior is untested, as is the R2 notification wiring itself (only the message handler is tested).

## Status
Done: discovery/geocode/preview routes in events.js, every route in the contract, the ingest Workflow, queue/DLQ, cron, the replay DO, AI captions/ask, and KV caching.
TODO:
- Deployed via MCP to `earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev`; real D1/KV/account IDs are now in wrangler.jsonc. Gateway, Vectorize event metadata filter and R2 manifest notifications are configured; traces enabled. See ENDPOINT_REFERENCE.md for verification scope.
- D1 and KV now have real IDs in wrangler.jsonc. Still to do before deploy: confirm the R2 bucket, queues and Vectorize index exist, apply the D1 migration remotely (`npm run db:migrate:remote`), and create the AI Gateway.
- The Python processor (and an optional Container) does not exist yet. Scenes stay `awaiting_processor` until it does.
- Supplementary NASA discovery is implemented; raster extraction, cross-source alignment, persistence, automatic `manifest.context` enrichment and predictive modeling are not. FIRMS live access requires a map key. JRC Surface Water/WorldPop/WorldCover connectors remain unimplemented.
- `handleEventQueue` is not bound to a queue yet (events are handled inline by the routes).
- `compatibility_date` is pinned to 2026-08-15 because the local workerd bundled with the test plugin does not support later dates.

## Changelog
- 2026-11-14 - Per-use-case AI model routing with Groq and Gemini through AI Gateway (AI/AIGateway.js, wrangler.jsonc MODEL_* vars, cloudflare.md gateway guide, tests/routing.test.js).
- 2026-11-14 - Added bench/ (manual Gemini and Groq model benchmark; no Worker changes).
- 2026-11-14 - Verified existing production setup; reconciled resource IDs; deployed dataset adapters and local secrets through MCP while preserving Google key; configured Gateway/filter/manifest notifications; checked 34 HTTP requests and three WebSocket interactions and documented every endpoint.
- 2026-11-14 - Isolated tests from local FIRMS and Google credentials; prevents missing-key cases from accessing live APIs.
- 2026-11-14 - Added seven NASA dataset adapters, bounded regional queries, combined partial results, API routes, credential template, tests and live access notes.
- 2026-11-14 - Added the multi-agent chat, per-event summary and predictive analysis (routes, AI/ modules, migration 0002); the queue consumer now stores `manifest.stats` on scenes; vitest config blanks `GOOGLE_MAPS_API_KEY`.
- 2026-11-14 - Added cloudflare.md, the setup and deploy guide. Docs only, no code change.
- 2026-11-14 - Moved to a new Cloudflare account: wrangler.jsonc now has one `DB` (D1 `febe4577…`), `CACHE` (KV `8a8fcf0b…`) and `VECTORS` binding; removed the duplicate `earth_replay`/`VECTORIZE` bindings Wrangler had added and the `remote: true` flags. Config only, no code change.
- 2026-11-14 - Replaced the placeholder KV namespace id in wrangler.jsonc with the real `CACHE` namespace id so `wrangler deploy` stops failing with error 10041. Config only, no code change.
- 2026-11-14 - Implemented events.js: USGS earthquake discovery/registration, NISAR preview, Google geocoding, event handlers; four new routes; fixture and 35 tests.
- 2026-11-14 - Added gitignored `.env` for local secrets and ignored `.env*` in backend/.gitignore.
- 2026-11-14 - Initial Worker: Hono API, IngestWorkflow, ingest queue + DLQ, cron poller, ReplayRoom DO, AI captions/ask with Vectorize, D1 schema, tests. Validated ASF NISAR field names against live search responses.
