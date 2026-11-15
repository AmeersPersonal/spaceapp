# public/data — Spec

## Serving

Files here are served at `/data/<filename>`, unprocessed and unhashed. They are
referenced by absolute path from `src/studyArea.js`. Vite does not bundle,
transform or fingerprint them.

Because they are same-origin, `canvas.getImageData()` works on the PNGs without
tainting the canvas. This is what makes change detection possible.

## Radar image format

| Property | Requirement |
| --- | --- |
| Filename | `radar_YYYY-MM-DD.png` (convention; the path in `studyArea.js` is authoritative) |
| Format | PNG |
| Colour | Greyscale. **The app reads the red channel only.** |
| Dimensions | 512×512 in the sample set. All images in one series must match. |
| Geographic extent | Exactly `studyArea.bounds`, north-up, unrotated. |
| Value meaning | Brighter = stronger radar return. |

### Why these constraints are hard requirements

The overlay is placed by its four corner coordinates, not by embedded
georeferencing. The app assumes a linear mapping from the image rectangle to
the bounding box:

```
x = ((lng - west)  / (east - west))   * width
y = ((north - lat) / (north - south)) * height
```

An image covering a different extent is stretched to fit without complaint,
and every brightness reading and change-detection result silently becomes
wrong. Images of differing sizes break `buildChangeImage`, which assumes both
inputs block-average to the same dimensions.

## GeoJSON format

A `FeatureCollection` of `Polygon` features:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "risk": "medium" },
      "geometry": { "type": "Polygon", "coordinates": [[[lon, lat], ...]] }
    },
    {
      "type": "Feature",
      "properties": { "risk": "high" },
      "geometry": { "type": "Polygon", "coordinates": [[[lon, lat], ...]] }
    }
  ]
}
```

### Requirements

| Rule | Detail |
| --- | --- |
| `properties.risk` | Required on every feature. `"high"` renders `#e5484d`; **any other value** renders `#f5a524`. There is no `low` styling and no validation. |
| Coordinate order | `[longitude, latitude]`, per the GeoJSON spec. |
| Ring closure | First and last coordinate of each ring must be identical. |
| Geometry type | `Polygon`. `MultiPolygon` would render, but nothing produces one today. |
| Draw order | Features render in array order; later features draw on top. The sample puts `medium` first so `high` sits above it. |

Features may carry extra properties; the app ignores them.

## Current file inventory

| Pattern | Count | Referenced by `studyArea.js` |
| --- | --- | --- |
| `radar_2026-06-*.png`, `radar_2026-07-*.png` | 6 | No — orphaned |
| `radar_2026-09-08` … `radar_2026-11-07` | 6 | Yes |
| `risk_zones.geojson` | 1 | Yes |
| `risk_forecast_*.geojson` | 4 | Yes |

## Failure behaviour

| Missing file | Result |
| --- | --- |
| A radar PNG | `loadPixels` rejects; the side panel shows `Could not load <url>` and the brightness chart and change mode stay unavailable. |
| A GeoJSON | MapLibre logs a source error; the risk layers render nothing. No UI message. |

## Regenerating

```
python ../../scripts/make_sample_data.py .
```

Requires `numpy` and `pillow`. The generator is seeded, so output is
deterministic. It writes only the six September–November radar images and the
five GeoJSON files; it does not clean up the orphaned June–July PNGs.
