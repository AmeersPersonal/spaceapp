# Build handoff — workstation (session paused on org spend limit)

**Status: build complete, integration-verified, adversarial review interrupted mid-verification.**
Do not replace `Frontend/` with this yet — see §4 before shipping.

## 1. What exists

All nine deliverables from `HANDOFF.md` §8 are written and in place:

```
workstation/
├── index.html
├── README.md
├── css/{tokens,layout,components}.css
└── js/{config,telemetry,charts,map,main}.js
```

Built by a background Workflow (`run id wf_44d0f485-ab3`), one agent per file/group,
each briefed from `HANDOFF.md`, the layer `CLAUDE.md`/`spec.md` files, and the ported
ideas from `../Frontend/src/mapview.jsx` and `studyArea.js` (not imported, not modified).

## 2. What has been verified (integration pass — done, passed)

Run against the actual files, not just claimed:

- `node --check` on every file in `js/` — all pass.
- DOM-ID cross-check (IDs in `index.html` unique; every `getElementById`/`#id` in
  `js/*.js` resolves; every `#id` selector in `css/*.css` resolves) — all pass.
  Script is saved at
  `C:\Users\husse\AppData\Local\Temp\claude\f94de4d18a4cd44d\6734716e-57cb-4b5f-99d8-0040f77a7c74\scratchpad\check-ids.mjs`
  (it was patched once to stop flagging `#E5484D`/`#F5A524` MapLibre paint colours
  as bad id-selectors — that patch is already applied).
- CSS grep for `box-shadow` / `backdrop-filter` / `blur(` / `border-radius` /
  `text-shadow` / colour literals outside `tokens.css` — only allowed exceptions
  found (range-thumb circle, `.legend-mark` circle, `box-shadow:none` on MapLibre
  control overrides).
- `index.html` grep for `style=`, `<style`, `on*=` — none found.
- Every verbatim string required by `spec.md` §5 — present, byte-checked.
- `config.js` dates/risk/probability values vs `HANDOFF.md` §3 — match exactly.
- Module contracts (every import resolves to a real export, call signatures match,
  the two inline custom properties `--p`/`--obs`/`--fc` are the only ones JS sets,
  HTML hooks JS reads/writes all exist) — read through and confirmed.
- The seven forecast locks (`HANDOFF.md` §3) are applied together in one
  `render()`/`deriveView()` pass; no forecast branch writes `state.mode`,
  `state.observedOpacity`, or `state.baseline` — confirmed by code read.

### Mismatches found and fixed during integration

1. `css/components.css` legend selectors (`.ramp`, `.legend-row`) didn't match
   `index.html`'s actual classes (`.legend-ramp`, `.legend-ramp-labels`,
   `.legend-key`) — added the real selectors, kept old ones as aliases.
2. `charts.js` emits a `.chart-dot--model` mark (non-active forecast point,
   deliberately not `.chart-dot` so it never inherits the measurement colour) and
   a `.chart-hit` invisible click target — neither had CSS. Added both, plus
   styling for the pre-JS `.chart-empty` placeholder `<p>`.
3. Top nav items live inside `div#topnav-menu` in the HTML, but CSS targeted
   `#topnav > button/a` directly — the mobile dropdown would have shown one box
   instead of three 44px rows. Fixed with `#topnav-menu { display: contents }`
   and retargeted selectors.
4. `css/spec.md` updated to record the real legend class names and the two new
   chart classes, so the spec stays accurate per `HANDOFF.md`'s own instruction.

One known cosmetic issue, **not fixed, low stakes**: `charts.js` centres the
`.chart-empty` text with a +3px manual offset, and `components.css` also sets
`dominant-baseline: middle` on `.chart-empty`. The empty-state message may sit
~3px low. Harmless; fix by dropping one of the two offsets if it bothers you.

## 3. What has NOT been verified — this is the gap

The workflow's **adversarial review round** (7 parallel lenses over the full
acceptance checklist) ran and surfaced candidate findings, but the **verify**
step — one subagent per finding, trying to refute it against the real files —
hit the organization's spend limit partway through:

- 12 verify calls completed.
- **35 verify calls failed outright** with `You've hit your individual spend
  limit`, not with a real verdict. `/usage-credits` confirms credit requests are
  turned off for this org, so this can't be worked around by asking for more.
- Because verification didn't run on those 35, **none of those findings are
  known to be real or known to be false.** `totalFixed: 0` — no review-round fix
  was applied (separate from the three integration fixes in §2, which *were*
  applied and are safe).

The raw finding list is not in this file because pulling it out costs another
round of tool calls against the same limit. It's recoverable for free (no new
agents) by reading the journal directly:

```
C:\Users\husse\.claude\projects\c--Users-husse-Desktop--Spaceapps\6734716e-57cb-4b5f-99d8-0040f77a7c74\subagents\workflows\wf_44d0f485-ab3\journal.jsonl
```

Each `{"type":"result","label":"review:<lens>",...}` line has that lens's
`findings` array (file, line, severity, summary, evidence, fix). The seven
lenses were: `forecast-locks`, `html-contract`, `css-rules`, `charts-dataviz`,
`failure-matrix`, `js-rules`, `responsive-ux` — named after what each one
audited, matching `HANDOFF.md` §3/§6's own checklist structure.

**Also not yet done at all** (this was always planned for after the review
round, never attempted):

- No real browser run. WebGL, the MapLibre CDN, Google Fonts, and the
  OpenFreeMap tile source have never actually loaded.
- No check of the two required viewports (1440×1080, 390×844) for overflow,
  drawer behaviour, or hit-area sizes.
- No run with `window.SPACEAPP_CONFIG = { forecasts: [] }`.
- No run with the MapLibre `<script>` blocked.
- No run with `useExternalImages: true` pointed at a missing file.

A Playwright acceptance script covering all of the above (the full
`HANDOFF.md` §6 checklist, both viewports, both edge-case configs) is already
written and ready to run, no further authoring needed:

```
C:\Users\husse\AppData\Local\Temp\claude\f94de4d18a4cd44d\6734716e-57cb-4b5f-99d8-0040f77a7c74\pw\accept.mjs
```

It expects one small test hook that **does not exist in `main.js` yet**:
`window.__spaceapp = { map, inspect(lng, lat) }` (a map handle plus a function
that simulates a click at a given coordinate, for the "click inside/outside the
footprint" checks). That's a few lines to add to `main.js`'s boot sequence —
flagged here so whoever runs the script next doesn't get surprised by those
specific checks failing.

Run it with (playwright-core 1.65.1 is already installed in that scratch dir,
driving the local Chrome install):

```sh
node "C:\Users\husse\AppData\Local\Temp\claude\f94de4d18a4cd44d\6734716e-57cb-4b5f-99d8-0040f77a7c74\pw\accept.mjs" \
  "c:\Users\husse\Desktop\.Spaceapps\spaceapp\workstation" \
  "C:\Users\husse\AppData\Local\Temp\claude\f94de4d18a4cd44d\6734716e-57cb-4b5f-99d8-0040f77a7c74\pw\out"
```

## 4. Decision already made, waiting on §3

User confirmed: once this is verified, replace the contents of
`spaceapp/Frontend/` with the workstation files (old React/Vite app stays
recoverable — `git status` shows `Frontend/` fully committed and clean, no
local changes). **Do not do this replacement before §3's gap is closed** —
that's the whole reason it was gated on verification in the first place.

## 5. Recommended next steps, in order

1. Add the `window.__spaceapp` test hook to `main.js` (small, mechanical).
2. Run `accept.mjs` — it's free (local browser, no subagents, no spend limit).
3. Read `journal.jsonl`'s seven `review:*` results (free — just a file read) and
   triage the findings by hand instead of via more verify subagents, since those
   cost budget this org doesn't currently have. Most of the 7 lenses' prompts
   were narrow enough (one spec section each) that many findings should be
   quick to eyeball against the actual code.
4. Fix whatever both `accept.mjs` and the manual triage confirm.
5. Only then: replace `Frontend/`'s contents with `workstation/`'s files.

## 6. Reference

- Spec chain: `HANDOFF.md` → `CLAUDE.md` → `spec.md` → `css/{CLAUDE,spec}.md` →
  `js/{CLAUDE,spec}.md` — all in this folder, unchanged except the one `css/spec.md`
  correction noted in §2.
- Workflow script, if you want to resume it (adds more agents, costs budget):
  `C:\Users\husse\.claude\projects\c--Users-husse-Desktop--Spaceapps\6734716e-57cb-4b5f-99d8-0040f77a7c74\workflows\scripts\build-workstation-wf_44d0f485-ab3.js`,
  resume with `resumeFromRunId: "wf_44d0f485-ab3"` — completed agents replay from
  cache free of charge; only new/changed calls spend budget. **Current session
  workflow-size guideline is now "small, under 5 agents"** — a second full
  review round at the original scale (7 lenses × up to ~12 findings × verify ×
  per-file fix = up to ~45 agents) would need either more budget or a
  deliberately smaller re-scoped script.
