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
`<html lang="en" data-mode="observed" data-hazard="volcano" data-route="home">`. JS updates these, plus `data-source` (`demo` = channels 01–03, `live` = channel 04) and `data-forecasts`. CSS keys appearance off them.

## 3. Body structure (in DOM order = tab order)

```
body
├── a.skip-link[href="#controls"]              "Skip to controls"
├── div#map[role=region][aria-label="Map of the study area"]
├── header#topbar.hud
│   ├── a.wordmark[href="#/"]                   "spaceapp"
│   │   ├── span.meta.wm-demo "NISAR-SIM // L-BAND SAR"     (shown on demo channels)
│   │   └── span.meta.wm-live "NISAR LIVE // L-BAND SAR"    (shown on the live channel)
│   ├── fieldset#hazard-switch  (legend.visually-hidden "Hazard channel")
│   │   ├── input#hz-volcano[type=radio name=hazard value=volcano checked] + label "01 // VOLCANIC SAR"
│   │   ├── input#hz-earthquake[...value=earthquake]                       + label "02 // SEISMIC FAULT"
│   │   ├── input#hz-tsunami[...value=tsunami]                             + label "03 // TSUNAMI PROPAGATION"
│   │   ├── input#hz-live[...value=live]                                   + label "04 // LIVE NISAR"  (Earth Replay API)
│   │   └── label.compound-label > input#compound-toggle[type=checkbox] "+ COMPOUND OVERLAY"  (hidden on live)
│   ├── div#target-cell
│   │   ├── span#target-name   "TARGET: ASO CALDERA, JP"
│   │   ├── span#target-coords "32.884° N, 131.104° E"
│   │   └── span#target-footprint "FOOTPRINT: — KM"     (JS computes from bounds)
│   ├── div#mode-pill[role=status]  "● OBSERVED PASS // MEASURED"
│   └── nav#topnav
│       ├── button#open-method "Method"
│       ├── button#open-about  "About"
│       ├── a#nav-signin[href="#/signin"] "Sign in"      (hidden when signed in)
│       ├── span#nav-user.meta[hidden]                    (signed-in user's name)
│       ├── a#nav-signout[href="/auth/logout"][hidden] "Sign out"
│       └── button#menu-toggle[aria-expanded=false][aria-controls=topnav-menu]  (mobile only, CSS-hidden on desktop)
├── main#workspace
│   ├── aside#controls.hud[aria-label="Sensor and layer controls"]
│   │   └── details#controls-drawer[open] > summary "Controls"  (summary visible only on mobile)
│   │       ├── section#pass-header
│   │       │   ├── h2#pass-date "20 JUN 2026"
│   │       │   ├── p#pass-index.meta "PASS 06 / 06"
│   │       │   └── p#no-pass-alert[hidden] "NO SATELLITE PASS FOR THIS DATE"
│   │       ├── section#live-controls[hidden]  (live channel only)
│   │       │   ├── label "Event" + select#live-event  (JS fills from GET /api/events; "Replay: …" while replaying)
│   │       │   ├── p#live-events-note.meta
│   │       │   ├── label#live-layer-wrap[hidden] "Layer" > select#live-layer  (ASF previews + processed layers)
│   │       │   ├── div#live-actions > button#live-fit "Zoom to data", button#live-outlook[aria-pressed] "Quake outlook"
│   │       │   ├── p#live-pass-note.meta
│   │       │   └── form#room-form > h3#room-title, div.room-row > input#room-code + button#room-join + button#room-leave[hidden], p#room-status
│   │       ├── div#view-toggle   (hidden on live)[role=group][aria-label="View mode"]
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
│   │           ├── ul#legend-live[hidden]  (live only: preview ramp, event area, explored area, li#legend-outlook[hidden] hatched modelled cell)
│   │           └── ul#legend-risk        (two circle marks; li text filled by JS: "(measured extent)" / "(projected extent, dashed)")
│   └── aside#evidence.hud[aria-label="Evidence"]
│       ├── p#provenance.meta "SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY"  (every demo channel)
│       ├── p#provenance-live.meta[hidden] "LIVE NISAR CATALOG // ASF PREVIEWS ARE QUICKLOOKS, NOT CALIBRATED MEASUREMENTS // NOT REAL-TIME MONITORING"  (live channel)
│       ├── p#provenance-sim.meta[hidden] "SIMULATED ILLUSTRATION // IMAGERY AND EXTENTS ARE FABRICATED …"  (live channel, only while #live-sim is on)
│       ├── p#map-error[hidden][role=alert]
│       ├── p#asset-error[hidden][role=alert]
│       ├── p#backend-status.meta[role=status][data-state=checking|online|offline]  "BACKEND LINK: … // DEMO CHANNEL DATA IS NOT FROM IT" (live: "// LIVE CHANNEL DATA COMES FROM IT")
│       │   (these sit outside the drawer so a collapsed mobile drawer
│       │    never hides the provenance strip or an error — HANDOFF §3)
│       └── details#evidence-drawer[open] > summary "Evidence"
│           ├── section#live-panel[hidden]  (live only; JS builds the *-body blocks with textContent)
│           │   ├── div#live-view-event
│           │   │   ├── div#live-event-head
│           │   │   ├── section#live-projection.model-card  (h3 "◆ Model projection", MODELLED label, div#live-projection-body, button#live-predict)
│           │   │   ├── section#live-briefing  (div#live-briefing-body, button#live-brief)
│           │   │   ├── section#live-ask  (div#live-ask-log, form#live-ask-form > input#live-ask-input + button#live-ask-submit, p#live-ask-note)
│           │   │   ├── section#live-context > div#live-context-body
│           │   │   ├── section#live-media > div#live-media-body
│           │   │   └── section#live-scenes > div#live-scenes-body
│           │   ├── div#live-view-area[hidden]  (button#live-area-close, p#live-area-coords, fieldset#live-range > input#live-range-start/end[type=date], div#live-area-body)
│           │   └── div#live-view-outlook.model-card[hidden]  (button#live-outlook-close, MODELLED label, div#live-horizon > button[data-horizon], button#live-outlook-view, div#live-outlook-body)
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
│   ├── form#signin-form[method=get action=/auth/login]  (p#signin-status, button#signin-submit "Continue to sign in", a#signin-signout[href=/auth/logout][hidden], link "#/signup")
│   ├── form#signup-form[method=get action=/auth/login]  (input[type=hidden name=screen_hint value=signup], p#signup-status, button#signup-submit "Create an account", link "#/signin")
│   └── div#notfound       (p.display-404 "spaceapp", p.meta "404 · PAGE NOT FOUND", a[href="#/"] "Back to workstation")
├── dialog#dlg-method[aria-labelledby]  (h2, method text: synthetic SAR, change detection, placeholder forecast; button.dialog-close "Close")
├── dialog#dlg-about[aria-labelledby]   (h2, project/limitations text; button.dialog-close "Close")
└── div#announcer.visually-hidden[aria-live=polite]
```

## 4. Contract summary (stable IDs)
These are the hooks for JS, CSS and tests. Don't rename them.
- Top bar: `topbar`, `hazard-switch`, `hz-volcano`, `hz-earthquake`, `hz-tsunami`, `hz-live`, `compound-toggle`, `target-name`, `target-coords`, `target-footprint`, `mode-pill`, `topnav`, `topnav-menu` (the `div` inside `#topnav` that `#menu-toggle` controls), `open-method`, `open-about`, `nav-signin`, `nav-user`, `nav-signout`, `menu-toggle`.
- Simulated illustration (live only): `sim-badge` (map watermark, sibling of `#map`), `provenance-sim`.
- Live controls: `live-controls`, `live-event`, `live-events-note`, `live-layer-wrap`, `live-layer`, `live-actions`, `live-fit`, `live-outlook`, `live-sim`, `live-sim-model-wrap`, `live-sim-model`, `live-pass-note`, `room-form`, `room-title`, `room-code`, `room-join`, `room-leave`, `room-status`, `legend-live`, `legend-outlook`.
- Live evidence: `provenance-live`, `live-panel`, `live-view-event`, `live-event-head`, `live-projection`, `live-projection-title`, `live-projection-body`, `live-predict`, `live-briefing`, `live-briefing-title`, `live-briefing-body`, `live-brief`, `live-ask`, `live-ask-title`, `live-ask-log`, `live-ask-form`, `live-ask-input`, `live-ask-submit`, `live-ask-note`, `live-context`, `live-context-title`, `live-context-body`, `live-media`, `live-media-title`, `live-media-body`, `live-scenes`, `live-scenes-title`, `live-scenes-body`, `live-view-area`, `live-area-title`, `live-area-close`, `live-area-coords`, `live-range`, `live-range-start`, `live-range-end`, `live-area-body`, `live-view-outlook`, `live-outlook-title`, `live-outlook-close`, `live-horizon`, `live-outlook-view`, `live-outlook-body`.
  - `#mode-pill` holds `span.pill-main` ("● OBSERVED PASS") and `span.pill-suffix` (" // MEASURED"). JS sets both spans' text; CSS hides `.pill-suffix` on mobile.
- Controls: `controls`, `controls-drawer`, `pass-date`, `pass-index`, `no-pass-alert`, `view-toggle`, `btn-radar`, `btn-change`, `baseline-wrap`, `baseline`, `opacity`, `opacity-readout`, `opacity-lock`, `toggle-risk`, `toggle-reticle`, `legend`, `legend-radar`, `legend-change`, `legend-forecast`, `legend-risk`.
- Evidence: `evidence`, `evidence-drawer`, `provenance`, `map-error`, `asset-error`, `backend-status`, `status-card`, `observed-card`, `observed-summary`, `observed-pass`, `observed-baseline`, `observed-point` (the three `dd` elements of `#observed-summary`), `forecast-card`, `forecast-date`, `forecast-prob`, `forecast-level`, `forecast-bar`, `forecast-driver`, `forecast-disclaimer`, `chart-risk`, `point-title`, `point-coords`, `chart-point`, `point-status`.
  - Each `figure` (`#chart-risk`, `#chart-point`) contains `div.chart-slot` followed by its `figcaption`. JS writes the SVG into `.chart-slot`, not into the figure, so the caption survives.
- Timeline: `timeline`, `play`, `track`, `seg-observed`, `now-tick`, `seg-forecast`, `date-slider`, `ticks`, `timeline-date`.
- Pages: `page`, `signin-form`, `signin-status`, `signin-submit`, `signin-signout`, `signup-form`, `signup-status`, `signup-submit`, `notfound`. (Removed with the move to Auth0: `pw-error`, `signin-email`, `signin-password`, `signup-name`, `signup-email`, `signup-password`, `signup-confirm`.)
- Dialogs and accessibility: `dlg-method`, `dlg-about`, `announcer`; heading IDs used by `aria-labelledby`: `dlg-method-title`, `dlg-about-title`, `signin-title`, `signup-title`.
- Root state: `data-mode` (`observed|forecast`), `data-hazard` (`volcano|earthquake|tsunami`), `data-route` (`home|signin|signup|notfound`), `data-source` (`demo|live`), and `data-forecasts` (`none` when the forecast list is empty — always on the live channel).

## 5. Text that must appear verbatim in the HTML
- `SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY`
- `NO SATELLITE PASS FOR THIS DATE`
- `Placeholder forecast. Swap in your model output.`
- `Sample probability · not validated`
- `LOCKED: 35% CONTEXT ONLY`
- `No future pixel brightness values — ever.`
- `LIVE NISAR CATALOG // ASF PREVIEWS ARE QUICKLOOKS, NOT CALIBRATED MEASUREMENTS // NOT REAL-TIME MONITORING`
- `MODELLED FROM THIS EVENT'S NISAR TIME SERIES · NOT AN OBSERVATION` and `MODELLED, NOT OBSERVED` (the two modelled cards)

## 6. Forms
- **Auth (`#signin-form`, `#signup-form`)**: accounts live in Auth0. Each form is a plain `GET` to `/auth/login` (sign-up adds `screen_hint=signup`); the API redirects to Auth0's hosted page and back to `FRONTEND_URL` (`:5173`). There are **no email or password fields** in this page, so no credential can be read, logged or stored here. JS only blocks the submit while sign-in is unavailable or already done.
- **`#live-ask-form`**: a question (3–500 chars) for `POST /api/ask`; disabled when signed out.
- **`#room-form`**: a 4–12 character room code for the replay WebSocket.
