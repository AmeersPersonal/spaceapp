# CLAUDE.md — workstation/css

Styles for the workstation. Plain CSS with custom properties: no preprocessor, no framework, no build. See `spec.md` here for the tokens, type scale, layout and component specs. Read `../HANDOFF.md` §3 first, because the forecast safeguards are partly visual.

## Files (loaded in this order by `index.html`)
| File | Holds |
| --- | --- |
| `tokens.css` | `:root` custom properties, `@font-face`-free font stacks, global reset, base element styles, `.visually-hidden`, `.skip-link`, `.meta`. |
| `layout.css` | Positioning of `#map`, `#topbar`, `#controls`, `#evidence`, `#timeline`, `#page`, plus the `≤ 900px` mobile layout. |
| `components.css` | Everything inside the docks: buttons, toggle, select, range, checkboxes, legend, cards, prob bar, charts, dialogs, forms, 404, reticle marker, MapLibre control overrides. |

## Rules
- **Tokens only.** No raw colour literals outside `tokens.css`. If a needed colour is missing, add a token.
- **The semantic colours keep their meanings:**
  - `--risk-*`: risk only, drawn as circle or extent marks
  - `--change-*`: change only, drawn as square patches
  - `--error`: errors only
  - `--pale-sky`: action, selection and forecast signal
- **Forbidden everywhere:** `backdrop-filter`, `box-shadow` (other than `none`), `filter: blur`, `text-shadow` glow, gradients used as decoration, and any `border-radius` other than `0`. The only exceptions are the greyscale legend ramp, hatch patterns and the risk-legend circle marks (`50%`).
- **The HUD fill goes on the outer docks only** (`#topbar`, `#controls`, `#evidence`, `#timeline`). Everything inside stays `background: transparent`. Recorded exceptions (mobile only): the sticky drawer handles, which must cover content scrolling beneath them, and the `#hazard-switch` / `#topnav` dropdown, which is a fixed extension of the `#topbar` dock.
- **State is styled through attributes, never through JS-written styles:**
  - `html[data-mode="forecast"]`, `[data-hazard]`, `[data-route]`, `[data-forecasts="none"]`
  - `[hidden]`, `:disabled`, `[aria-pressed="true"]`
  - JS may set exactly three custom properties inline: `--p` on `#forecast-bar`, and `--obs` / `--fc` on `#track`
- **Forecast appearance must change in colour and in shape or text**, never colour alone: diamond thumb, dashed outlines, hatch, and the `FORECAST` wording that comes from the HTML or JS.
- Orbitron only on `.wordmark` and `.display-404`.
- `font-variant-numeric: tabular-nums` on every numeric readout.
- Motion: `transition: border-color 120ms linear, color 120ms linear, opacity 150ms cubic-bezier(.16,1,.3,1)`. Nothing else animates. `prefers-reduced-motion: reduce` turns all transitions off.
- Selectors: prefer IDs from `../spec.md` §4 and small reusable classes. Don't style tag names inside the docks except form controls.

## Verify
- Every `#id` you reference exists in `../index.html`.
- At 1440×1080 and 390×844: no horizontal scroll, `#evidence` scrolls internally, and the centre of the map is unobstructed on desktop.
- Grep for `box-shadow`, `backdrop-filter`, `border-radius` and `#` colour literals outside `tokens.css`. Each hit must be an allowed exception.
