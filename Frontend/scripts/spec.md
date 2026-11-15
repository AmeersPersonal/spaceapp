# scripts — Spec

## `make_sample_data.py`

### Invocation

```
python make_sample_data.py <output_directory>
```

| Item | Value |
| --- | --- |
| Arguments | Exactly one: the output directory. Taken from `sys.argv[1]` with no validation. |
| Dependencies | `numpy`, `pillow` |
| Stdlib used | `json`, `sys` |
| Exit | Prints `ok`. No error handling — a bad path raises. |
| Determinism | Fully seeded. Same inputs always give byte-identical output. |

The directory must already exist; the script does not create it.

### Output

| File | Format |
| --- | --- |
| `radar_<date>.png` × 6 | 512×512 greyscale PNG |
| `risk_zones.geojson` | FeatureCollection, 2 polygons |
| `risk_forecast_<date>.geojson` × 4 | FeatureCollection, 2 polygons |

### Fixed parameters

| Name | Value | Meaning |
| --- | --- | --- |
| `W`, `H` | 512 | Image dimensions |
| bounds | `130.85, 32.70, 131.35, 33.06` | west, south, east, north — **must match `studyArea.bounds`** |
| `rng` seed | 11 | Speckle generator |
| `KM_LAT` | 110.57 | km per degree latitude |
| `KM_LON` | `111.32 * cos(32.88°)` | km per degree longitude at this latitude |
| `CRATER_X, CRATER_Y` | 260, 250 | Nakadake vent, in pixels |
| `CAL_X, CAL_Y` | 238, 250 | Caldera centre, in pixels |
| `CAL_A`, `CAL_B` | 9 km, 12.5 km (→ px) | Caldera semi-axes; 18 km E–W × 25 km N–S |

### Dates and ash radii

| Date | Ash radius (km) |
| --- | --- |
| 2026-09-08 | 0.8 |
| 2026-09-20 | 1.2 |
| 2026-10-02 | 1.7 |
| 2026-10-14 | 2.3 |
| 2026-10-26 | 3.0 |
| 2026-11-07 | 3.8 |

Twelve days apart, per NISAR's repeat cycle.

### Hazard zone radii

| Output | high (km) | medium (km) | seed |
| --- | --- | --- | --- |
| `risk_zones.geojson` | 2.0 | 5.0 | 100 |
| `risk_forecast_2026-11-19` | 3.0 | 7.0 | 200 |
| `risk_forecast_2026-12-01` | 4.0 | 9.0 | 202 |
| `risk_forecast_2026-12-13` | 5.5 | 12.0 | 204 |
| `risk_forecast_2026-12-25` | 4.0 | 8.0 | 206 |

### Image construction

```
land  = 80 + 55 * smooth(sigma=16, seed=1)        base terrain
land += 85 * exp(-(rim - 1)^2 / 0.006)            caldera wall (bright)
land -= 24 * exp(-rim^2 / 0.35)                   caldera floor (darker)
land += 72 * exp(-cone^2 / 0.6)                   central cones (bright)

per date:
  speckle = gamma(20, 1/20) blurred at sigma 0.7
  img     = land * speckle
  edge    = clip((radius * lobe * wobble - distance_from_vent) / 1.2, 0, 1)
  img    *= 1 - 0.78 * edge                       ash darkens the ground
  save clip(img, 0, 255) as uint8
```

Where `lobe = 1 + 0.55*cos(bearing - 55°)` stretches the deposit north-east
and `wobble = 0.65 + 0.7*smooth(22, 2)` makes the edge irregular.

Gamma shape 20 corresponds to roughly 20-look SAR averaging.

### Polygon construction — `blob(radius_km, seed, n=72)`

72 vertices at `radius_km` from the vent, each scaled by
`1 + 0.13 * standard_normal()`. The bump array is tiled three times and
convolved with a 9-wide box filter before the middle copy is taken, so the
smoothing wraps around and the ring closes without a kink. Coordinates are
rounded to 5 decimal places (~1 m). The first vertex is repeated at the end to
close the ring.

Vertex placement converts km to degrees with `KM_LON`/`KM_LAT`, so rings are
true circles on the ground, not in degree space.

### Coupling to the frontend

Change one of these and you must change the other:

| Script | `src/studyArea.js` |
| --- | --- |
| `west, south, east, north` | `bounds` |
| `dates` list | `dates[].date` and `dates[].image` |
| `forecast` list | `forecast[].date` and `forecast[].riskZonesUrl` |
| `"risk_zones.geojson"` | `riskZonesUrl` |

Nothing validates this. A mismatch produces a map that renders but lies.

### Not handled

- The six orphaned `radar_2026-06-*` / `radar_2026-07-*` PNGs in
  `public/data/` are not produced or cleaned up by this script.
- No argument validation, no `--help`, no overwrite protection.
- Writes with `open(...)` without a context manager (`zones()`), relying on
  CPython refcounting to flush.
