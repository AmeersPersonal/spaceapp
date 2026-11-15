# src — Spec

## `studyArea.js` — the configuration contract

A single exported object. This is the only file to edit when swapping sample
data for real data.

```js
export const studyArea = {
  name:          String,   // display name, e.g. 'Mount Aso, Japan'
  hazard:        String,   // display name, e.g. 'Volcanic eruption'
  isSample:      Boolean,  // true shows the "Sample data" badge
  basemapStyle:  String,   // MapLibre style URL
  bounds:        { west, south, east, north },  // degrees
  dates:         [ObservedDate],   // oldest first
  riskZonesUrl:  String,   // GeoJSON path for observed zones
  forecast:      [ForecastDate],   // oldest first, may be []
  modelNote:     String,   // disclaimer shown under the prediction card
  story:         [String], // paragraphs for the side panel
}
```

### `ObservedDate`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `date` | ISO `YYYY-MM-DD` | yes | Acquisition date. |
| `image` | path under `/data/` | yes | Greyscale PNG of that pass. |
| `risk` | number 0–1 | no | Measured risk index. Omit and the date is skipped on the risk curve. |

### `ForecastDate`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `date` | ISO `YYYY-MM-DD` | yes | Date predicted for. |
| `probability` | number 0–1 | yes | Hazard likelihood. Drives the bar, the curve, and zone fill opacity. |
| `level` | `'high'`\|`'medium'`\|`'low'` | no | Pill colour. Defaults to `'medium'`. |
| `note` | String | no | One line on what drives the number. |
| `riskZonesUrl` | path under `/data/` | no | Predicted extent. Falls back to `studyArea.riskZonesUrl`. |

### Invariants

1. **Every image in `dates` must cover exactly `bounds`**, at the same pixel
   dimensions. The overlay is placed by corner coordinates, not georeferenced
   — a mismatched image is silently stretched to fit, and `sampleAt`'s
   lng/lat→pixel maths produces wrong values.
2. `dates` and `forecast` must each be sorted oldest first. Nothing sorts them.
3. `dates` must be non-empty. `MapView` reads `OBSERVED[0].image` at map load
   and `LAST_OBSERVED` as the initial slider position; an empty array throws.
4. `forecast` may be empty. The "Now" divider, the shaded chart region and the
   prediction card all suppress themselves when it is.
5. All image/GeoJSON paths are absolute and resolve against `public/`.
6. `isSample` must be set to `false` only when every image and number is real.

## `MapView` internals

### Derived module constants

| Constant | Definition |
| --- | --- |
| `OBSERVED` | `studyArea.dates` |
| `FORECAST` | `studyArea.forecast ?? []` |
| `TIMELINE` | `OBSERVED` then `FORECAST`, each tagged `kind` |
| `LAST_OBSERVED` | `OBSERVED.length - 1` |
| `NOW_PERCENT` | Slider position of the "Now" divider, as a % |
| `IMAGE_CORNERS` | `[[W,N],[E,N],[E,S],[W,S]]` — MapLibre's required corner order |

`IMAGE_CORNERS` order is fixed by MapLibre: top-left, top-right, bottom-right,
bottom-left. Reordering flips or mirrors the overlay.

### Pixel maths

```
sampleAt(pixels, lng, lat):
  x = floor(((lng - west) / (east - west)) * width)
  y = floor(((north - lat) / (north - south)) * height)
  returns pixels.data[(y*width + x) * 4] / 255      // red channel, 0–1
```

Reads the **red channel only**. Correct for greyscale PNGs, wrong for colour
ones. Coordinates are clamped to the image, so clicks outside return edge
pixels — but `MapView`'s click handler already rejects out-of-bounds clicks.

### Change detection

| Constant | Value | Effect |
| --- | --- | --- |
| `BLOCK` | 4 | Images are averaged into 4×4 blocks before diffing. Suppresses speckle; output image is ¼ resolution per axis. |
| `THRESHOLD` | 55 | Block differences below this (of 255) are transparent. Tune this if real NISAR data reads as noise or as nothing. |

Output colours: `rgb(43,131,255)` blue where darker than baseline,
`rgb(255,140,40)` orange where brighter. Alpha is
`min(255, 90 + |diff| * 2)`, so bigger changes are more opaque.

Results are memoised in `changeCache` keyed `` `${baselineIndex}-${dateIndex}` ``
and never evicted. With *n* observed dates the worst case is *n²* cached data
URLs — fine at 6 dates, reconsider past ~20.

### Map layers, in draw order

| Layer id | Type | Source | Notes |
| --- | --- | --- | --- |
| `radar` | raster | image source `radar` | Swapped via `updateImage()`, never re-added. |
| `risk-fill` | fill | geojson `risk` | Colour by `properties.risk`: `high` → `#e5484d`, anything else → `#f5a524`. |
| `risk-line` | line | geojson `risk` | Same colour rule, 1.5px. |

Fill opacity: `0.28` on observed dates; on forecast dates
`0.18 + 0.45 * probability`.

Radar opacity: `opacity` on observed dates, `opacity * 0.35` on forecast ones.

### Effect responsibilities

Each `useEffect` owns exactly one concern. Keep it that way.

| Deps | Does |
| --- | --- |
| `[]` | Creates the map, adds all sources and layers, binds click, cleans up. |
| `[]` | Loads pixels for every observed image once. Guarded by a `cancelled` flag. |
| `[mapReady, pixels, dateIndex, isForecast, mode, baselineIndex]` | Picks and sets the displayed image. |
| `[mapReady, opacity, isForecast]` | Sets raster opacity. |
| `[mapReady, dateIndex, isForecast, step]` | Swaps risk GeoJSON and fill opacity. |
| `[mapReady, showRisk]` | Toggles both risk layers' visibility. |
| `[playing]` | 1000 ms interval advancing `dateIndex`, wrapping at the end. |
| `[mapReady, point]` | Creates/moves the click marker. |

StrictMode double-invokes these in development. The map effect's cleanup calls
`map.remove()` and nulls the ref, which is what makes that safe.

## Routing

`App.jsx` renders a persistent navbar plus `<Routes>`. The navbar is outside
the route switch, so it shows on all four routes including 404.

## Styling rules

- `MapView.css` owns the `sx-` prefix. Every class inside the map explorer
  uses it. Do not introduce unprefixed classes there.
- `App.css` owns site chrome and is global (it sets `*`, `body`, `a`).
- `index.css` is empty. Either use it or delete the import in `main.jsx`.
- `MapView.css` defines six design tokens as custom properties scoped to
  `.sx`: `--sx-surface`, `--sx-border`, `--sx-text`, `--sx-muted`,
  `--sx-accent`, `--sx-highlight`. Use them rather than new literals.
- `App.css` has no tokens; its colours are literal hex. The page background
  `#1e0f1c` is set there on `body`.
- Semantic colours are literals on purpose and must not be swapped for tokens:
  `#e5484d` high risk, `#f5a524` medium risk, `#2b83ff` darker-than-baseline,
  `#ff8c28` brighter-than-baseline, `#ff6b6b` error.
- Dark palette only. There is no light mode and no theme switching.
