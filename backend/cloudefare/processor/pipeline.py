"""One job: read a scene, draw its layers as tiles, upload them, then upload the manifest last."""

from __future__ import annotations

import gc
import logging
import re
from typing import Callable

import numpy as np

import nisar
import raster

log = logging.getLogger("processor")

MIN_ZOOM_SPAN = 5  # coarsest zoom is this many levels above the finest
FLOOR_ZOOM = 3


def scene_date(acquired_at: str | None, scene_id: str) -> str:
    """YYYY-MM-DD from the catalog's acquisition time, else from the first timestamp in the scene name."""
    if acquired_at and re.match(r"^\d{4}-\d{2}-\d{2}", acquired_at):
        return acquired_at[:10]
    match = re.search(r"_(\d{4})(\d{2})(\d{2})T\d{6}_", scene_id)
    if not match:
        raise ValueError("no acquisition date in the job or the scene name")
    return "-".join(match.groups())


def _stats(values: np.ndarray) -> dict:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {}
    p2, median, p98 = np.percentile(finite, [2, 50, 98])
    return {
        "mean": round(float(finite.mean()), 4),
        "median": round(float(median), 4),
        "p2": round(float(p2), 4),
        "p98": round(float(p98), 4),
        "validFraction": round(float(finite.size / values.size), 4),
    }


def render_layer(h5, spec: nisar.LayerSpec, bbox, date: str, uploader) -> tuple[dict, dict]:
    """Draw one layer at every zoom; returns (manifest layer entry, stats)."""
    data = nisar.read_layer(h5, spec, bbox)
    lat = (data.lonlat_bounds[1] + data.lonlat_bounds[3]) / 2
    zmax = raster.pick_max_zoom(data.pixel_m, lat)
    canvas = raster.build_canvas(data.data, data.transform, data.crs, zmax)
    stats = _stats(data.data)  # the scene's own pixels: the canvas also holds empty tile margin
    if not stats:
        raise nisar.SourceError("coverage", f"{spec.id} has no valid pixels in the area")

    if spec.kind == "coherence":
        vmin, vmax = 0.0, 1.0
    else:
        vmin, vmax = raster.value_range(canvas.data, symmetric=spec.kind == "phase")
    zmin = max(FLOOR_ZOOM, canvas.z - MIN_ZOOM_SPAN)

    for level in raster.pyramid(canvas, zmin):
        rgba = raster.colorize(level.data, vmin, vmax, spec.style)
        uploader.put_tiles(spec.id, date, raster.iter_tiles(level, rgba))
        log.info("%s z%d uploaded (%d tiles so far)", spec.id, level.z, uploader.tiles_sent)

    west, south, east, north = data.lonlat_bounds
    entry = {
        "layer": spec.id,
        "date": date,
        "minZoom": zmin,
        "maxZoom": canvas.z,
        "bounds": [round(max(west, -180), 5), round(max(south, -85), 5), round(min(east, 180), 5), round(min(north, 85), 5)],
        "units": spec.units,
        "label": spec.label,
        "range": [round(vmin, 4), round(vmax, 4)],
    }
    return entry, stats


def process_job(job: dict, open_scene: Callable = nisar.open_scene, make_uploader: Callable = None, token: str | None = None) -> dict:
    """Run a job. Returns {'status': 'ready'|'skipped', ...}; raises nisar.SourceError or UploadError on failure."""
    product = job["product"]
    if product not in nisar.SUPPORTED_PRODUCTS:
        return {"status": "skipped", "reason": f"{product} scenes are not drawn yet (GCOV and GUNW are)"}
    date = scene_date(job.get("acquiredAt"), job["sceneId"])
    uploader = make_uploader(job)

    h5 = open_scene(job["url"], token)
    try:
        specs = nisar.find_layers(h5, product)
        if not specs:
            return {"status": "skipped", "reason": f"no drawable {product} layers found in the file"}
        entries, stats, problems = [], {}, []
        for spec in specs:
            try:
                entry, layer_stats = render_layer(h5, spec, job.get("bbox"), date, uploader)
            except nisar.SourceError as err:
                if err.kind != "coverage" or len(specs) == 1:
                    raise
                problems.append(f"{spec.id}: {err}")
                continue
            entries.append(entry)
            stats[spec.stat_key] = layer_stats
            gc.collect()
        if not entries:
            return {"status": "skipped", "reason": "; ".join(problems) or "nothing to draw"}
        uploader.put_manifest({"layers": entries, "stats": stats, "context": {"source": "NISAR via ASF DAAC", "date": date, "skipped": problems}})
        return {"status": "ready", "layers": [e["layer"] for e in entries], "tiles": uploader.tiles_sent, "date": date}
    finally:
        h5.close()
