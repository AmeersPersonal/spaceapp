# spaceapp workstation

A flat, north-up, full-viewport map workstation for exploring **synthetic** NISAR-style SAR passes over Aso caldera (Kumamoto, Japan, 32.884° N, 131.104° E), with a timeline that runs past "NOW" into **placeholder** model forecasts. Vanilla HTML, CSS and ES modules with MapLibre GL JS from a CDN. No framework, no build step, no npm.

The one rule that outranks everything else: **a prediction must never look like a measurement.**

## Run

```bash
cd spaceapp/workstation
npm run dev                  # zero-dependency Node static server (dev-server.mjs), no install needed
# or: python -m http.server 5173
```

Open <http://localhost:5173/#/>. `npm run dev` moves to the next free port if 5173 is busy (e.g. the old `Frontend/` Vite app is running); set `PORT=` to choose one.

It must be served over HTTP. ES modules do not load from `file://`. Fonts (Google Fonts), MapLibre (unpkg) and basemap tiles (OpenFreeMap) need network access. Every failure is explicit: a missing map library, blocked tiles or a failed external image each show an error in the Evidence dock, and nothing synthetic is substituted in their place.

## What it is

- **Three hazard channels** share one timeline: `01 // VOLCANIC SAR` (default), `02 // SEISMIC FAULT`, `03 // TSUNAMI PROPAGATION`, plus a compound overlay that draws the other two channels' extents as lines.
- **Six observed passes** (2026-04-21, 05-03, 05-15, 05-27, 06-08, 06-20; indices 0–5), twelve days apart. "NOW / demo" is the last sample pass, 20 Jun 2026.
- **Four forecast dates** (2026-07-02, 07-14, 07-26, 08-07; indices 6–9).
- **Radar image** view shows a procedural greyscale raster per pass. **Change since** view blurs (3 × 3) and differences the current pass against a chosen baseline: negative is blue, positive is orange.
- **Risk extent** polygons are schematic, seeded per date. **Inspection reticle** marks a clicked point and plots its value on each observed pass.
- **Evidence** dock: provenance strip, observed/forecast status card, a risk-over-time chart and a point-series chart, both SVG with `<title>`/`<desc>` summaries.
- **Routes**: `#/` (workstation), `#/signin`, `#/signup`, anything else is a 404. The forms are prototypes: nothing is created, stored, logged or sent.

## Forecast behaviour (the locks)

On every forecast date, all of the following apply at once:

1. The last observed raster is shown at **exactly** `raster-opacity: 0.35`, regardless of the observed opacity setting. The opacity slider is disabled and reads `LOCKED: 35% CONTEXT ONLY`.
2. Both view-mode buttons are disabled, the baseline selector is hidden, and the difference layer cannot appear.
3. The timeline thumb, mode pill and date switch to pale sky `#BFD1E5` **and** change shape and wording: a diamond thumb and the text `FORECAST`.
4. `NO SATELLITE PASS FOR THIS DATE` is shown.
5. The prediction card shows the target date, probability, level, driver, a probability bar, the exact string `Placeholder forecast. Swap in your model output.` and `Sample probability · not validated`.
6. Map risk extents become dashed. Charts show a NOW boundary, a hatched future region and dashed model segments.
7. Future brightness and point values are **never** populated. The chart says `No data yet`.

Returning to an observed date restores the previous view mode, observed opacity and baseline. Forecast mode never mutates those values.

## CONFIG flags

Configuration lives in `js/config.js` as `DEFAULTS`. Any key can be overridden without editing the file by defining `window.SPACEAPP_CONFIG` in a classic `<script>` placed **before** `<script type="module" src="js/main.js">`; the module merges it over the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `useExternalImages` | `false` | `true` loads one PNG per pass from `externalImagePath` instead of the procedural generator. A failed load shows `#asset-error` and hides the raster. There is no fallback. |
| `useLiveBackend` | `false` | `true` fetches each hazard's timeline from `backendUrl` instead of the built-in registry. A failed fetch shows `#map-error` and renders no data. Mock data is not substituted. |
| `backendUrl` | `/api/v1/hazards/{id}/timeline` | Timeline endpoint template. `{id}` is replaced with the hazard id (`volcano`, `earthquake`, `tsunami`). |
| `externalImagePath` | `./data/aso/{date}.png` | Image path template. `{date}` is replaced with the ISO pass date (`2026-04-21`). Images must be greyscale and cover exactly `bounds`. |
| `basemapStyle` | `https://tiles.openfreemap.org/styles/liberty` | MapLibre style URL. The vector paint is recoloured to the obsidian palette at load. |
| `bounds` | `{ west: 130.98, south: 32.79, east: 131.23, north: 32.97 }` | Approximate demo box for the volcano channel, in degrees. The raster is draped over this rectangle and the footprint frame is drawn around it. |
| `forecasts` | `undefined` | `undefined` uses the registry's four forecast dates. `[]` removes every forecast date for every hazard: no hatching, no NOW divider, no forecast tick labels, and both charts still render. |
| `defaultHazard` | `'volcano'` | Channel selected on load. |
| `playIntervalMs` | `1000` | Milliseconds between steps when Play is active. Play wraps from the last index back to 0. |
| `forecastOpacity` | `0.35` | The locked raster opacity on forecast dates. Documented so it is visible. It is never user-adjustable, and `window.SPACEAPP_CONFIG` cannot override it (the UI text states 35%). |
| `levelThresholds` | `{ medium: 0.35, high: 0.6 }` | Probability cut-offs for the `low` / `medium` / `high` label. Demonstration only, not official categories. |

Example: disable forecasts for a test run.

```html
<script>window.SPACEAPP_CONFIG = { forecasts: [] };</script>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script type="module" src="js/main.js"></script>
```

Example: point at your own imagery and backend.

```html
<script>
  window.SPACEAPP_CONFIG = {
    useExternalImages: true,
    externalImagePath: './data/aso/{date}.png',
    useLiveBackend: true,
    backendUrl: 'https://example.invalid/api/v1/hazards/{id}/timeline',
  };
</script>
```

## Synthetic-data caveats

Read these before showing the workstation to anyone.

- All imagery, values, probabilities, drivers and extents are **synthetic demonstration material**. There is no NISAR observation and no validated forecast in this build.
- The dates are design specimens, not the system clock. "NOW" is the last sample pass, 20 Jun 2026. It is not a claim about real satellite availability.
- Pixel values are **display intensities, not calibrated units**. They are never labelled dB. Seismic and tsunami units read "synthetic, illustrative".
- Level thresholds are demonstration-only. Risk extents are schematic, not a hazard map.
- The provenance strip `SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY` is always visible, in every mode and every hazard.
- Nothing in the interface implies validated probabilities or real-time monitoring. If a change blurs the line between measured and projected, it is wrong even if it looks better.
- Data credit retained for a future real-data build: NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC. This demo uses no NISAR data.

## Verification

1. `node --check` on every file in `js/`.
2. Run a small Node script that checks: (a) IDs in `index.html` are unique; (b) every `getElementById` / `querySelector('#…')` in `js/` targets an existing ID; (c) every `#id` selector in `css/` exists in the HTML.
3. Serve the folder and walk the acceptance checklist in `HANDOFF.md` §6 in a browser. The essential path:
   - `#/` loads the volcanic channel at index 5, 20 Jun 2026. The map fills the viewport, flat and north-up. Rotation is impossible by mouse, touch or keyboard.
   - Step the slider from 5 to 6: every lock in the list above engages at once. Set observed opacity to 100% first and confirm the forecast opacity is still exactly 0.35.
   - Step back to 5: mode, opacity and baseline are restored. Press Play and let it wrap from 9 to 0.
   - Change mode lists 6 baselines. The current pass as its own baseline shows nothing.
   - Toggle Risk extent: layers and legend hide and show; the disclaimer stays.
   - Click inside the footprint: exactly 6 values plot and the future region says `No data yet`. Click outside: no coverage.
   - Switch hazards and enable the compound overlay. The locks are identical in every channel.
   - Sign in, sign up (including a password mismatch), 404, Method, About and Escape all work. The console shows no credentials.
   - 1440 × 1080 and 390 × 844: no horizontal overflow; the Evidence dock scrolls internally.
   - Block the MapLibre script, block tiles, and (with `useExternalImages: true`) break an image URL: each shows an explicit error with no synthetic substitution.
4. If Playwright or Chromium is available, automate the state checks at both viewports, including a run with `window.SPACEAPP_CONFIG = { forecasts: [] }` and a run with the MapLibre script blocked.
5. Report honestly what was and was not verified. Live WebGL, CDN and tile availability cannot be proven by stubbed tests.

## File map

```
workstation/
├── HANDOFF.md        cross-cutting rules, acceptance checklist, verification
├── CLAUDE.md         HTML layer: working rules
├── spec.md           HTML layer: page structure and DOM contract (IDs, verbatim text)
├── index.html        markup only; links css/*.css and js/main.js
├── README.md         this file
├── css/
│   ├── CLAUDE.md     CSS layer: working rules
│   ├── spec.md       tokens, typography, layout, components, responsive
│   ├── tokens.css    :root tokens, reset, base type, .visually-hidden, .skip-link, .meta
│   ├── layout.css    dock positioning, #page overlay, mobile layout
│   └── components.css  controls, legend, cards, prob bar, charts, dialogs, forms, 404, map overrides
└── js/
    ├── CLAUDE.md     JS layer: working rules
    ├── spec.md       config, data, rasters, map, charts, state, routing
    ├── main.js       entry: boot, state, render(), events, play timer, router, dialogs
    ├── config.js     CONFIG (DEFAULTS merged with window.SPACEAPP_CONFIG) and HAZARD_REGISTRY
    ├── telemetry.js  TelemetryService: timelines, procedural rasters, external images, sampling, change images
    ├── map.js        MapLibre setup, basemap recolouring, sources and layers, applyMapState()
    └── charts.js     SVG plotFrame, risk chart, point chart
```

`../Frontend/` is a separate, older React app. The workstation never imports from it and does not modify it.
