# CLAUDE.md — workstation/js

Behaviour for the workstation: native ES modules, vanilla JS, no framework, no bundler, no npm. MapLibre is a global (`window.maplibregl`) loaded by a classic CDN script in `../index.html`. See `spec.md` here for every module's contract. Read `../HANDOFF.md` §3 first, because most of the safeguards are enforced here.

## Modules
| File | Role | May import |
| --- | --- | --- |
| `config.js` | `CONFIG` and `HAZARD_REGISTRY`. Pure data plus tiny pure helpers. No DOM. | nothing |
| `telemetry.js` | `TelemetryService`: timelines, procedural rasters, external PNG loading, pixel sampling, change images. No DOM except offscreen canvases. | `config.js` |
| `charts.js` | Pure functions that return SVG strings or elements for the two charts. No global state. | nothing |
| `map.js` | Creates the MapLibre map, styles the basemap, owns all sources and layers, and exposes `applyMapState(view)`. | `config.js` |
| `main.js` | Entry point. DOM refs, the single `state`, `render()`, events, play timer, router, dialogs. | all of the above |

Dependencies point only toward `config.js`. No module imports `main.js`.

## The rules that matter most
- **One state object, one `render()`.** Every event handler mutates `state` and then calls `render()`. `render()` derives everything, including `isForecast = state.idx >= observed.length`. Nothing else toggles UI.
- **Forecast locks live in one place.** `render()` applies all seven locks from `HANDOFF.md` §3 together. Never apply only some of them, and never leave one to a CSS-only rule that JS state could contradict.
- **Forecast never writes observed state.** `state.mode`, `state.observedOpacity` and `state.baseline` are read but never assigned in forecast branches. The effective values are computed (`effectiveOpacity = isForecast ? 0.35 : state.observedOpacity / 100`).
- **No synthetic substitution.** If an external image or the backend fails, show `#asset-error` / `#map-error` and hide the raster. Never fall back to generated data.
- **No fabricated future values.** The point series has exactly `observed.length` entries. Don't extrapolate or interpolate past NOW.
- **Determinism.** Rasters come from seeded PRNGs. Same hazard and date gives byte-identical pixels. Speckle uses a fixed seed shared across passes.
- **No credentials anywhere.** Auth handlers call `preventDefault()`, validate, route, and `form.reset()`. They never log, store or send.
- **Styling stays in CSS.** JS sets attributes (`data-*`, `hidden`, `disabled`, `aria-*`) and text. The only inline style properties allowed are the custom properties `--p` (prob bar) and `--obs` / `--fc` (track widths).
- Build text with `textContent`. Use `innerHTML` only for SVG strings that `charts.js` builds from numbers and constant labels.
- **Config override for tests:** `config.js` merges `window.SPACEAPP_CONFIG` (if present) over the defaults, so `<script>window.SPACEAPP_CONFIG={forecasts:[]}</script>` placed before the module disables forecasts.

## Verify
- `node --check` on every file.
- The ID cross-check from `HANDOFF.md` §7.
- In the browser, step the slider from 5 to 6 and back, play through the wrap, switch hazards, and toggle risk. The console shows no errors and no credential output.
