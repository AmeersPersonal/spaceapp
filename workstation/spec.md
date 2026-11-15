# spec.md — `index.html` (page structure and DOM contract)

## 1. `<head>`
- `<meta charset="utf-8">`
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- `<meta name="theme-color" content="#07090E">`
- `<title>spaceapp — Aso, in time</title>`
- Preconnect to `fonts.googleapis.com` and `fonts.gstatic.com` (crossorigin).
- Google Fonts, one stylesheet: `Orbitron:wght@500`, `Space+Grotesk:wght@400;500;600`, `Inter:wght@400;500`, `IBM+Plex+Mono:wght@400;500;600`, with `display=swap`.
- MapLibre CSS, `https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css`.
- Local CSS, in this order: `css/tokens.css`, `css/layout.css`, `css/components.css`.
- MapLibre JS, `https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js` (classic script, no `defer`, so it is defined before the module runs).
- `<script type="module" src="js/main.js"></script>`

## 2. Root attributes
`<html lang="en" data-mode="observed" data-hazard="volcano" data-route="home">`. JS updates these. CSS keys appearance off them.

## 3. Body structure (in DOM order = tab order)

```
body
├── a.skip-link[href="#controls"]              "Skip to controls"
├── div#map[role=region][aria-label="Map of the study area"]
├── header#topbar.hud
│   ├── a.wordmark[href="#/"]                   "spaceapp"
│   │   └── span.meta "NISAR-SIM // L-BAND SAR"
│   ├── fieldset#hazard-switch  (legend.visually-hidden "Hazard channel")
│   │   ├── input#hz-volcano[type=radio name=hazard value=volcano checked] + label "01 // VOLCANIC SAR"
│   │   ├── input#hz-earthquake[...value=earthquake]                       + label "02 // SEISMIC FAULT"
│   │   ├── input#hz-tsunami[...value=tsunami]                             + label "03 // TSUNAMI PROPAGATION"
│   │   └── label > input#compound-toggle[type=checkbox] "+ COMPOUND OVERLAY"
│   ├── div#target-cell
│   │   ├── span#target-name   "TARGET: ASO CALDERA, JP"
│   │   ├── span#target-coords "32.884° N, 131.104° E"
│   │   └── span#target-footprint "FOOTPRINT: — KM"     (JS computes from bounds)
│   ├── div#mode-pill[role=status]  "● OBSERVED PASS // MEASURED"
│   └── nav#topnav
│       ├── button#open-method "Method"
│       ├── button#open-about  "About"
│       ├── a[href="#/signin"] "Sign in"
│       └── button#menu-toggle[aria-expanded=false][aria-controls=topnav-menu]  (mobile only, CSS-hidden on desktop)
├── main#workspace
│   ├── aside#controls.hud[aria-label="Sensor and layer controls"]
│   │   └── details#controls-drawer[open] > summary "Controls"  (summary visible only on mobile)
│   │       ├── section#pass-header
│   │       │   ├── h2#pass-date "20 JUN 2026"
│   │       │   ├── p#pass-index.meta "PASS 06 / 06"
│   │       │   └── p#no-pass-alert[hidden] "NO SATELLITE PASS FOR THIS DATE"
│   │       ├── div#view-toggle[role=group][aria-label="View mode"]
│   │       │   ├── button#btn-radar[aria-pressed=true]  "Radar image"
│   │       │   └── button#btn-change[aria-pressed=false] "Change since"
│   │       ├── label#baseline-wrap[hidden] "Baseline" > select#baseline   (JS fills 6 options)
│   │       ├── div#opacity-wrap
│   │       │   ├── label[for=opacity] "Raster opacity"
│   │       │   ├── input#opacity[type=range min=0 max=100 step=5 value=85]
│   │       │   ├── output#opacity-readout[for=opacity] "85%"
│   │       │   └── p#opacity-lock[hidden].meta "LOCKED: 35% CONTEXT ONLY"
│   │       ├── label > input#toggle-risk[type=checkbox checked]     "Risk extent"
│   │       ├── label > input#toggle-reticle[type=checkbox checked]  "Inspection reticle"
│   │       └── section#legend[aria-label="Legend"]
│   │           ├── div#legend-radar      (greyscale ramp + "Dark: smooth / wet" / "Bright: rough / steep")
│   │           ├── div#legend-change[hidden]   (two square patches + labels)
│   │           ├── div#legend-forecast[hidden] ("No satellite radar pass. The last sample image is dimmed to 35% as geographic context, not a new observation.")
│   │           └── ul#legend-risk        (two circle marks; li text filled by JS: "(measured extent)" / "(projected extent, dashed)")
│   └── aside#evidence.hud[aria-label="Evidence"]
│       ├── p#provenance.meta "SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY"
│       ├── p#map-error[hidden][role=alert]
│       ├── p#asset-error[hidden][role=alert]
│       │   (these three sit outside the drawer so a collapsed mobile drawer
│       │    never hides the provenance strip or an error — HANDOFF §3)
│       └── details#evidence-drawer[open] > summary "Evidence"
│           ├── section#status-card
│           │   ├── div#observed-card   (h3 "Observed sample pass", dl#observed-summary: pass / baseline / inspected point)
│           │   └── div#forecast-card[hidden]
│           │       ├── h3 "Forecast for " + span#forecast-date
│           │       ├── p#forecast-prob  "—%"             (hero metric)
│           │       ├── span#forecast-level.level         "—"
│           │       ├── div.prob-bar > div#forecast-bar   (width set by JS via CSS custom property --p)
│           │       ├── p#forecast-driver
│           │       ├── p#forecast-disclaimer "Placeholder forecast. Swap in your model output."
│           │       └── p.meta "Sample probability · not validated"
│           ├── section > h3 "Risk over time" + figure#chart-risk (+ figcaption)
│           └── section
│               ├── h3#point-title "Brightness at a point"
│               ├── p#point-coords.meta "32.884° N, 131.104° E"
│               ├── figure#chart-point (+ figcaption "No future pixel brightness values — ever.")
│               └── p#point-status[role=status] "Click inside the radar footprint to inspect a point."
├── footer#timeline.hud
│   ├── button#play[aria-label="Play"]  (two inline SVG icons: .icon-play, .icon-pause)
│   ├── div#track
│   │   ├── div#seg-observed "OBSERVED PASSES (01–06)"
│   │   ├── div#now-tick     "NOW (20 JUN 2026)"
│   │   ├── div#seg-forecast "FORECAST HORIZON (07–10)"
│   │   ├── input#date-slider[type=range min=0 max=9 step=1 value=5][aria-label="Pass date"]  (aria-valuetext set by JS)
│   │   └── ol#ticks   (JS renders one button per date: "21 APR" … "07 AUG")
│   └── output#timeline-date "20 JUN 2026"
├── section#page[hidden]      (route overlay; JS shows one child)
│   ├── form#signin-form   (email, password, submit "Sign in", link "#/signup", p.meta "Prototype: no account is created and nothing is sent.")
│   ├── form#signup-form   (name, email, password, confirm, p#pw-error[hidden][role=alert], submit, link "#/signin", same prototype note)
│   └── div#notfound       (p.display-404 "spaceapp", p.meta "404 · PAGE NOT FOUND", a[href="#/"] "Back to workstation")
├── dialog#dlg-method[aria-labelledby]  (h2, method text: synthetic SAR, change detection, placeholder forecast; button.dialog-close "Close")
├── dialog#dlg-about[aria-labelledby]   (h2, project/limitations text; button.dialog-close "Close")
└── div#announcer.visually-hidden[aria-live=polite]
```

## 4. Contract summary (stable IDs)
These are the hooks for JS, CSS and tests. Don't rename them.
- Top bar: `topbar`, `hazard-switch`, `hz-volcano`, `hz-earthquake`, `hz-tsunami`, `compound-toggle`, `target-name`, `target-coords`, `target-footprint`, `mode-pill`, `topnav`, `topnav-menu` (the `div` inside `#topnav` that `#menu-toggle` controls), `open-method`, `open-about`, `menu-toggle`.
  - `#mode-pill` holds `span.pill-main` ("● OBSERVED PASS") and `span.pill-suffix` (" // MEASURED"). JS sets both spans' text; CSS hides `.pill-suffix` on mobile.
- Controls: `controls`, `controls-drawer`, `pass-date`, `pass-index`, `no-pass-alert`, `view-toggle`, `btn-radar`, `btn-change`, `baseline-wrap`, `baseline`, `opacity`, `opacity-readout`, `opacity-lock`, `toggle-risk`, `toggle-reticle`, `legend`, `legend-radar`, `legend-change`, `legend-forecast`, `legend-risk`.
- Evidence: `evidence`, `evidence-drawer`, `provenance`, `map-error`, `asset-error`, `status-card`, `observed-card`, `observed-summary`, `observed-pass`, `observed-baseline`, `observed-point` (the three `dd` elements of `#observed-summary`), `forecast-card`, `forecast-date`, `forecast-prob`, `forecast-level`, `forecast-bar`, `forecast-driver`, `forecast-disclaimer`, `chart-risk`, `point-title`, `point-coords`, `chart-point`, `point-status`.
  - Each `figure` (`#chart-risk`, `#chart-point`) contains `div.chart-slot` followed by its `figcaption`. JS writes the SVG into `.chart-slot`, not into the figure, so the caption survives.
- Timeline: `timeline`, `play`, `track`, `seg-observed`, `now-tick`, `seg-forecast`, `date-slider`, `ticks`, `timeline-date`.
- Pages: `page`, `signin-form`, `signup-form`, `pw-error`, `notfound`.
- Dialogs and accessibility: `dlg-method`, `dlg-about`, `announcer`; heading IDs used by `aria-labelledby`: `dlg-method-title`, `dlg-about-title`, `signin-title`, `signup-title`; form field IDs: `signin-email`, `signin-password`, `signup-name`, `signup-email`, `signup-password`, `signup-confirm`.
- Root state: `data-mode` (`observed|forecast`), `data-hazard` (`volcano|earthquake|tsunami`), `data-route` (`home|signin|signup|notfound`), and `data-forecasts` (`none` when the forecast list is empty).

## 5. Text that must appear verbatim in the HTML
- `SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY`
- `NO SATELLITE PASS FOR THIS DATE`
- `Placeholder forecast. Swap in your model output.`
- `Sample probability · not validated`
- `LOCKED: 35% CONTEXT ONLY`
- `No future pixel brightness values — ever.`
- `Prototype: no account is created and nothing is sent.`

## 6. Forms
- Use native inputs with `<label>`, `autocomplete` (`email`, `current-password`, `new-password`, `name`) and `required`. The signup password has `minlength="8"`.
- Neither form has an `action` attribute. JS prevents submission and only routes.
