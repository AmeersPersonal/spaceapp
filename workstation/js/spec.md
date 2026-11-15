# spec.md — workstation/js

## 1. `config.js`
```js
const DEFAULTS = {
  useExternalImages: false,          // true → load PNGs from externalImagePath; failures show #asset-error, no fallback
  useLiveBackend: false,             // true → fetch timelines from backendUrl; failures show #map-error, no fallback
  backendUrl: '/api/v1/hazards/{id}/timeline',
  externalImagePath: './data/aso/{date}.png',
  basemapStyle: 'https://tiles.openfreemap.org/styles/liberty',
  bounds: { west: 130.98, south: 32.79, east: 131.23, north: 32.97 }, // APPROXIMATE demo box for volcano
  forecasts: undefined,              // undefined → use registry; [] → no forecast dates for every hazard
  defaultHazard: 'volcano',
  playIntervalMs: 1000,
  forecastOpacity: 0.35,             // locked; documented here so it is visible, never user-adjustable
  levelThresholds: { medium: 0.35, high: 0.6 }, // DEMONSTRATION ONLY, not official categories
};
export const CONFIG = { ...DEFAULTS, ...(window.SPACEAPP_CONFIG ?? {}) };
```

- `HAZARD_REGISTRY`, exported. It has the three entries below, each with every field listed.
- Exported helpers:
  - `getHazard(id)`
  - `timelineOf(hazard)`: returns `[...observed.map(kind:'observed'), ...forecast.map(kind:'forecast')]` and honours `CONFIG.forecasts`
  - `levelFor(p)`
  - `footprintKm(bounds)`: W×H using `111.32·cos(lat)` and `110.57`

| Field | volcano | earthquake | tsunami |
| --- | --- | --- | --- |
| `id` | `volcano` | `earthquake` | `tsunami` |
| `code` | `NISAR-L // VOLCANIC SAR` | `ALOS-4 / USGS-SIM // SEISMIC INSAR` | `SWOT / DART-SIM // TSUNAMI ALTIMETRY` |
| `channelLabel` | `01 // VOLCANIC SAR` | `02 // SEISMIC FAULT` | `03 // TSUNAMI PROPAGATION` |
| `targetName` | `ASO CALDERA, KUMAMOTO, JP` | `HYUGANADA SUBDUCTION ZONE, JP` | `BUNGO CHANNEL & MIYAZAKI COAST, JP` |
| `coords` [lng,lat] | `[131.104, 32.884]` | `[131.850, 32.150]` | `[132.100, 32.600]` |
| `zoom` | 11.4 | 8.5 | 8.2 |
| `bounds` | `CONFIG.bounds` | ≈ `{130.9, 31.5, 132.8, 32.8}` | ≈ `{131.4, 31.9, 132.8, 33.3}` |
| `primaryMetricLabel` | `Eruption / Unrest Probability` | `M6.0+ Aftershock Probability` | `Coastal Inundation Exceedance (>1m)` |
| `pointSeriesLabel` | `Brightness at a point` | `Line-of-Sight (LOS) Ground Displacement` | `Sea-Surface Height Anomaly` |
| `pointUnit` | `display intensity (synthetic, uncalibrated)` | `cm (synthetic, illustrative)` | `cm (synthetic, illustrative)` |
| `pointNoun` (for "No future … values — ever.") | `pixel brightness` | `displacement` | `sea-surface height` |
| `changeLabels` | darker / brighter than baseline | subsidence / uplift | drawdown / crest elevation |
| `riskLabels` | high / medium hazard extent | MMI VII+ / MMI V–VI | run-up high / moderate |
| `raster` | `'sar'` | `'interferogram'` | `'ssha'` |

- Every hazard shares the same 6 observed and 4 forecast **dates**.
- `observed[i]` is `{ date, risk }`. The volcano risk values are something like `.12, .16, .22, .29, .37, .44`.
- `forecast[i]` is `{ date, probability, driver }`. Volcano probabilities are `.48, .62, .81, .57`. `level` is derived via `levelFor` and is never stored.
- Drivers are one sentence each, clearly simulated, for example `Simulated driver: continued caldera-floor darkening near Nakadake.`
- Seismic uses Omori-style decaying probabilities. Tsunami uses a peak then decay.
- `riskExtents(kind, idx)` is a pure function returning a GeoJSON FeatureCollection of schematic polygons, with `properties.risk = 'high' | 'medium'` and `properties.schematic = true`.
  - Volcano: two irregular rings (deterministic, seeded per date) around the vent that grow slightly over the observed passes and follow the forecast probability.
  - Earthquake: two concentric MMI contours around the epicentre plus a `LineString` fault trace (`properties.kind='fault'`).
  - Tsunami: coastal run-up segments plus wave-arrival arcs (`properties.kind='arrival'`).
  - Coordinates are lng/lat.

## 2. `telemetry.js`
```js
export class TelemetryService {
  constructor(config, registry)
  async getTimeline(hazardId)                     // registry, or fetch(backendUrl) when useLiveBackend; throws on failure
  async getRaster(hazardId, dateIndex)            // → { canvas, imageData, url, source:'procedural'|'external' }; cached by `${hazard}|${date}`; throws on failure
  sample(imageData, bounds, lng, lat)             // → 0..1 or null if outside bounds
  changeImage(baseData, currentData, isSame)      // → data URL; isSame → fully transparent canvas
}
```

### Procedural rasters (512×512, greyscale written to RGBA, alpha 255)
Shared tools:
- `mulberry32(seed)`
- 2D value noise with smoothstep interpolation
- `fbm(x, y, octaves)`
- a speckle field `S`: a per-pixel gamma-ish multiplier from `mulberry32(SPECKLE_SEED)`, mean 1, about 4-look, **generated once and reused for every pass of a hazard**

| Generator | Static part (identical every pass) | Per-pass change |
| --- | --- | --- |
| `sar` (volcano) | fbm terrain; elliptical somma rim (≈ 18 × 25 km in the pixel space of the bounds) with asymmetric brightness: slopes facing the sensor (west look) are brighter and slopes facing away darker; dark smooth caldera floor; bright Nakadake cone cluster just east of centre | A darkening ash lobe from the vent toward the NE, radius growing with pass index (≈ 0.8 to 3.8 km), irregular fbm edge; plus a slight roughening ring at the crater rim from pass 3 |
| `interferogram` (earthquake) | fbm terrain and coherence mask | Wrapped-phase fringes `0.5+0.5·cos(k·d(x,y))` around a fault trace. The fringe count steps up at pass 3 (coseismic) and then creeps |
| `ssha` (tsunami) | Land mask (coast polygon from approximate lng/lat vertices); land drawn as a dim texture | An offshore band with a crest/trough sinusoid whose phase advances with pass index toward the coast |

Pixel value is `clamp(static ⊕ change) × S`, quantised to 0–255.

### External images
- Used when `useExternalImages` is true. `img.crossOrigin='anonymous'`, draw to canvas, `getImageData`.
- `onerror` throws `Error('Could not load <url>')`. The caller shows `#asset-error` and hides the raster. Nothing synthetic is ever substituted.

### Change image
- 3×3 box blur on both inputs, then per-pixel `d = cur − base`.
- `|d| < 18` (out of 255) gives transparent.
- `d < 0` gives RGB(43,131,255); `d > 0` gives RGB(255,140,40). Alpha is `min(255, 70 + |d|·2.2)`.
- Output is at full resolution (no block cells).
- `isSame` short-circuits to a transparent canvas.

## 3. `charts.js`
```js
export function plotFrame({ id, width=300, height=130, n, nowIndex, hasForecast, yDomain=[0,1], title, desc })
  // → { open, close, x(i), y(v), pad }  open/close are SVG string fragments
export function riskChart({ timeline, activeIndex, label })   // → SVG string
export function pointChart({ values, timeline, activeIndex, label, unit, noun }) // → SVG string
```

- **Frame:** `viewBox 0 0 300 130`, padding `{l:30, r:8, t:10, b:20}`.
  - Three horizontal grid lines with axis ticks: `0`, `.5`, `1`, or domain-scaled.
  - First and last date labels.
  - `<title>` and `<desc>`. The desc is generated text, for example "Risk rises from 0.12 to 0.44 over six sample passes; model projects 0.48–0.81".
- **NOW:** if `hasForecast`, NOW sits at `x(nowIndex + 0.5)`. A `<pattern id="hatch-<id>">` at 45° fills a rect from NOW to the right edge. A vertical NOW line carries the label `NOW`.
- **Risk:**
  - solid `.chart-line` through the observed risk values
  - `.chart-line--model` from the last observed point through the forecast probabilities
  - a dot per point carrying `data-index`
  - active point: `.chart-dot--active` (circle) if observed, otherwise `.chart-diamond--active` (a rotated square)
- **Point:**
  - `values.length === observed count` (asserted; it throws in dev if not)
  - solid line and dots, active dot when `activeIndex` is observed
  - if `hasForecast`, `No data yet` is centred in the hatch
  - no forecast points are ever drawn
- With `n === 1` or no values, the frame shows a centred `.chart-empty` message instead of lines.
- Clicks: `main.js` delegates clicks on `[data-index]` and sets `state.idx`.

## 4. `map.js`
```js
export function createMap(container, { style, hazard, padding, onClick, onError }) // → map | throws
export function styleBasemap(map)        // recolour vector paint to obsidian palette
export function applyMapState(map, view) // idempotent; view = derived render output (§5)
```
- **Guard:** if `typeof maplibregl === 'undefined'`, throw `Error('Map library failed to load')`.
- **Options:**
  - `pitch:0, bearing:0, maxPitch:0, dragRotate:false, pitchWithRotate:false`
  - after creation: `touchZoomRotate.disableRotation()`, `keyboard.disableRotation()`
  - `NavigationControl({ showCompass:false })` top-right
  - `AttributionControl({ compact:false })`
- **Camera:** `fitBounds(hazard.bounds, { padding:{ top:72, bottom:108, left:324, right:384 } })` on desktop and `{ top:64, bottom:96, left:16, right:16 }` on mobile. Recompute on resize and on hazard switch (`fitBounds` with `duration:600`).
- **`styleBasemap`:** for each style layer:
  - `background` → `#07090E`
  - `fill` without `fill-pattern` → water `#0A1220`, land/landuse `#0C1016`
  - `line` → `rgba(235,245,238,.10)` (roads `.14`)
  - `symbol` text → `#9FB0C4` with halo `#07090E`
  - skip raster, hillshade and pattern layers
  - wrap each `setPaintProperty` in try/catch
- **Sources and layers (bottom to top):**
  - `raster` (image source with the hazard's bounds corners [NW, NE, SE, SW]; raster layer, `raster-fade-duration:0`)
  - `change` (image source, raster layer)
  - `risk-fill` (`fill-opacity .14`, colour by `risk` match)
  - `risk-line` (`line-width 1.5`, colour by `risk` match)
  - `fault-line`
  - `footprint-frame` (line around bounds, `rgba(235,245,238,.32)`)
  - `footprint-ticks` (short `+` line segments at the four corners)
  - `compound-seismic`, `compound-tsunami` (lines; visible only when compound is on and they aren't the active hazard)
- **`applyMapState(view)`:**
  - updates the raster image URL and coordinates
  - `raster` visibility follows `view.rasterVisible`, and `raster-opacity` is set to `view.rasterOpacity` (exactly `0.35` in forecast)
  - `change` is visible only when `view.showChange` (always false in forecast)
  - sets risk data via `setData(view.riskGeojson)`
  - visibility of `risk-*` follows `view.showRisk`
  - `risk-line` `line-dasharray` is `[2,2]` in forecast and `[1,0]` in observed
  - compound visibility
  - reticle marker position and visibility (HTML `maplibregl.Marker` with element `.reticle-marker`)
- **Errors:** `map.on('error', e)` calls `onError(message)`. `main.js` shows it in `#map-error`. Image source errors also hide the raster.
- **Click:** reports `{lng, lat}` to `onClick`. `main.js` decides between inside and outside bounds.

## 4b. `api.js` — Earth Replay API client
- No DOM, imports nothing. Relative paths (`/api/...`, `/auth/...`), so it only works when served by `dev-server.mjs`, which proxies `/api`, `/auth`, `/tiles` and the `/api/room/:code` WebSocket to `API_TARGET` (default `http://localhost:8787`, the backend's `wrangler dev`).
- `request()` sends `credentials: 'include'` and throws `ApiError(status, code, message)` on any failure: `network` (proxy 502 / fetch failed), `no_proxy` (404 without JSON from a plain static server), or the Worker's own `{error, message}`. It never substitutes data.
- `api.*` mirrors `Frontend/src/api.js` (ported, not imported): `me`, `events`, `event`, `context`, `nisarSearch`, `quakes`, `datasetContext`, `trackArea`, `ingestStatus`, `trackQuake`, `outlook`, `predict`, `media`, `summary`, `ask`, `chats`, `createChat`, `chatMessages`. Endpoint contracts: `../../backend/CLAUDE.md` and `backend/cloudefare/SPEC.md`.
- `probe()` → `{online:true, eventCount, events, user|null, auth:'signed-in'|'signed-out'|'unavailable', authMessage}` or `{online:false, error}`; never throws.

## 4c. LIVE channel modules
- `explore.js` — `liveTimeline(detail, layer)` → `{mode:'tiles'|'preview'|'area', steps[{date,kind:'observed',index,tile,scenes}], layers}`: one step per processed-tile date (when a processed layer is chosen) or per acquisition day with a browse preview. Every step is an observation; there are no forecast steps. Also `lastMonths`, `setRangeEnd` (launch 2025-07-30, ≤ 366 days), `areaAround` (1° box), `unionBounds`, `outlookBoxFrom` (sides clamped 1–60°), `percent` (never 0%/100%), `formatDay`, `statusLabel`, `layerLabel`.
- `browse.js` — `loadBrowseImage(url, bounds)` → `{url: objectURL, coordinates}` by locating the PNG's data area and stretching it onto the footprint (Mercator latitude).
- `room.js` — `RoomClient({onStatus, onState, onPresence, onError})`, `connect(code)`, `send(msg)`, `close()`; pings every 25 s.
- `liveMap.js` — `addLiveLayers(map)` once after style load; `applyLiveMap(map, {active, aoi, probe, outlookOn, cells, selectedCell, images, tiles, opacity})` idempotently; `outlookCellAt(map, point)`; `fitBox`. Layers: `live-tiles`, `live-scene-<n>`, `live-outlook-fill` (pattern `live-hatch`), `live-outlook-line` (dashed), `live-aoi-line` (dashed pale sky), `live-probe-line` (dotted mint).
- `live.js` — `renderEventHead`, `renderProjection`, `renderBriefing`, `renderAskLog`, `renderContext`, `renderMedia`, `renderScenes`, `renderArea`, `renderOutlook`, and the `h()` builder. Buttons carry `data-action`/`data-id`/`data-cell`; `main.js` delegates.
- `map.js` additions — `hideDemoLayers(map)` (hides every synthetic layer and the reticle and forgets applied state), `paddingFor`, `labelStackStartId` exported; map clicks now report the screen `point` too.
- `loginUrl`, `signupUrl`, `logoutUrl` are page navigations (Auth0 redirects back to `FRONTEND_URL`, i.e. `:5173`).
- Console: `window.__spaceapp.api` and `window.__spaceapp.probe`.

## 5. `main.js`
### State
```js
const state = {
  hazard: CONFIG.defaultHazard, idx: null /* set to last observed on load/switch */,
  mode: 'radar', baseline: 0, observedOpacity: 85,
  showRisk: true, showReticle: true, compound: false,
  point: null /* {lng,lat} | {outside:true} | null */, playing: false,
  route: 'home', errors: { map: '', asset: '', backend: '' }, // map + backend are joined into #map-error
  api: { status: 'checking' | 'online' | 'offline', eventCount, user, auth, authMessage, error }, // Earth Replay API link + session
  source: 'demo' | 'live',
  live: { events, eventId, detail, replay, idx, pendingFrame, layer, panel: 'event'|'area'|'outlook', area, range, results,
          busy, notice, actionError, predict, brief, context, media, ask, outlookOn, horizon, outlookBox, outlook, cell, room },
};
```

### `deriveView(state)`, a pure function returning everything `render()` and `applyMapState()` need
- `timeline`, `observedCount`, `isForecast`, `step`, `hasForecast`.
- `imageIndex`: `isForecast ? observedCount - 1 : idx`.
- `rasterOpacity`: `isForecast ? CONFIG.forecastOpacity : state.observedOpacity / 100`.
- `rasterVisible`: `!state.errors.asset`.
- `showChange`: `!isForecast && state.mode === 'change'`.
- `riskGeojson`: `hazard.riskExtents(step.kind, idx)`.
- `showRisk`: `state.showRisk`.
- `level`, `probability`, `driver` (forecast only).
- `series`: an array of `observedCount` samples, or `null`.
- `pointStatus` text.

### `render()`, called after every state change
1. Root attributes: `data-mode`, `data-hazard`, `data-route`, `data-forecasts`.
2. Top bar: hazard radio checked, target name, coords, footprint (`footprintKm`), mode-pill text.
3. Controls:
   - `#pass-date`, and `#pass-index` (`PASS 06 / 06` observed, `FORECAST 01 / 04` forecast)
   - `#no-pass-alert.hidden = !isForecast`
   - `#btn-radar` and `#btn-change`: `disabled = isForecast` (change is also disabled while rasters load), `aria-pressed` from `state.mode`
   - `#baseline-wrap.hidden = isForecast || state.mode !== 'change'`
   - `#opacity`: `disabled = isForecast`. Its value is 35 when forecast and `state.observedOpacity` otherwise, and it **never writes back** to state while forecast. `#opacity-readout` reads `35%` or `${observedOpacity}%`, and `#opacity-lock.hidden = !isForecast`.
   - Legend variant visibility. `#legend-risk.hidden = !showRisk`, with li text suffixed `(projected extent, dashed)` or `(measured extent)`.
4. Evidence:
   - `#observed-card` / `#forecast-card` visibility
   - forecast fields; `#forecast-level` gets `data-level`; `#forecast-bar` gets `--p`
   - `#chart-risk.innerHTML = riskChart(...)`, `#chart-point.innerHTML = pointChart(...)`
   - `#point-title`, `#point-coords`, `#point-status`
   - errors: `#map-error` / `#asset-error` text and hidden state
   - `#backend-status` text and `data-state` from `state.api`. Online text always ends `// MAP DATA ABOVE IS NOT FROM IT` until the map is actually fed from the API.
5. Timeline:
   - `#date-slider` gets value, `max` and `aria-valuetext`
   - `#track` gets `--obs` and `--fc`
   - tick buttons: `aria-current` on the active one
   - `#timeline-date` text, prefixed `FORECAST · ` when forecast
   - `#play` gets `aria-label` and its icon
6. `applyMapState(map, view)` if the map exists.
7. Announce `Forecast, 2 Jul 2026` or `Observed sample pass, 20 Jun 2026` in `#announcer`, only when the `idx` or `hazard` changed.

### Events
- Slider `input` and tick click: `playing=false`, set `idx`.
- Play: toggles a `setInterval(CONFIG.playIntervalMs)` that does `idx=(idx+1)%len`. It clears on pause, route change and hazard switch.
- Mode buttons set `mode`. Baseline `change` sets `baseline`. Opacity `input` sets `observedOpacity` (the handler ignores input while forecast). Checkboxes set their flags.
- Hazard radio: `hazard=…`, `idx=last observed`, `point=null`, `mode='radar'`, `baseline=0`, clears the errors, preloads rasters, refits the camera.
- Map click: inside the hazard bounds, set `point={lng,lat}` and sample all observed rasters. Outside, set `point={outside:true}` and show `Outside radar footprint — no coverage`.
- Rasters: on hazard load, `Promise.all` over the observed passes through `TelemetryService.getRaster`. If any fails, set `errors.asset` (which hides the raster) and do **not** substitute.
- Change URLs are cached per `hazard|baseline|idx`.

### Router (`hashchange` and on load)
| Hash | Route | Behaviour |
| --- | --- | --- |
| `''`, `#`, `#/` | home | `#page.hidden = true` |
| `#/signin` | signin | Auth0 hand-off: the form GETs `/auth/login`; shows the session status, or "Signed in as …" + Sign out |
| `#/signup` | signup | same, with `screen_hint=signup` |
| `#<id>` of an existing element (e.g. the skip link's `#controls`) | home | focus that element; an in-page anchor is not a page |
| anything else | notfound | show `#notfound` |

Leaving a route resets its form. Focus moves to the route's first heading or input.

### Dialogs
- `#open-method` / `#open-about` call `showModal()`. `.dialog-close` calls `close()`. Escape closes natively.
- Focus returns to the opener on `close`.

### Boot
1. Create a `TelemetryService`.
2. `try { map = createMap(...) } catch { errors.map = message }`.
3. On map `load`: run `styleBasemap`, add the layers, then `render()`.
4. Load the rasters. Then `probe()` the Earth Replay API (non-blocking) and store the result in `state.api`. If `localStorage['spaceapp.source']` is `'live'` (e.g. returning from Auth0, which always lands on `/`), enter the live channel. On map `load`, `addLiveLayers(map)` too.
5. Route.
6. Collapse the drawers if `matchMedia('(max-width:900px)')` matches.
7. Run the first `render()` immediately, so the UI works without the map.

## 6. Error copy
- Map library missing: `Map unavailable: the map library failed to load. Controls and evidence still work.`
- Style or tiles: `Map tiles failed to load (<status or message>). The radar overlay and charts are unaffected.`
- Image: `Could not load <url>. The raster is hidden; no synthetic image has been substituted.`
- Backend: `Live backend unavailable (<message>). No data shown; mock data is not substituted.`

## 7. Failure matrix
| Failure | Visible result | Must not happen |
| --- | --- | --- |
| `maplibregl` undefined or constructor throws | `#map-error`; docks, charts and timeline work | blank page, uncaught error |
| style or tile error | `#map-error` | silent grey map |
| external PNG fails | `#asset-error`, raster hidden, point chart shows the error state | procedural image shown in its place |
| backend fails | `#map-error`, no timeline data rendered | registry mock shown as live |
