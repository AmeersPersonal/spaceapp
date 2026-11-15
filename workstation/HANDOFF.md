# SpaceApp workstation: implementation handoff

**Audience:** the implementing model. Start with this file, then read the layer docs in the order listed in §2. Where these docs conflict with anything older (including `spaceapp/handoff.md` and `Frontend/`), they win.

## 0. Task in one paragraph
Build a flat, north-up, full-viewport map workstation for exploring **synthetic** NISAR-style SAR passes over Aso caldera (Japan), with a timeline that continues past "NOW" into **placeholder** model forecasts. It is split into three layers:
- `index.html`: markup
- `css/`: styles
- `js/`: ES modules

It uses vanilla JS with MapLibre GL JS from a CDN. There is no framework and no build step.

The visual direction is *JPL / NISAR orbital telemetry workstation*: matte obsidian HUD docks, 1px hairlines, corner reticle ticks, zero radius. There is no glass, blur, glow or shadow. The core rule outranks the visuals: **a prediction must never look like a measurement.**

Run it with:
```bash
cd spaceapp/workstation && python -m http.server 5173   # open http://localhost:5173/#/
```
It must be served over HTTP, because ES modules don't load from `file://`. Fonts, MapLibre and tiles need network access, and every failure must be explicit (see `js/spec.md` §7).

## 1. Repository facts (Windows, `c:\Users\husse\Desktop\.Spaceapps\spaceapp`, git branch `main`)
- `Frontend/` is an existing React 19 + Vite app with the same concept but older styling. **Do not modify it** and do not import from it.
- Worth reading for prior logic (port the ideas, not the React):
  - `Frontend/src/mapview.jsx`: timeline model, `sampleAt`, `buildChangeImage`, SVG charts
  - `Frontend/src/studyArea.js`: config seam, forecast notes
  - `Frontend/scripts/make_sample_data.py`: sample SAR texture and hazard rings
- The original handoff's embedded HTML was **truncated**, so no reference implementation, DOM IDs or tests exist. The DOM contract in `spec.md` is the source of truth.
- Don't commit unless the user asks. If you do commit, branch off `main` first.

## 2. File map and read order

```
workstation/
├── HANDOFF.md        ← you are here (cross-cutting rules, acceptance, verification)
├── CLAUDE.md         ← HTML layer: working rules
├── spec.md           ← HTML layer: page structure + DOM contract
├── index.html        ← markup only; links css/*.css and js/main.js
├── README.md         ← run command, CONFIG flags, synthetic-data caveats (you write this)
├── css/
│   ├── CLAUDE.md     ← CSS layer: working rules
│   ├── spec.md       ← tokens, typography, layout, components, responsive
│   ├── tokens.css
│   ├── layout.css
│   └── components.css
└── js/
    ├── CLAUDE.md     ← JS layer: working rules
    ├── spec.md       ← config, data, rasters, map, charts, state, routing
    ├── main.js       ← entry: boot, state, render, router
    ├── config.js     ← CONFIG + HAZARD_REGISTRY (pure data)
    ├── telemetry.js  ← TelemetryService, procedural rasters, change detection
    ├── map.js        ← MapLibre setup, layers, basemap styling
    └── charts.js     ← SVG plotFrame, risk chart, point chart
```

Read in this order: this file, then `CLAUDE.md`, `spec.md`, `css/CLAUDE.md`, `css/spec.md`, `js/CLAUDE.md`, `js/spec.md`.

Dependency direction:
- HTML defines the IDs.
- CSS styles those IDs and the `data-*` state attributes.
- JS reads the IDs, sets the state attributes, and never writes inline colours or layout.

The `<html data-mode data-hazard>` attributes are the only channel between JS state and CSS appearance.

## 3. Scientific honesty (non-negotiable, applies to every layer)
- All imagery, values, probabilities, drivers and extents are **synthetic demonstration material**. There is no NISAR observation and no validated forecast.
- Study point: **Aso caldera, Kumamoto, Japan, 32.884° N, 131.104° E**.
- **Dates.** These are design specimens, not the system clock.
  - Observed: `2026-04-21, 05-03, 05-15, 05-27, 06-08, 06-20` (indices 0–5).
  - Forecast: `2026-07-02, 07-14, 07-26, 08-07` (indices 6–9).
  - The dates are 12 days apart.
  - "NOW / demo" means the last sample pass, 20 Jun 2026. It is not a claim about real satellite availability.
- **On every forecast date, all of these apply together:**
  1. The last observed raster shows at **exactly** `raster-opacity: 0.35`, regardless of the observed setting. The opacity slider is disabled and shows `LOCKED: 35% CONTEXT ONLY`.
  2. Both view-mode buttons are disabled. The baseline selector is hidden. The difference layer is hidden and cannot appear.
  3. The timeline thumb, mode pill and date switch to pale sky `#BFD1E5` **and** change shape and wording: a diamond thumb, and the text `FORECAST`.
  4. `NO SATELLITE PASS FOR THIS DATE` is shown.
  5. The prediction card shows the target date, probability, level, driver, a probability bar, the **exact** string `Placeholder forecast. Swap in your model output.` and `Sample probability · not validated`.
  6. Map risk extents become dashed. Charts show a NOW boundary, a hatched future region and dashed model segments.
  7. Future brightness and point values are **never** populated. Show `No data yet`.
- Returning to observed restores the previous view mode, observed opacity and baseline. Forecast mode must not mutate those values.
- With `CONFIG.forecasts = []`, the hatching, NOW divider and forecast labels disappear, and both charts still render.
- Pixel values are **display intensities, not calibrated units**. Never label them dB. Seismic and tsunami units read "synthetic, illustrative".
- Level thresholds are demonstration-only. Risk extents are schematic, not a hazard map.
- Provenance strip, always visible: `SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY`.
- Nothing may imply validated probabilities or real-time monitoring.

## 4. Design skills to load first
These live in `c:\Users\husse\Desktop\.Spaceapps\.claude\skills\` and are short templates. Use their **rules**, not their fonts or palettes. The tokens in `css/spec.md` win.
1. `dataviz` (built-in): chart marks, axes, colour validation on dark backgrounds, accessible summaries. **Required before writing `charts.js`.**
2. `matrix`: dark-only single surface, dense data, mono type, one interaction accent, explicit empty/loading/error states.
3. `geometric`: precise shapes, structured grid, unobtrusive layout.
4. `ant`: data-dense interaction states and responsive or accessibility rules.

Avoid: `cosmic`, `neon`, `glassmorphism`, `enterprise`, `futuristic`.

## 5. Out of scope
Real auth, OAuth, password reset, subscriptions, dashboards, invented live data, and any change to `Frontend/`.

## 6. Acceptance checklist
- [ ] `#/` loads the volcanic channel at index 5, 20 Jun 2026. The map covers the viewport, flat and north-up, and rotation is impossible by mouse, touch or keyboard.
- [ ] HUD fill appears only on the outer docks. There is no blur, glow, shadow or radius. Orbitron is used only for the wordmark and the 404 page.
- [ ] All tokens are present on `:root`, and the semantic colours keep their meanings.
- [ ] Index 5 → 6 triggers every lock in §3 at once.
  - [ ] Opacity is exactly 0.35 even after observed opacity was set to 100%.
  - [ ] The slider is disabled, both buttons are disabled, the baseline is hidden and there is no difference layer.
  - [ ] The thumb, pill and date switch to pale sky with diamond and FORECAST wording.
  - [ ] The no-pass alert, the prediction card and the exact disclaimer appear.
  - [ ] Risk extents and chart segments are dashed.
- [ ] Back to observed restores mode, opacity and baseline. Play wraps from 9 to 0 with observed behaviour restored.
- [ ] Change mode lists 6 baselines. Negative is blue, positive is orange. The current pass as its own baseline shows nothing.
- [ ] The risk toggle hides and shows the layers and legend, and the disclaimer stays.
- [ ] Clicking inside the footprint plots exactly 6 values, and the future region says `No data yet`. Clicking outside shows no coverage.
- [ ] `CONFIG.forecasts = []` (via `window.SPACEAPP_CONFIG`): no hatch, no NOW line, no forecast labels, and both charts work.
- [ ] Provenance warnings show in every mode and every hazard.
- [ ] Sign in, sign up, password mismatch, 404, Method, About and Escape all work, and the console stays clean of credentials.
- [ ] 1440×1080 and 390×844 have no horizontal overflow, and evidence scrolls internally.
- [ ] Missing MapLibre, blocked tiles and a failed external image each show an explicit error, with no synthetic substitution.
- [ ] Switching hazard keeps the locks identical, and the compound overlay draws both overlays.
- [ ] Map attribution is visible.

## 7. Verification to perform
1. Run `node --check` on every file in `js/`.
2. Run a small Node script that checks:
   - (a) IDs in `index.html` are unique
   - (b) every `getElementById` / `querySelector('#…')` in `js/` targets an existing ID
   - (c) every `#id` selector in `css/` exists in the HTML
3. Serve it and walk §6 in a browser.
4. If Playwright or Chromium is available, automate the §6 state checks at both viewports. Include a run with `window.SPACEAPP_CONFIG = { forecasts: [] }` and a run with the MapLibre script blocked.
5. Report honestly what was and wasn't verified. Live WebGL, CDN and tile availability can't be proven by stubbed tests.

## 8. Deliverable
- `index.html`
- the three CSS files
- the five JS modules
- `README.md`

They must be complete, with no truncation, no `TODO`s and no build step. Keep the `CLAUDE.md` / `spec.md` files accurate if the implementation forces a deviation, and say why.
