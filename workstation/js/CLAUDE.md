# CLAUDE.md — workstation/js

Behaviour for the workstation: native ES modules, vanilla JS, no framework, no bundler, no npm. MapLibre is a global (`window.maplibregl`) loaded by a classic CDN script in `../index.html`. See `spec.md` here for every module's contract. Read `../HANDOFF.md` §3 first, because most of the safeguards are enforced here.

## Modules
| File | Role | May import |
| --- | --- | --- |
| `config.js` | `CONFIG` and `HAZARD_REGISTRY`. Pure data plus tiny pure helpers. No DOM. | nothing |
| `telemetry.js` | `TelemetryService`: timelines, procedural rasters, external PNG loading, pixel sampling, change images. No DOM except offscreen canvases. | `config.js` |
| `charts.js` | Pure functions that return SVG strings or elements for the two charts. No global state. | nothing |
| `map.js` | Creates the MapLibre map, styles the basemap, owns all sources and layers, and exposes `applyMapState(view)`. | `config.js` |
| `api.js` | Earth Replay API client (`api.*`, `probe()`, `ApiError`). Relative `/api` paths through the `dev-server.mjs` proxy. No DOM. | nothing |
| `explore.js` | Pure helpers for the LIVE channel: `liveTimeline()`, date ranges, areas, outlook box, labels. No DOM. | nothing |
| `browse.js` | `loadBrowseImage()`: places an ASF browse preview on its footprint (offscreen canvas only). | nothing |
| `room.js` | `RoomClient`: the replay-room WebSocket (`/api/room/:code`). No DOM. | nothing |
| `liveMap.js` | Live map sources/layers and the idempotent `applyLiveMap(map, lv)`; outlook hit-testing. | `map.js` |
| `simulate.js` | The live "Simulated illustration": builds a demo-shaped hazard for a live event's box (model by event type, or `#live-sim-model`), its FABRICATED frames (`telemetry.procedural`) and box-scaled extents. | `config.js`, `telemetry.js` |
| `live.js` | Renders the live evidence blocks from plain data (`textContent` only, signature-keyed rebuilds). | `explore.js` |
| `main.js` | Entry point. DOM refs, the single `state`, `render()`, events, play timer, router, dialogs. | all of the above |

Dependencies point toward the leaf modules. No module imports `main.js`.

## The LIVE channel (04 // LIVE NISAR)
- `state.source` is `'demo'` (channels 01–03, synthetic) or `'live'` (Earth Replay API). `render()` = `renderCommon()` + `renderDemo()` or `renderLive()`; both share `renderTimeline()`.
- Live state lives in `state.live`; async results are stamped status objects (`st()`), so `live.js` rebuilds a block only when its data changed.
- **The live timeline holds NISAR pass dates only** (`data-forecasts="none"`, never `data-mode="forecast"`). Modelled output (`/predict`, `/outlook`) is never a timeline step: it appears only in `.model-card` blocks and as hatched, dashed, pale-sky outlook cells, always labelled MODELLED with the backend's disclaimer.
- ASF browse previews are real acquisitions but **quicklooks, not calibrated measurements**; `#provenance-live` says so and replaces the synthetic strip on this channel only.
- Entering live calls `hideDemoLayers(map)`; returning to a demo channel re-applies every demo layer through `applyMapState`. The demo forecast locks are untouched.
- **Simulated illustration** (`state.live.sim`, off by default): `renderLive()` feeds `applyMapState` a view built from `simHazardFor(event, steps, state.live.simModel)` so the demo raster, extents and footprint draw on the event box; real previews/tiles are hidden meanwhile. It must always show `#sim-badge` + `#provenance-sim` and the `// SIMULATED ILLUSTRATION` pill. Models: `volcano`, `flood` (sar), `quake` (interferogram), `tsunami` (ssha); `auto` picks from the event type/name. Not shared in replay rooms.
- Image layers in `map.js` must not use `'raster-resampling': 'nearest'`: with MapLibre 4.7.1 it rendered the demo radar as a black square in Chrome.
- Room sync: only explicit user actions (seek, play/pause, choosing an event) are sent; remote state is applied without echo. Search replays are not shared.

## The rules that matter most
- **One state object, one `render()`.** Every event handler mutates `state` and then calls `render()`. `render()` derives everything, including `isForecast = state.idx >= observed.length`. Nothing else toggles UI.
- **Forecast locks live in one place.** `render()` applies all seven locks from `HANDOFF.md` §3 together. Never apply only some of them, and never leave one to a CSS-only rule that JS state could contradict.
- **Forecast never writes observed state.** `state.mode`, `state.observedOpacity` and `state.baseline` are read but never assigned in forecast branches. The effective values are computed (`effectiveOpacity = isForecast ? 0.35 : state.observedOpacity / 100`).
- **No synthetic substitution.** If an external image or the backend fails, show `#asset-error` / `#map-error` and hide the raster. Never fall back to generated data.
- **No fabricated future values.** The point series has exactly `observed.length` entries. Don't extrapolate or interpolate past NOW.
- **Determinism.** Rasters come from seeded PRNGs. Same hazard and date gives byte-identical pixels. Speckle uses a fixed seed shared across passes.
- **No credentials anywhere.** Sign-in is Auth0's hosted page: `#signin-form` / `#signup-form` are plain GET navigations to `/auth/login` with no credential fields. JS only reads the session via `GET /api/auth/me` (name/email for display) and never stores tokens; the HttpOnly session cookie is the backend's.
- **Styling stays in CSS.** JS sets attributes (`data-*`, `hidden`, `disabled`, `aria-*`) and text. The only inline style properties allowed are the custom properties `--p` (prob bar) and `--obs` / `--fc` (track widths).
- Build text with `textContent`. Use `innerHTML` only for SVG strings that `charts.js` builds from numbers and constant labels.
- **Config override for tests:** `config.js` merges `window.SPACEAPP_CONFIG` (if present) over the defaults, so `<script>window.SPACEAPP_CONFIG={forecasts:[]}</script>` placed before the module disables forecasts.

## Verify
- `node --check` on every file.
- The ID cross-check from `HANDOFF.md` §7.
- In the browser, step the slider from 5 to 6 and back, play through the wrap, switch hazards, and toggle risk. The console shows no errors and no credential output.
- Live channel: switch to 04, confirm an event's ASF previews draw per pass, open the outlook (hatched cells, MODELLED card), click the map (area explorer), then switch back to 01 and re-check the forecast locks.
