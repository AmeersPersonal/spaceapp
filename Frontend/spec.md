# Frontend — Spec

## Build and tooling

| Item | Value |
| --- | --- |
| Bundler | Vite 8 (`@vitejs/plugin-react` 6) |
| Module type | ESM (`"type": "module"`) |
| Entry HTML | `index.html` → `/src/main.jsx`, mounts into `#root` |
| Linter | oxlint 1.x via `npm run lint` |
| Output | `dist/` (default Vite target) |
| Type checking | None. `@types/react` is installed but no TS is used. |

## Dependencies and why each is present

| Package | Role |
| --- | --- |
| `react`, `react-dom` 19 | UI. StrictMode is on, so effects run twice in dev. |
| `react-router-dom` 7 | Client-side routing via `BrowserRouter`. |
| `maplibre-gl` 6 | Map rendering, image overlay, GeoJSON layers. |

No HTTP client, no state manager, no chart library. Charts are hand-written
inline SVG.

## Routes

| Path | Component | Notes |
| --- | --- | --- |
| `/` | `pages/Home.jsx` | Renders `<MapView />`. |
| `/signin` | `pages/SignIn.jsx` | Form only; no backend call. |
| `/signup` | `pages/SignUp.jsx` | Form only; no backend call. |
| `*` | `pages/NotFound.jsx` | 404. |

`BrowserRouter` means any production host must rewrite unknown paths to
`index.html`, or a hard refresh on `/signin` 404s at the server.

## Static asset contract

Everything under `public/` is copied to the build root verbatim. The app
references these by absolute path:

- `/data/radar_<YYYY-MM-DD>.png` — one per observed date
- `/data/risk_zones.geojson` — observed hazard zones
- `/data/risk_forecast_<YYYY-MM-DD>.geojson` — one per forecast date

Paths are declared in `src/studyArea.js`. A missing file surfaces as a loading
error in the side panel (images) or as a silently absent layer (GeoJSON).

`index.html` references `/favicon.svg`, which **does not exist** in `public/`.
Harmless, but it is a 404 on every page load.

## Required external services

| Service | Used for | Key needed |
| --- | --- | --- |
| `tiles.openfreemap.org/styles/liberty` | Base map tiles | No |

The app will not render a base map offline. Radar overlay and charts still work.

## MapLibre integration requirements

1. The worker URL must be set before any `Map` is constructed:
   ```js
   import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
   maplibregl.setWorkerUrl(workerUrl)
   ```
   This is module-level in `mapview.jsx`. Removing it breaks the map under Vite.

2. `maplibre-gl/dist/maplibre-gl.css` must be imported or controls render
   unstyled.

3. Rotation and pitch are disabled (`dragRotate: false`,
   `pitchWithRotate: false`, `touchZoomRotate.disableRotation()`). The overlay
   is a north-up rectangle; keep it that way.

4. The map is bounded. `maxBounds` is the study area padded by 1.5° on each
   side, so the user cannot pan away from the data.

## Canvas / same-origin requirement

Change detection calls `ctx.getImageData()` on radar PNGs. This only works
because the images are served same-origin from `public/data/`. If images ever
move to a CDN, that host must send permissive CORS headers and the `Image`
objects already set `crossOrigin = 'anonymous'`.

## Browser requirements

WebGL (MapLibre), Canvas 2D with `getImageData`, ES modules. No IE, no
graceful degradation path.

## Not implemented

- Any network call to a backend.
- Authentication, sessions, or route guarding.
- Tests.
- Error boundaries — a throw inside `MapView` blanks the page.
