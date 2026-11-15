# spec.md — workstation/css

## 1. Tokens (`tokens.css`, `:root`, verbatim)
```css
:root {
  /* Surfaces */
  --bg-canvas:#07090E; --bg-hud-well:rgba(10,14,21,.92); --bg-hud-elevated:#111722; --bg-plot-recessed:#05070B;
  /* Hairlines */
  --border-hairline:rgba(235,245,238,.14); --border-strong:rgba(235,245,238,.32); --border-active:#BFD1E5;
  /* Text */
  --text-primary:#EBF5EE; --text-secondary:#9FB0C4; --text-muted:#64748B;
  /* Brand (names preserved) */
  --blackberry-cream:#07090E;           /* redefined per brief */
  --blackberry-cream-legacy:#542344;    /* original brand value, kept on record */
  --pale-sky:#BFD1E5; --mint-cream:#EBF5EE; --desert-sand:#D8BFAA; --grey:#6E7681;
  /* Semantic, never decorative */
  --risk-high:#E5484D; --risk-medium:#F5A524; --change-darker:#2B83FF; --change-brighter:#FF8C28; --error:#FF8F8F;
  /* Spacing */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px; --space-6:24px;
  /* Added for this build */
  --font-wordmark:'Orbitron',sans-serif; --font-display:'Space Grotesk',sans-serif;
  --font-body:'Inter',system-ui,sans-serif; --font-mono:'IBM Plex Mono',ui-monospace,monospace;
  --dock-top:60px; --dock-gap:12px; --topbar-h:48px; --timeline-h:72px;
  --controls-w:300px; --evidence-w:360px;
  --ease:cubic-bezier(.16,1,.3,1);
  --hatch:repeating-linear-gradient(45deg,transparent 0 4px,rgba(191,209,229,.16) 4px 5px);
}
```

## 2. Base (`tokens.css`)
- `*, *::before, *::after { box-sizing: border-box; border-radius: 0; }`
- `html, body { height: 100%; margin: 0; overflow: hidden; }`
- `body { background: var(--bg-canvas); color: var(--text-primary); font: 400 12.5px/1.45 var(--font-body); }`
- Focus: `:focus-visible { outline: 1px solid var(--pale-sky); outline-offset: 2px; }`. Never remove outlines.
- `.visually-hidden`: the standard clip pattern. `.skip-link` is visible only on focus.
- `@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`

## 3. Typography
| Role | Selector(s) | Spec |
| --- | --- | --- |
| Wordmark | `.wordmark` | Orbitron 500, lowercase, `letter-spacing:0`, 18px. |
| 404 display | `.display-404` | Orbitron 500, `clamp(64px, 18vw, 220px)`, `letter-spacing:0`. |
| Titles | `h2`, `h3`, `#pass-date` | Space Grotesk 600, 15px/1.25, `-0.02em`. |
| Hero metric | `#forecast-prob` | Space Grotesk 500, 32px/1.0, `-0.02em`, tabular. |
| Body | `body`, `p` | Inter 12.5px/1.45. |
| Metadata | `.meta`, labels, badges, ticks, coords, pill, legend labels, chart text | IBM Plex Mono, uppercase, 10.5px/1.3, `0.08em`, tabular. |

Orbitron must never be used on any other selector.

## 4. Layout (`layout.css`)
### Desktop (> 900px)
| Element | Rules |
| --- | --- |
| `#map` | `position:fixed; inset:0; z-index:1`. |
| `#topbar` | `fixed; top:0; left:0; right:0; height:var(--topbar-h); z-index:20; display:flex`. Cells are separated by `border-left:1px solid var(--border-hairline)`. Bottom hairline. |
| `#controls` | `fixed; top:var(--dock-top); left:var(--dock-gap); width:var(--controls-w); max-height:calc(100vh - var(--dock-top) - var(--timeline-h) - 3*var(--dock-gap)); overflow-y:auto; z-index:15`. |
| `#evidence` | `fixed; top:var(--dock-top); right:var(--dock-gap); bottom:calc(var(--timeline-h) + 2*var(--dock-gap)); width:var(--evidence-w); overflow-y:auto; z-index:15`. 4px scrollbar (`scrollbar-width:thin` plus `::-webkit-scrollbar`), thumb `--border-strong`. |
| `#timeline` | `fixed; bottom:var(--dock-gap); left:var(--dock-gap); right:var(--dock-gap); height:var(--timeline-h); z-index:20`. A grid of `36px 1fr auto` (play, track, date); on ≤ 900px the play column is `var(--hit-mobile)` so the button is a 44px square. |
| `#page` | `fixed; inset:var(--topbar-h) 0 0 0; z-index:25; background:var(--bg-canvas)`. Content is centred, max 360px wide, and the panel scrolls. When `html[data-route!="home"]`, hide `#controls`, `#evidence` and `#timeline`. |
| `summary` of drawers | `display:none` on desktop. Details are always open. |

The `.hud` dock surface is `background:var(--bg-hud-well); border:1px solid var(--border-hairline); position:fixed`, plus the corner reticles (§5.1).

### Mobile (≤ 900px)
- `#topbar`: `#target-cell` and the hazard labels collapse. Show the wordmark, `#mode-pill` (short form via CSS: hide the `// …` suffix span) and `#menu-toggle`. `#topnav` links move into a dropdown below the bar, shown when `[aria-expanded=true]`. The hazard switch becomes a compact 3-item row inside that dropdown.
- `#timeline`: `bottom:0; left:0; right:0`. `#ticks` shows every other label.
- `#controls` and `#evidence`: floating drawers over the map, both `left:8px; right:8px; width:auto`.
  - `#controls` sits under the top bar. `#evidence` sits above the timeline.
  - `summary` is visible as the drawer handle (mono, uppercase).
  - Body `max-height: 38vh; overflow-y:auto`.
  - Closed by default via JS on load at this width.
- Nothing may exceed `100vw`. `min-width:0` on flex children. Long mono strings use `overflow-wrap:anywhere`.
- The map is never pushed into document flow.

## 5. Components (`components.css`)
### 5.1 Corner reticles
`.hud::before` and `.hud::after` draw 6px L-brackets in `--border-strong` at the top-left and bottom-right using 1px borders on two sides, `pointer-events:none`. No other decoration.

### 5.2 Mode pill (`#mode-pill`)
- Mono. 1px border `--mint-cream`. Text is `● OBSERVED PASS // MEASURED`, set by JS.
- Under `html[data-mode=forecast]`: border and text `--pale-sky`, `background-image:var(--hatch)` (the one allowed hatch fill), text `◆ FORECAST MODE // MODEL PROJECTION`.

### 5.3 Buttons and toggle
- Transparent, 1px `--border-hairline`, mono label, minimum hit area 32px desktop / 44px mobile.
- Hover: border `--border-strong`.
- `[aria-pressed=true]`: border and text `--pale-sky`, with a 2px inset bottom line built from the border, not a shadow.
- `:disabled`: text `--grey`, `background-image:var(--hatch)`, `text-decoration:line-through`, `cursor:not-allowed`.

### 5.4 Select (`#baseline`)
`appearance:none`, transparent, 1px hairline, mono, with a custom caret drawn by a CSS triangle on the wrapper. Option backgrounds use `--bg-hud-elevated` (needed for native dropdown legibility).

### 5.5 Range inputs (`#opacity`, `#date-slider`)
- `appearance:none`. Track is a 1px line in `--border-strong`.
- Thumb: 12px **circle** (the one allowed radius) in `--mint-cream`.
- Under `html[data-mode=forecast]`: the `#date-slider` thumb becomes a 12px **square rotated 45°** in `--pale-sky`, and `#opacity` is disabled with its thumb in `--grey`.
- Style both `::-webkit-slider-thumb` and `::-moz-range-thumb`.
- `#date-slider` sits over `#track` with `position:absolute; inset:0; width:100%`. Its track is transparent because the segments behind it draw the track.

### 5.6 Timeline track
- `#seg-observed`: a solid 1px line in `--mint-cream`, label above in mono `--text-secondary`.
- `#seg-forecast`: `background-image:var(--hatch)`, a dashed top border in `--pale-sky`, label in `--pale-sky`.
- `#now-tick`: a 1px vertical line in `--pale-sky`, label above.
- JS sets segment widths through the grid template (`--obs` / `--fc` custom properties on `#track`; these are allowed alongside `--p`).
- `html[data-forecasts=none]` hides `#seg-forecast` and `#now-tick`.
- Tick buttons: mono 10px, `--text-secondary`. The current tick is `--text-primary` with an underline. Forecast ticks are `--pale-sky` and italic-free (shape change comes from the thumb).

### 5.7 Checkboxes
`appearance:none`, 12px square, 1px `--border-strong`. Checked state is an inner 6px square in `--pale-sky`, drawn with `background` clipped through `background-clip:content-box; padding:2px`.

### 5.8 Legend
- Hooks (as written in `index.html`): `#legend-radar > .legend-ramp` + `.legend-ramp-labels > .legend-text`; `#legend-change > .legend-key > .legend-patch[data-change]` + `.legend-text`; `#legend-risk li > .legend-mark[data-risk]` + `.legend-text`. (`.ramp` / `.legend-row` remain as aliases.)
- Ramp: 8px tall, `linear-gradient(to right,#000,#fff)` (allowed: it is a data key).
- Change patches: 10px **squares** in `--change-darker` / `--change-brighter`.
- Risk marks: 10px **circles** with a 2px border in `--risk-high` / `--risk-medium` and a transparent centre. Under forecast, the border is `dashed`.

### 5.9 Alerts, provenance and errors
- `#provenance`: mono, `--desert-sand`, 1px dashed `--desert-sand` border, and padding.
- `#no-pass-alert`: mono, `--pale-sky` text, 1px solid `--pale-sky` border.
- `#map-error`, `#asset-error`, `#pw-error`: `--error` text, 1px `--error` border.

### 5.10 Forecast card
- 1px `--pale-sky` border with a hatch strip along the top edge (8px, `var(--hatch)`).
- `#forecast-level`: mono, 1px border whose colour depends on `data-level` (`high` → `--risk-high`, `medium` → `--risk-medium`, `low` → `--text-secondary`), transparent background.
- `.prob-bar`: 6px, 1px hairline. `#forecast-bar` has `width:calc(var(--p) * 1%)`, a background of `--pale-sky` with a hatch overlay (a filled data mark is allowed).
- `#forecast-disclaimer`: Inter 12.5px, `--text-primary`, with a 2px left border in `--pale-sky`.

### 5.11 Charts (SVG classes from `js/charts.js`)
| Class | Style |
| --- | --- |
| `figure` | `margin:0`, `background:var(--bg-plot-recessed)`, 1px hairline, `padding:var(--space-2)`. |
| `.chart` | `width:100%; height:auto; display:block`. |
| `.chart-grid` | stroke `--border-hairline`, 1px. |
| `.chart-axis` | fill `--text-secondary`, mono 9px, tabular. |
| `.chart-hatch` | `fill:url(#hatch-<id>)`. The pattern lines stroke `rgba(191,209,229,.18)`. |
| `.chart-now` | stroke `--pale-sky`, 1px. Label in `.chart-axis` with fill `--pale-sky`. |
| `.chart-line` | stroke `--mint-cream`, 1.5px, no fill. |
| `.chart-line--model` | stroke `--pale-sky`, `stroke-dasharray:4 3`. |
| `.chart-dot` | fill `--mint-cream`, r 2.5. Clickable, `cursor:pointer`. |
| `.chart-dot--active` | r 4.5, `stroke:var(--bg-plot-recessed)`, 1.5px. |
| `.chart-diamond--active` | fill `--pale-sky` (a square rotated 45°). |
| `.chart-dot--model` | non-active model mark (rotated square): fill `--pale-sky`. Never carries `.chart-dot`. |
| `.chart-hit` | invisible r=9 hit group around each mark, `cursor:pointer`. |
| `.chart-empty` | mono, `--text-secondary`, centred in the hatch. Also styles the pre-JS `<p class="chart-empty">` in `.chart-slot`. |

### 5.12 Dialogs
`dialog` has `background:var(--bg-hud-well)`, 1px `--border-strong`, max 520px wide, Inter body text. `::backdrop` is `rgba(7,9,14,.7)`, a flat dim (no blur).

### 5.13 Forms and 404
- Inputs are transparent with a 1px hairline and `--pale-sky` border on focus. Labels are mono.
- 404: `.display-404` centred, with the meta line and link beneath.

### 5.14 Map overrides
- `.maplibregl-ctrl-group`: transparent, 1px hairline, no shadow, no radius. Its buttons take `--bg-hud-well` (hover `--bg-hud-elevated`) — a deliberate exception so the zoom glyphs stay legible over bright basemap areas; the control floats over the map, outside any dock. Buttons inverted to `--text-primary` icons via `filter:invert(1)` on the icon only (allowed: it is not a blur).
- Attribution is mono 9px on `--bg-hud-well`, always visible. On desktop it is offset above `#timeline` and left of `#evidence`.
- `.reticle-marker`: a 24px crosshair in `--pale-sky`, 1px, with a central 4px gap, drawn with pseudo-elements. It is hidden when `#toggle-reticle` is unchecked (JS adds `[hidden]`).
