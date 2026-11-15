# CLAUDE.md — workstation (HTML layer)

A standalone, no-build NISAR-style telemetry workstation: `index.html`, plus styles in `css/` and ES modules in `js/`. It is independent of `../Frontend/`. Never import from that folder or modify it.

Before working here, read `HANDOFF.md` (the cross-cutting rules and acceptance checklist), then `spec.md` (page structure and DOM contract). Each subfolder has its own `CLAUDE.md` and `spec.md`.

## The rule that governs every change
**Never let a prediction look like a measurement.** On forecast dates the raster locks to 35%, the view modes disable, the slider and pill turn pale-sky diamond `FORECAST`, and a prediction card with the exact disclaimer `Placeholder forecast. Swap in your model output.` appears. If a change blurs that distinction, it is wrong even if it looks better.

## Run
```bash
python -m http.server 5173     # from this folder; open http://localhost:5173/#/
```
Use HTTP, not `file://`, because ES modules need it.

## Rules for `index.html`
- **Markup only.** No inline `<style>`, no inline `style=""`, no inline `<script>` code, no `on*=` handlers. The only scripts are:
  - the pinned MapLibre CDN tag (classic script, loaded first)
  - `<script type="module" src="js/main.js">`
- **The DOM contract in `spec.md` is fixed.** Don't rename or remove an ID. If you add one, add it to `spec.md`.
- Use semantic elements, not div soup: `header`, `aside`, `footer`, `main`, `dialog`, `form`, `label`, `button`, `fieldset`/`legend` for grouped controls.
- Every control has a visible or `aria-label` name. Toggle buttons use `aria-pressed`.
- All visible text that never changes lives in the HTML. Text that depends on state is filled in by JS, but give each slot a sensible default so the page reads correctly before JS runs.
- The scientific warnings (provenance strip, disclaimer text) are written **in the HTML**, so they survive a JS failure.
- Orbitron appears only on elements with class `wordmark` or `display-404`.

## Verify
- IDs are unique, and every JS lookup and CSS `#id` selector matches an ID here (see `HANDOFF.md` §7).
- The page still shows the docks, provenance strip and a map error when MapLibre is blocked.
