# CLAUDE.md — Frontend

The whole user-facing product: a React + Vite single-page app rendering an
interactive map of a volcanic study area across time.

See `spec.md` here for the build, dependency and integration contracts.

## Commands

Run all of these from `Frontend/`.

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # -> dist/
npm run preview    # serve the built output
npm run lint       # oxlint
```

No test suite exists. Verify UI changes by running `npm run dev` and using the
feature in a browser — type checking will not catch anything here, since there
is no TypeScript.

## Stack

React 19, React Router 7, MapLibre GL 6, Vite 8, oxlint. Plain `.jsx` and
plain `.css`. No state library, no CSS framework, no HTTP client. Charts are
hand-written inline SVG, not a chart library.

The base map comes from `tiles.openfreemap.org` and needs no API key, so the
app has no secrets and no `.env`.

## Layout

| Path | Holds |
| --- | --- |
| `src/` | All application code. |
| `public/data/` | Radar PNGs and hazard GeoJSON, served at `/data/*`. |
| `scripts/` | Python generator producing everything in `public/data/`. |
| `index.html` | Vite entry; mounts `#root`, loads `src/main.jsx`. |
| `vite.config.js` | React plugin only. |
| `.oxlintrc.json` | Lint config. |
| `README.md` | Unmodified Vite template boilerplate. Ignore it. |

## What the app does

Route `/` renders the map explorer: a MapLibre map of the Aso caldera with a
greyscale radar image laid over it, a timeline slider split into "Observed" and
"Forecast" halves with a "Now" divider, and a side panel with the hazard name,
narrative text, a risk-over-time chart and a legend. Clicking the map charts
radar brightness at that point across every pass.

Two view modes on observed dates: **Radar image** (the raw pass) and **Change
since** (pick a baseline; blue where the ground darkened, orange where it
brightened — computed in-browser from the PNGs).

Past "Now" there is no image, so the last real pass stays underneath at 35%
opacity, the mode toggles disable, and a prediction card appears.

## Do not break these

1. **The MapLibre worker URL.** Vite cannot locate MapLibre's background
   worker on its own. `mapview.jsx` has, at module level:
   ```js
   import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
   maplibregl.setWorkerUrl(workerUrl)
   ```
   Removing either line breaks the map under Vite.

2. **`maplibre-gl/dist/maplibre-gl.css` must stay imported** or controls
   render unstyled.

3. **The map is 2D on purpose.** `dragRotate: false`,
   `pitchWithRotate: false`, `touchZoomRotate.disableRotation()`. The radar
   overlay is a north-up rectangle; tilting it is meaningless.

4. **Radar images must stay same-origin.** Change detection calls
   `ctx.getImageData()` on them, which only works because they are served from
   `public/data/`. Moving them to a CDN requires CORS headers on that host.

## Routing caveat

`BrowserRouter` means any production host must rewrite unknown paths to
`index.html`, or a hard refresh on `/signin` 404s at the server.
