"""Web-map tiling: reproject a raster to Web Mercator, colour it and cut 256 px PNG tiles.

Pure numpy/rasterio/Pillow; nothing here knows about NISAR or HTTP.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

import numpy as np
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject, transform_bounds

TILE = 256
ORIGIN = 20037508.342789244  # half the Web Mercator world, in metres
WEB_MERCATOR = CRS.from_epsg(3857)
METRES_PER_PIXEL_Z0 = 2 * ORIGIN / TILE
MAX_LAT = 85.0511287798066

# name -> [(position 0..1, (r, g, b))]
STYLES = {
    "gray": [(0.0, (12, 12, 14)), (1.0, (245, 245, 240))],
    "diverging": [(0.0, (33, 102, 172)), (0.5, (247, 247, 247)), (1.0, (178, 24, 43))],
    "coherence": [(0.0, (68, 1, 84)), (0.25, (59, 82, 139)), (0.5, (33, 145, 140)), (0.75, (94, 201, 98)), (1.0, (253, 231, 37))],
}


def tile_size_m(z: int) -> float:
    return 2 * ORIGIN / 2**z


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    lat = max(min(lat, MAX_LAT), -MAX_LAT)
    n = 2**z
    x = math.floor((lon + 180.0) / 360.0 * n)
    y = math.floor((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a tile in Web Mercator metres."""
    size = tile_size_m(z)
    return (-ORIGIN + x * size, ORIGIN - (y + 1) * size, -ORIGIN + (x + 1) * size, ORIGIN - y * size)


def pick_max_zoom(pixel_m: float, lat: float, lo: int = 6, hi: int = 12) -> int:
    """The zoom whose ground resolution at this latitude is closest to the source pixel size."""
    ground = METRES_PER_PIXEL_Z0 * math.cos(math.radians(min(abs(lat), 80.0)))
    return int(min(hi, max(lo, round(math.log2(ground / pixel_m)))))


@dataclass
class Canvas:
    """A float image aligned to the tile grid of zoom `z`, starting at tile (tx0, ty0)."""

    data: np.ndarray
    z: int
    tx0: int
    ty0: int


def build_canvas(
    data: np.ndarray, transform: Affine, crs: CRS, zmax: int, max_canvas_px: int = 4096
) -> Canvas:
    """Reproject `data` onto the tile grid at `zmax`, or the closest coarser zoom that fits `max_canvas_px`."""
    rows, cols = data.shape
    # the corners of the grid, written out so no affine-library operator (deprecated across versions) is needed
    left, top = transform.c, transform.f
    right = transform.a * cols + transform.b * rows + transform.c
    bottom = transform.d * cols + transform.e * rows + transform.f
    west, east = sorted((left, right))
    south, north = sorted((bottom, top))
    mw, ms, me, mn = transform_bounds(crs, WEB_MERCATOR, west, south, east, north, densify_pts=21)
    mw, me = max(mw, -ORIGIN), min(me, ORIGIN)
    ms, mn = max(ms, -ORIGIN), min(mn, ORIGIN)

    z = zmax
    while True:
        size = tile_size_m(z)
        last = 2**z - 1
        tx0 = min(max(math.floor((mw + ORIGIN) / size), 0), last)
        tx1 = min(max(math.ceil((me + ORIGIN) / size) - 1, tx0), last)
        ty0 = min(max(math.floor((ORIGIN - mn) / size), 0), last)
        ty1 = min(max(math.ceil((ORIGIN - ms) / size) - 1, ty0), last)
        if max(tx1 - tx0 + 1, ty1 - ty0 + 1) * TILE <= max_canvas_px or z <= 0:
            break
        z -= 1

    out = np.full(((ty1 - ty0 + 1) * TILE, (tx1 - tx0 + 1) * TILE), np.nan, dtype=np.float32)
    res = size / TILE
    dst_transform = Affine(res, 0, -ORIGIN + tx0 * size, 0, -res, ORIGIN - ty0 * size)
    reproject(
        source=np.ascontiguousarray(data, dtype=np.float32),
        destination=out,
        src_transform=transform,
        src_crs=crs,
        dst_transform=dst_transform,
        dst_crs=WEB_MERCATOR,
        src_nodata=np.nan,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    return Canvas(out, z, tx0, ty0)


def halve(canvas: Canvas) -> Canvas:
    """The next coarser zoom: pad to even tile alignment, then average 2x2 blocks (ignoring NaN)."""
    pad_l, pad_t = canvas.tx0 % 2, canvas.ty0 % 2
    nx, ny = canvas.data.shape[1] // TILE, canvas.data.shape[0] // TILE
    pad_r, pad_b = (nx + pad_l) % 2, (ny + pad_t) % 2
    padded = np.pad(
        canvas.data,
        ((pad_t * TILE, pad_b * TILE), (pad_l * TILE, pad_r * TILE)),
        constant_values=np.nan,
    )
    h, w = padded.shape
    blocks = padded.reshape(h // 2, 2, w // 2, 2)
    finite = np.isfinite(blocks)
    total = np.where(finite, blocks, 0.0).sum(axis=(1, 3))
    count = finite.sum(axis=(1, 3))
    mean = np.where(count > 0, total / np.maximum(count, 1), np.nan).astype(np.float32)
    return Canvas(mean, canvas.z - 1, canvas.tx0 // 2, canvas.ty0 // 2)


def pyramid(canvas: Canvas, zmin: int):
    """Yield the canvas, then each coarser one down to `zmin`."""
    current = canvas
    while True:
        yield current
        if current.z <= zmin:
            return
        current = halve(current)


def colorize(values: np.ndarray, vmin: float, vmax: float, style: str) -> np.ndarray:
    """RGBA uint8; NaN becomes fully transparent."""
    stops = STYLES[style]
    valid = np.isfinite(values)
    span = vmax - vmin if vmax > vmin else 1.0
    norm = np.where(valid, np.clip((np.where(valid, values, vmin) - vmin) / span, 0.0, 1.0), 0.0)
    positions = [p for p, _ in stops]
    colors = np.array([c for _, c in stops], dtype=np.float64)
    out = np.empty(values.shape + (4,), dtype=np.uint8)
    for channel in range(3):
        out[..., channel] = np.interp(norm, positions, colors[:, channel]).astype(np.uint8)
    out[..., 3] = np.where(valid, 255, 0)
    return out


def iter_tiles(canvas: Canvas, rgba: np.ndarray):
    """Yield (z, x, y, png bytes) for every tile that has any visible pixel."""
    for row in range(rgba.shape[0] // TILE):
        for col in range(rgba.shape[1] // TILE):
            block = rgba[row * TILE : (row + 1) * TILE, col * TILE : (col + 1) * TILE]
            if not block[..., 3].any():
                continue
            buf = io.BytesIO()
            Image.fromarray(block, "RGBA").save(buf, "PNG", compress_level=6)
            yield canvas.z, canvas.tx0 + col, canvas.ty0 + row, buf.getvalue()


def value_range(values: np.ndarray, symmetric: bool = False) -> tuple[float, float]:
    """The 2nd to 98th percentile of the finite values (symmetric about 0 when asked)."""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return 0.0, 1.0
    lo, hi = np.percentile(finite, [2, 98])
    if symmetric:
        m = float(max(abs(lo), abs(hi)))
        lo, hi = -m, m
    if not hi > lo:
        lo, hi = float(lo) - 1.0, float(hi) + 1.0
    return float(lo), float(hi)
