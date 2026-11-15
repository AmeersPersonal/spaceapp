/* Diagram definitions for the workstation build.
 *
 * WHAT CHANGED
 *   The previous version of this file described the React/Vite app in
 *   Frontend/ (navbar, /signin, /signup, a 2-column Map Explorer). That app is
 *   being superseded by the no-build vanilla-JS workstation in workstation/.
 *   These diagrams now describe the workstation, following its specs:
 *     workstation/HANDOFF.md        cross-cutting rules + acceptance checklist
 *     workstation/spec.md           DOM contract
 *     workstation/js/spec.md        module contracts, state, render, router
 *     workstation/BUILD_HANDOFF.md  what is built, what is verified, what is not
 *   Where the diagrams and those specs disagree, the specs win. Fix the
 *   diagram here.
 *
 *   The root handoff.md still embeds the OLD diagrams. It was the design brief
 *   for the React app, and workstation/HANDOFF.md overrides it.
 *
 * THE DIAGRAMS
 *   architecture   files, layers, and which module may import which
 *   routes         hash routes, dialogs, and where each one leads
 *   renderLoop     event → state → deriveView → render/applyMapState
 *   forecastLocks  observed vs forecast, and the seven locks applied together
 *   boot           start-up order and the failure matrix (no silent fallbacks)
 *   buildStatus    BUILD_HANDOFF.md §3–§5 as a gate: what must happen before
 *                  Frontend/ is replaced
 *
 * TO RENDER
 *   import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs'
 *   import { diagrams } from './mermaid.js'
 *   mermaid.initialize({ startOnLoad: false, theme: 'dark' })
 *   const { svg } = await mermaid.render('d1', diagrams.forecastLocks)
 *
 *   Or paste any string into https://mermaid.live.
 */

// Three layers, one direction. HTML owns the IDs, CSS styles them, and JS
// reads them and sets data-* attributes. JS never writes colours or layout.
// Every module's imports point toward config.js, and nothing imports main.js.
export const architecture = `
flowchart LR
  subgraph Ext["Loaded from the network"]
    ML["MapLibre GL 4.7.1<br/>classic script → window.maplibregl"]
    Fonts["Google Fonts<br/>Orbitron · Space Grotesk · Inter · IBM Plex Mono"]
    Tiles["OpenFreeMap 'liberty' tiles<br/>recoloured to the obsidian palette"]
  end

  subgraph HTML["index.html: markup only"]
    DOM["Stable IDs = the DOM contract<br/>(spec.md §4)"]
    Root["html data-mode · data-hazard ·<br/>data-route · data-forecasts"]
  end

  subgraph CSS["css/: all appearance"]
    Tok["tokens.css"] --> Lay["layout.css"] --> Comp["components.css"]
  end

  subgraph JS["js/: ES modules, no build step"]
    Main["main.js<br/>state · render · events · router"]
    Cfg["config.js<br/>CONFIG + HAZARD_REGISTRY"]
    Tel["telemetry.js<br/>TelemetryService · rasters"]
    Map["map.js<br/>sources · layers · applyMapState"]
    Ch["charts.js<br/>SVG strings, pure"]
  end

  Main --> Cfg
  Main --> Tel
  Main --> Map
  Main --> Ch
  Tel --> Cfg
  Map --> Cfg

  Main -- "textContent · hidden · disabled · aria-*" --> DOM
  Main -- "sets" --> Root
  Root -- "the ONLY channel from state to appearance" --> CSS
  CSS -- "styles" --> DOM
  ML -.-> Map
  Tiles -.-> Map
  Fonts -.-> CSS

  Dev["dev-server.mjs<br/>npm run dev → :5173<br/>(HTTP required for ES modules)"] -.serves.-> HTML
`

// Hash router plus two modal dialogs. The workstation is always underneath.
// Routes are an overlay (#page), not separate pages.
export const routes = `
flowchart LR
  Home["#/ : home<br/><b>the workstation</b><br/>map + docks + timeline"]
  SignIn["#/signin<br/>prototype form"]
  SignUp["#/signup<br/>prototype form"]
  NF["anything else<br/>404 overlay"]
  Anchor["#controls etc.<br/>in-page anchor"]
  Method[["dialog: Method"]]
  About[["dialog: About"]]

  Home -- "Sign in" --> SignIn
  SignIn -- "submit: reset, nothing sent" --> Home
  SignIn -- "create account" --> SignUp
  SignUp -- "passwords differ" --> SignUp
  SignUp -- "submit: reset, nothing sent" --> SignIn
  NF -- "Back to workstation" --> Home
  Anchor -- "focus element, stay home" --> Home
  Home -- "Method" --> Method
  Home -- "About" --> About
  Method -- "Close / Esc" --> Home
  About -- "Close / Esc" --> Home
`

// One state object, one render(). Handlers only mutate state. deriveView() is
// pure and computes the effective values, so forecast never overwrites the
// user's observed settings.
export const renderLoop = `
flowchart TB
  subgraph Events
    E1["slider / tick click → idx"]
    E2["play timer → idx = (idx+1) % len"]
    E3["mode · baseline · opacity · toggles"]
    E4["hazard radio → reset idx, mode, point"]
    E5["map click → point or outside"]
    E6["hashchange → route"]
  end

  State[("state<br/>hazard · idx · mode · baseline ·<br/>observedOpacity · showRisk · point ·<br/>playing · route · errors")]

  Derive["deriveView(state): pure<br/>isForecast = idx ≥ observedCount<br/>rasterOpacity = isForecast ? 0.35 : observedOpacity/100<br/>showChange = !isForecast and mode = change<br/>imageIndex = isForecast ? last observed : idx"]

  Render["render()<br/>root data-* · top bar · controls ·<br/>evidence · charts · timeline · announcer"]
  Apply["applyMapState(map, view)<br/>idempotent: raster · change · risk · reticle"]
  Charts["charts.js<br/>riskChart · pointChart"]

  E1 & E2 & E3 & E4 & E5 & E6 --> State
  State --> Derive --> Render
  Render --> Charts
  Render --> Apply

  Guard{{"In forecast, handlers never assign<br/>mode / observedOpacity / baseline"}}
  E3 -.- Guard
`

// The rule that governs every change: a prediction must never look like a
// measurement. Crossing NOW applies all seven locks in one render() pass.
// Crossing back restores the user's settings untouched.
export const forecastLocks = `
stateDiagram-v2
  direction LR

  [*] --> Observed: load / hazard switch → idx = last observed (20 Jun 2026)

  state "OBSERVED: measured sample pass (idx 0–5)" as Observed {
    [*] --> Radar
    Radar --> Change: "Change since"
    Change --> Radar: "Radar image"
    Radar: Raster at user opacity (default 85%)
    Change: Blue = darker / orange = brighter than baseline<br/>Baseline select visible (6 dates)
  }

  state "FORECAST: placeholder model (idx 6–9)" as Forecast {
    [*] --> Locked
    Locked: 1. Last raster at exactly 0.35, slider LOCKED<br/>2. View buttons disabled, baseline + change hidden<br/>3. Pale-sky diamond thumb + FORECAST wording<br/>4. NO SATELLITE PASS FOR THIS DATE<br/>5. Prediction card + exact disclaimer<br/>6. Dashed risk extents, hatched chart future<br/>7. No future point values, shows No data yet
  }

  Observed --> Forecast: idx 5 → 6 (cross NOW)
  Forecast --> Observed: back before NOW, restores mode/opacity/baseline
  Forecast --> Observed: play wraps 9 → 0

  note right of Forecast
    CONFIG.forecasts = [] removes this state:
    no hatch, no NOW line, charts still render
  end note
`

// Boot order and the failure matrix. Every failure is explicit, and nothing
// synthetic is ever substituted for missing data.
export const boot = `
flowchart TB
  B1["1. new TelemetryService"] --> B2{"2. createMap()"}
  B2 -- ok --> B3["3. on load: styleBasemap → addLayers → render"]
  B2 -- "maplibregl missing / throws" --> F1["#map-error: Map unavailable…<br/>docks, charts, timeline still work"]
  B3 --> B4{"4. load observed rasters<br/>Promise.all(getRaster)"}
  B4 -- ok --> B5["5. route()"]
  B4 -- "external PNG fails" --> F2["#asset-error, raster hidden<br/><b>no procedural substitute</b>"]
  F1 --> B4
  F2 --> B5
  B5 --> B6["6. collapse drawers if ≤ 900px"]
  B6 --> B7["7. first render() runs immediately,<br/>the UI works without the map"]

  T["tiles / style error at any time"] --> F3["#map-error: Map tiles failed to load…"]
  BK["useLiveBackend fetch fails"] --> F4["#map-error: Live backend unavailable…<br/><b>registry mock NOT shown as live</b>"]

  P["Always visible, in HTML so it survives a JS failure:<br/>SYNTHETIC DEMONSTRATION // NOT LIVE NISAR TELEMETRY"]
`

// Where the build stands (BUILD_HANDOFF.md). Replacing Frontend/ is gated on
// closing the verification gap, because the adversarial review was cut off
// by the org spend limit.
export const buildStatus = `
flowchart LR
  subgraph Done["Done and verified"]
    D1["9 deliverables written<br/>index.html · 3 CSS · 5 JS · README"]
    D2["node --check: all pass"]
    D3["DOM-ID cross-check: all pass"]
    D4["Verbatim strings + config values match spec"]
    D5["4 integration mismatches fixed"]
  end

  subgraph Gap["Not verified: the gap"]
    G1["35 of 47 review findings unverified<br/>(spend limit, not real verdicts)"]
    G2["No real browser run yet<br/>WebGL · CDN · fonts · tiles"]
    G3["Viewports 1440×1080 / 390×844 unchecked"]
    G4["Edge configs unchecked:<br/>forecasts = [] · MapLibre blocked · missing PNG"]
  end

  subgraph Next["Next steps, in order"]
    N1["1. add window.__spaceapp test hook to main.js"]
    N2["2. run pw/accept.mjs (Playwright, free)"]
    N3["3. triage journal.jsonl review findings by hand"]
    N4["4. fix what both confirm"]
    N1 --> N2 --> N3 --> N4
  end

  Ship{{"5. replace Frontend/ with workstation/"}}

  Done --> Next
  Gap --> Next
  N4 --> Ship
  Gap -. "blocks until closed" .-x Ship
`

export const diagrams = {
  architecture,
  routes,
  renderLoop,
  forecastLocks,
  boot,
  buildStatus,
}
