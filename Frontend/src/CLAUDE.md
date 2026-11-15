# CLAUDE.md — src

All application code. Seven source files; `mapview.jsx` is most of the app.

See `spec.md` here for the `studyArea.js` contract, pixel maths constants,
layer table and effect responsibilities. Read it before editing `mapview.jsx`.

## Files

| File | Lines | Role |
| --- | --- | --- |
| `main.jsx` | 13 | Mounts React into `#root`; `StrictMode` + `BrowserRouter`. |
| `App.jsx` | 32 | Navbar and the four routes. |
| `mapview.jsx` | 677 | The map explorer. The actual product. |
| `studyArea.js` | 100 | Pure config. The only file to edit when swapping data. |
| `pages/` | — | Route components. See `pages/CLAUDE.md`. |
| `App.css` | 126 | Site chrome: navbar, buttons, auth forms. |
| `MapView.css` | 489 | Everything inside the map explorer. |
| `index.css` | 0 | Empty, but imported by `main.jsx`. |

Render flow: `main.jsx` → `App.jsx` routes → `pages/Home.jsx` → `<MapView />`.

## Navigating `mapview.jsx`

It is long but ordered, with section banners. Top to bottom:

1. **Module setup.** Splits `studyArea` into `OBSERVED` (dates with images)
   and `FORECAST` (dates without), then concatenates them into one `TIMELINE`
   where each entry carries `kind: 'observed' | 'forecast'`. That single array
   is why one slider spans measurement and prediction.
2. **Pixel helpers.** `loadPixels`, `sampleAt`, `blockAverage`,
   `buildChangeImage`.
3. **`TimeChart`.** Inline SVG — brightness at the clicked point.
4. **`RiskChart`.** Inline SVG — risk across the whole timeline, solid for
   observed, dashed for forecast, bridged at the last observed point.
5. **`MapView`.** The component.

## Editing rules for `mapview.jsx`

- **One concern per `useEffect`.** The component is a pile of small effects —
  create map, load pixels, swap image, set opacity, swap GeoJSON, toggle
  visibility, run the play timer, move the marker. Keep them separate; do not
  consolidate them.
- **Refs hold what React must not re-create**: the map instance, the marker,
  and `changeCache`. Do not move these into state.
- **`isForecast` is the branch point.** Almost every past/future difference
  derives from `TIMELINE[dateIndex].kind === 'forecast'` — image fallback,
  35% opacity, disabled toggles, swapped GeoJSON, probability-scaled fill,
  prediction card, recoloured slider, changed legend. When adding a feature,
  decide explicitly what it does on a forecast date.
- **Block averaging exists for a reason.** Radar speckle makes single-pixel
  comparison pure noise. Do not "optimise" `blockAverage` away.
- StrictMode double-invokes effects in dev. The map effect's cleanup calls
  `map.remove()` and nulls the ref — that is what makes it safe.

## State in `MapView`

| State | Meaning |
| --- | --- |
| `dateIndex` | Position on `TIMELINE`. Starts at the last observed date. |
| `playing` | Advances `dateIndex` every 1000 ms, wrapping. |
| `mode` | `'radar'` or `'change'`. Forced off on forecast dates. |
| `baselineIndex` | Which observed date `'change'` mode diffs against. |
| `opacity` | Radar layer opacity. × 0.35 on forecast dates. |
| `showRisk` | Hazard zone layers on/off. |
| `point` | Clicked lng/lat, or `null`. Drives `TimeChart`. |
| `pixels` | Raw pixel data for every observed image. Loaded once. |

## CSS conventions

- `MapView.css` prefixes every class `sx-`. Keep it that way; do not add
  unprefixed classes there.
- `App.css` owns site chrome and is global — it sets `*`, `body` and `a`.
- `MapView.css` defines six tokens on `.sx` (`--sx-surface`, `--sx-border`,
  `--sx-text`, `--sx-muted`, `--sx-accent`, `--sx-highlight`). Use them
  instead of adding new colour literals. `App.css` has no tokens.
- Semantic colours stay literal — risk red/amber and the change-detection
  blue/orange carry meaning and are duplicated in `mapview.jsx`'s paint
  properties.
- Dark palette only. No light mode, no theme switching.
- `index.css` is empty. Either use it or remove the import from `main.jsx`.
