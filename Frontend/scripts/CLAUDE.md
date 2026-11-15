# CLAUDE.md — scripts

One Python script: `make_sample_data.py`. It fabricates everything in
`public/data/` so the frontend could be built before real NISAR data existed.

See `spec.md` here for every fixed parameter, the date/radius tables and the
exact image-construction formula.

## Running it

```bash
python scripts/make_sample_data.py public/data
```

Requires `numpy` and `pillow`. Takes exactly one argument, the output
directory, which must already exist. Writes six radar PNGs and five GeoJSON
files, then prints `ok`. Fully seeded, so output is deterministic.

## What it fakes, and how

Each radar image is a landscape that stays constant across passes, plus an ash
deposit that grows.

**The landscape** is Gaussian-blurred noise plus three features, each an
ellipse placed at a real-world distance via a pixels-per-kilometre conversion:
the caldera wall (bright — steep rough terrain returns a lot of signal), the
caldera floor (darker — flat), and the central cones (bright, elongated
east–west).

**The ash deposit** grows 0.8 km → 3.8 km across the six passes. Not a disc:
the radius is modulated by a cosine of the bearing so the lobe stretches
north-east as if downwind, then multiplied by a second noise field for an
irregular edge. Where ash covers ground, brightness drops by up to 78% —
fresh ash is smooth, so less radar comes back.

**Speckle** is gamma-distributed noise (shape 20, ≈20-look averaging)
multiplied over the result and lightly blurred, mimicking real multi-looked
SAR products.

**Hazard zones** are 72-vertex rings at a given radius from the vent, each
vertex nudged by smoothed noise so the polygon reads as data-derived rather
than drawn. The smoothing wraps around so the ring closes without a kink.

## Why the numbers are what they are

Every constant is chosen so output is plausible to someone who knows SAR
imagery: real caldera dimensions (18 km E–W × 25 km N–S), real vent position,
NISAR's real 12-day cycle, realistic speckle statistics, and an exclusion
radius roughly matching JMA alert level 2. That is what lets the interface be
demoed honestly while the data pipeline is still being built.

Keep that bar if you change it. A number picked for convenience undermines the
reason the script exists.

## What it does not model

Actual radar physics, interferometry, ground deformation, or any relationship
between the imagery and the risk values in `studyArea.js`. Those risk numbers
and forecast probabilities were written by hand; the script only makes zone
geometry widen and contract around the stated peak.

## Coupling you must maintain

Change one side and you must change the other — nothing validates this, and a
mismatch produces a map that renders but lies.

| Script | `src/studyArea.js` |
| --- | --- |
| `west, south, east, north` | `bounds` |
| `dates` list | `dates[].date`, `dates[].image` |
| `forecast` list | `forecast[].date`, `forecast[].riskZonesUrl` |
| `"risk_zones.geojson"` | `riskZonesUrl` |

## Rough edges

No argument validation, no `--help`, no overwrite protection. `zones()` writes
with a bare `open()` rather than a context manager. It does not clean up the
orphaned `radar_2026-06-*` / `radar_2026-07-*` PNGs in `public/data/`.
