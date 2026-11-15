# CLAUDE.md

Guidance for Claude Code when working in this repository.

See `spec.md` in this folder for the repository-wide contract. Each subfolder
has its own `CLAUDE.md` and `spec.md`.

## What this project is

A NASA Space Apps entry. It renders satellite radar (NISAR) observations of a
volcanic study area across successive passes, then continues past today into a
model's forecast of hazard risk.

The organising idea: **one timeline slider running from measured past into
predicted future.** Left of the "Now" mark is data the satellite collected.
Right of it is model output.

## The rule that governs every change

**Never let a prediction look like a measurement.** The UI deliberately shifts
appearance across the "Now" line — the radar image fades to 35%, the view-mode
toggles disable, the slider recolours, the panel swaps to a prediction card
with a disclaimer. If a change you make blurs that distinction, it is wrong
even if it looks better. This is the app's entire point.

## Repository layout

This checkout is on branch `frontend1` and contains only `Frontend/`.

| Branch | Holds |
| --- | --- |
| `main` | `backend/` |
| `frontend1` | `Frontend/` (current) |
| `backend-exp` | backend experiments |
| `jeffrey/additional_datasets`, `jeffrey/data-experiment-clean` | data work |

Do not assume `backend/` exists. Nothing in `Frontend/` may reference anything
outside `Frontend/`.

## Commands

```bash
cd Frontend
npm install
npm run dev        # dev server
npm run build      # production build -> dist/
npm run lint       # oxlint — the only automated check
```

Regenerating sample data (needs `numpy`, `pillow`):

```bash
cd Frontend
python scripts/make_sample_data.py public/data
```

There are no tests. `npm run lint` is the whole verification story.

## Architecture

```
scripts/make_sample_data.py   generates fake radar PNGs + hazard GeoJSON
            |
            v
public/data/                  static files served at /data/*
            |
            v
src/studyArea.js              THE config seam: dates, image paths, forecast
            |
            v
src/mapview.jsx               map + charts + controls, all derived from it
            |
            v
src/pages/Home.jsx            renders <MapView /> at route "/"
```

## Conventions

- **`src/studyArea.js` is the only configuration surface.** Never hard-code a
  date, coordinate, filename or hazard name in a component. Swapping study
  area or data must mean editing that one file plus dropping files in
  `public/data/`.
- Dates are ISO `YYYY-MM-DD` strings everywhere. Parsing happens once, in
  `formatDate()` in `mapview.jsx`.
- Acquisition dates sit 12 days apart (NISAR's repeat cycle). Nothing enforces
  this; it is a data-authoring rule.
- Plain `.jsx` and plain `.css`. No TypeScript, no CSS framework, no state
  library. Do not introduce one without being asked.

## What is real and what is placeholder

Real: the geography (Aso caldera, Kumamoto Prefecture, Japan), the bounding
box, the 12-day cycle, the map rendering, the change-detection maths.

Placeholder: every radar image, risk number, forecast probability and hazard
polygon — all synthesised by `Frontend/scripts/make_sample_data.py`.

The "Sample data" badge shows while `studyArea.isSample` is `true`. **Only set
it to `false` when every image and every number is real.**

## Known gaps — do not treat these as bugs to fix unprompted

- Root `README.md` is one line.
- `src/index.css` is empty but imported by `main.jsx`.
- Auth forms `console.log` submissions and hold passwords in state; there is
  no backend and no authentication anywhere in the app.
- `index.html` requests `/favicon.svg`, which does not exist.
- Six orphaned `radar_2026-06-*` / `radar_2026-07-*` PNGs in `public/data/`
  are not referenced by `studyArea.js`.
