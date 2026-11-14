# Earth Replay: deployed API and endpoint checks

Verified November 14, 2026. Base URL:

`https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev`

Deployment: `5bd2a796-ede2-4788-822a-14bd672dd7c9`; Worker version: `820e0de7-81e2-4ff0-b9d9-f1eaa1d4eebb`, serving 100% of traffic. Code was built with the project-local Wrangler and uploaded through Cloudflare MCP. No frontend was deployed.

## Verification summary

All 132 automated tests passed before deployment. The deployed service was checked with 34 HTTP requests and three WebSocket checks. Exact requests and responses, without credentials, are in [ENDPOINT_CHECKS.json](ENDPOINT_CHECKS.json).

Baseline checks before deployment confirmed the existing root, event catalog, USGS discovery, NISAR search and Google geocoding worked; `/api/datasets` was then absent (404). After deployment all seven supplementary adapters responded successfully. Empty FIRMS results are successful empty tables, not evidence that a fire classifier or forecast has run.

The deployed ingest Workflow completed discovery for four real NISAR scenes and queued them. All four reached **`awaiting_processor`**, because the external processor and `PROCESSOR_URL` remain absent. Tile generation, raster extraction, change statistics, authenticated source-file downloads by a processor, and disaster prediction are **not end-to-end verified**. A missing tile correctly returned 404; a successful tile response cannot yet be demonstrated from this deployment.

## Deployment resources

Existing resources were reused: Worker `earth-replay-api`; D1 `earth-replay` (`febe4577-968a-48dc-8cc4-e6136d8e965b`); KV `CACHE` (`8a8fcf0bbdbc4c499c7dcd7a0a0cab3a`); R2 `earth-replay-tiles`; queues `earth-replay-ingest` and `earth-replay-ingest-dlq`; Workflow `earth-replay-ingest`; ReplayRoom Durable Object; Vectorize `earth-replay-captions` (768 dimensions, cosine). Existing D1 tables/migration records were verified without resetting the database.

Completed setup: created AI Gateway `earth-replay`; created the Vectorize string metadata filter `eventId`; configured R2 object-create notifications for `manifests/*.json` to the ingest queue; enabled Worker traces; reconciled local account/D1/KV IDs with production. Existing queue consumers, Workflow, cron (`0 */6 * * *`), Durable Object namespace and Google secret were preserved. Manifest notification delivery has been configured, but its complete processor-to-caption path remains unverified without a processor-produced manifest.

## Credentials and common responses

Requests are JSON unless a tile or WebSocket is requested. Send `Content-Type: application/json` for POSTs. Only `POST /api/ingest` and `POST /api/events/earthquake` require client authentication: `Authorization: Bearer <INGEST_API_KEY>`. Never send the Earthdata token as that API key. Other current routes, including `/api/ask`, are public. CORS currently permits `*`; allowed-origin preflight was checked (204).

Deployed server-side secrets are `EARTHDATA_TOKEN`, `FIRMS_MAP_KEY`, `INGEST_API_KEY`, `PROCESSOR_TOKEN` and the preexisting `GOOGLE_MAPS_API_KEY`. Values are not stored in this reference or evidence. Local `.dev.vars` is ignored by Git. `PROCESSOR_TOKEN` does not make a processor exist; it authenticates future jobs sent to `PROCESSOR_URL`.

Common failures: 400 invalid input; 401 missing/invalid ingest key; 404 unknown resource, missing tile or absent forecast archive; 502 upstream/AI failure; 503 missing configured provider credential; 426 WebSocket upgrade required. Most API errors are `{error, message?}`; validation may return `{error:'invalid_request', details:[...]}`. The combined context route returns 200 even on individual source failures: inspect `partial` and each `results[source].ok`.

## Service and event catalog

### GET `/`

Requires no parameters or credentials. Returns `{service, routes[], credit}`. Live check: **200**, with the new dataset routes listed.

### GET `/api/events`

Requires no parameters. Reads D1 with a 60-second KV cache. Returns `{events:[{id,name,type,bbox,products,startDate,endDate,watch,sceneCount,...}],credit}`. Live check: **200** before and after verification events were registered.

### GET `/api/events/:id`

Requires a catalog event ID (letters, digits, hyphens or underscores, up to 128 characters). Returns `{event,scenes[],dates[],polarizations[],layers[],captions[],credit}`. A layer includes its date, bounds, units, zoom range and tile URL template. No layers are fabricated when processing has not run.

Live check: **200** for `verification-nisar-20261114`; **404** for an unknown event. The verification event has four cataloged GCOV scenes and no processed layers.

## Discovery

### GET `/api/discover/earthquakes`

Optional query: `minMagnitude` (4.5–9.9, default 6), `days` (1–365, default 30), `bbox=w,s,e,n` (at most 5° per side). Uses USGS, not NASA. No key is needed. Results are cached for ten minutes.

Returns `{earthquakes:[{sourceId,title,magnitude,time,latitude,longitude,depthKm,tsunami,alert,url,registered,suggested:{eventId,aoi,dateRange,products,...}}],credit}`. The suggested area is a heuristic around the epicenter, not a rupture model. Records predating NISAR launch are omitted.

Live check: **200** for `?days=30&minMagnitude=6`; supplied the real earthquake `us7000tx16` used to test registration.

### POST `/api/events/earthquake`

Requires the ingest API key and `{ "usgsId": "us7000tx16" }`. Fetches the actual USGS event, registers its AOI, then starts a GUNW ingest covering 36 days before through 60 days after the event, clipped to NISAR launch/today.

Returns **202** `{eventId,created,ingest:{id,eventId,status,dateRange,statusUrl}}`. Unknown USGS events return 404; invalid identifiers return 400; missing key returns 401. Live checks: **202** with authentication and **401** without it. Real verification event created: `usgs-us7000tx16`.

### GET `/api/nisar/search`

Required query: `bbox=w,s,e,n`, `start=YYYY-MM-DD`, `end=YYYY-MM-DD`. Optional `products=GCOV,GUNW,GOFF,SME2`; defaults to GCOV. Uses ASF catalog metadata, optionally authenticated with the server Earthdata token. It does not download measurement files or create an event.

Region ≤5° per side; date span ≤366 days; range must overlap the mission period and start no later than today. Returns `{query,count,byProduct,dates,polarizations,scenes[],truncated,credit}`. Default scene cap is 25; `truncated` indicates the cap was reached.

Live check: **200**, four GCOV records for bbox `-119,35,-118,36`, October 21–November 14, 2026.

### GET `/api/geocode`

Required query: `q` (2–200 characters). Requires the server's Google Maps Geocoding key; no client key. Returns `{query,formattedAddress,location:{lat,lng},bbox,aoi,credit}`; `aoi` is capped at 5° per side. 404 means no match; 503 means no key configured; 502 means provider failure.

Live check: **200** for `?q=California`, returning `California, USA` and a bounded AOI.

## Ingestion

### POST `/api/ingest`

Requires the ingest API key. Example:

```json
{
  "eventId": "verification-nisar-20261114",
  "name": "Deployment verification: California NISAR coverage",
  "type": "other",
  "aoi": [-119, 35, -118, 36],
  "dateRange": { "start": "2026-10-25", "end": "2026-10-26" },
  "products": ["GCOV"],
  "watch": false
}
```

Required: `aoi` (bbox or closed GeoJSON Polygon) and `dateRange`. Optional: `eventId` (3–64 lowercase letters/digits/hyphens/underscores), `name` (1–120 chars), `description` (≤1000 chars), `type`, `products`, `watch` (boolean, default false).

Accepted types: `earthquake`, `flood`, `wetland`, `forest`, `crop`, `glacier`, `soil_moisture`, `other`. There is no literal `wildfire` type yet; use `forest` or `other` for a fire study. Default products: earthquake→GUNW, glacier→GOFF, soil_moisture→SME2, all others→GCOV. Region/date bounds match NISAR search. If an existing event ID is supplied, its stored AOI/products are reused; this route does not edit that event's configuration.

Returns **202** `{id,eventId,status:'queued',dateRange,statusUrl}`. This means a Workflow was started, not that radar processing finished. Live checks: **202** valid authenticated request; **401** unauthenticated; **400** empty authenticated body.

### GET `/api/ingest/:id`

Requires the ingest ID returned above, no client key. Returns `{id,eventId,dateRange,trigger,status,sceneCount,error,workflow:{status,error},progress:{total,...statusCounts},scenes:[{id,product,acquiredAt,status,error,url}],credit}`. Unknown IDs return 404.

Live check: **200** for `ing_23e02aca-90df-483c-b008-3a91f2d28d69`. Final observed state: Workflow `complete`, ingest `dispatched`, four scenes `awaiting_processor`. These are separate lifecycle states: orchestration completed, processing did not. **404** verified for an unknown ingest.

## Map tiles

### GET `/tiles/:event/:layer/:date/:z/:x/:y.png`

Requires an existing R2 tile at `tiles/{event}/{layer}/{YYYY-MM-DD}/{z}/{x}/{y}.png`. Layer IDs use lowercase letters/digits/hyphens/underscores. Zoom is 0–22 and x/y must be in the zoom's valid range. Successful output is PNG bytes with ETag, cache headers and data credit; `If-None-Match` can produce 304.

Live check: **404** for an absent verification tile. The successful PNG/304 paths have automated tests, but are not verified against a real processed tile in production. Processor-generated tiles are still required.

## AI explanations

### POST `/api/ask`

Body: `{ "eventId": "verification-nisar-20261114", "question": "What measured surface change has been established for this event?" }`. Question length: 3–500 chars. No client key is currently required. Depends on D1, Vectorize, Workers AI, AI Gateway and KV.

Returns `{eventId,question,answer,sources:[{captionId,sceneId,score}],sceneCount,model,aiGenerated:true,disclaimer,credit}`. Answers are cached for one hour. Interpretations are hypotheses, not forecasts or verified measurements. Missing event returns 404; invalid body 400; AI failure 502.

Live checks: **200**, with the model correctly stating that measured surface change had not been established; **400** for an empty body. This verifies inference and retrieval with an empty caption context, not scientific caption quality on processed scenes.

## Supplementary NASA data

### GET `/api/datasets`

No parameters. Returns `{sources:[{id,name,kind,credit,notes,configured,requiredSecret?,shortNames?,...}]}`. Credential values are never returned. `configured` indicates required credential presence, not provider health. Live check: **200**, seven source entries.

### GET `/api/datasets/:source`

Required query: `bbox=w,s,e,n`, `start`, `end`. Optional: `limit` (1–50, default 10), `page` (1–10000, default 1); GEOS `runDate` (default start), `cycle` (00/06/12/18, default 00). Dates are independent of NISAR launch. Region ≤5° per side, date span ≤366 days. FIRMS additionally limits the range to five inclusive days.

Returns `{source,name,kind,query,credit,notes,measurementsRetrieved,items[],count,total,nextPage,truncated,...}`. Continue with `page=nextPage` to retrieve more results. Large rasters are not downloaded by this API.

| Source / live path | What it needs | Items returned | Live result |
| --- | --- | --- | --- |
| `/api/datasets/firms` | Separate server `FIRMS_MAP_KEY`; dates available from NOAA-20 NRT | `{latitude,longitude,acquiredAt,confidence,frpMW,satellite,daynight,instrument}`; `measurementsRetrieved:true` | **200**, zero rows for California and a second Brazil region on Nov 13–14; nonempty detections remain unverified live |
| `/api/datasets/gpm` | Public CMR discovery; Earthdata Login later for files | Daily IMERG precipitation granule metadata/download references | **200**, 2 of 5 matching records |
| `/api/datasets/smap` | Public CMR discovery; processor for HDF5 and quality masks | Daily soil-moisture granule metadata/download references | **200**, 2 of 5 |
| `/api/datasets/hls` | Public CMR discovery; processor for bands/cloud masks | Landsat and Sentinel-2 HLS metadata/download references | **200**, 2 of 10 |
| `/api/datasets/geos` | Public NCCS archive; `runDate`/`cycle`; retained initialization must exist | Global NetCDF URLs with initialization and forecast-valid times | **200**, 2 of 48 matching files |
| `/api/datasets/terrain` | Public CMR discovery; dates ignored for static NASADEM | Intersecting elevation granule metadata/download references | **200**, 2 of 9 |
| `/api/datasets/grace` | Public CMR discovery; processor to slice multi-month series | JPL mascon granule metadata/download references | **200**, 1 of 1 |

Historical CMR checks used bbox `-119,35,-118,36`, July 1–5, 2025, `limit=2`. GEOS used the same bbox, Nov 13–14, 2026, initialized Nov 13 at 00 UTC. CMR returns overlapping granules, not cropped pixels. GEOS files are global and `spatialSubsetApplied:false`. Soil moisture is not direct fuel moisture; GRACE is regional total water-storage context, not a parcel-scale aquifer measurement.

CMR item fields: `{id,title,start,end,collectionId,sizeMB,boxes,polygons,downloads[]}`. GEOS item fields: `{id,url,initializedAt,validAt,coverage:'global'}`. Catalog results explicitly use `measurementsRetrieved:false`. Missing forecast archive returns 404; provider/time/size errors return 502. Stream limits are 2 MB, or 4 MB for GEOS; timeout is ten seconds. Invalid query was checked (**400**).

### GET `/api/datasets/context`

Same common parameters plus optional `sources=gpm,smap,hls,terrain,grace` (default all seven). Returns `{query,partial,results:{source:{ok:true,result}|{ok:false,error,message,retryable}}}`. Each successful `result` has the individual source schema above.

Live check: **200**, `partial:false` for the five-source historical query, with records from every source. Failures are isolated and must be inspected even when HTTP status is 200; automated tests cover this partial-failure path.

## Shared replay

### WebSocket `/api/room/:code`

Use `wss://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev/api/room/VERIFY26`. Code: 4–12 alphanumeric characters, case-insensitive. No client key required. An ordinary HTTP request returns 426; invalid codes return 400.

On connection the server sends `{type:'state',state:{eventId,layer,frame,playing,speed,updatedAt,version},serverTime}` and presence updates. Client messages: `load {eventId,layer?}`, `play`, `pause {frame?}`, `seek {frame}`, `speed {speed}`, `layer {layer}`, `sync`, `ping`. Send them with a `type` property. Playback speed is 0.25–8. Server messages are `state`, `presence {count}`, `pong`, or `error {error}`. This synchronizes playback state; it does not generate scenes or animations.

Live checks: **101** connection upgrade and initial state, cross-client `load` broadcast, and ping/pong succeeded. HTTP 426 and invalid-code 400 also verified. Verification room `VERIFY26` references the real verification event; empty-room storage expires through its alarm.

## Remaining operational limits

- External measurement processor is absent; no generated tiles or calculated changes yet.
- No hazard prediction model, training/evaluation pipeline or global archive ingestion exists.
- Supplemental endpoints return results without persisting them to D1/R2 or automatically enriching AI prompts.
- Public inference and dataset routes currently have no application-specific authentication/rate limiter; the Gateway has a 100-request/60-second limit for AI traffic. Review public exposure before broad launch.
- Local config preserves the existing `2026-08-15` compatibility date used by the test runtime.
- Python urllib's default user agent received Cloudflare error 1010 in this environment; verification succeeded using a standard browser user agent. No security rules were disabled.
- Two explicitly named real verification events were created for the endpoint checks; they have `watch:false` and make no scientific event-classification claims beyond the USGS source metadata.
