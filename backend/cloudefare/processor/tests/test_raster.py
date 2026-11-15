import io

import numpy as np
import pytest
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import transform

import raster
from helpers import CENTER, EPSG


def utm_raster(value=5.0, rows=120, cols=160, step=80.0):
    cx, cy = transform("EPSG:4326", f"EPSG:{EPSG}", [CENTER[0]], [CENTER[1]])
    left, top = cx[0] - cols * step / 2, cy[0] + rows * step / 2
    return np.full((rows, cols), value, dtype=np.float32), Affine(step, 0, left, 0, -step, top), CRS.from_epsg(EPSG)


def test_tile_math_matches_known_values():
    assert raster.lonlat_to_tile(0, 0, 1) == (1, 1)
    assert raster.lonlat_to_tile(-180, 85, 2) == (0, 0)
    assert raster.lonlat_to_tile(179.99, -85, 2) == (3, 3)
    w, s, e, n = raster.tile_bounds(0, 0, 0)
    assert (w, s, e, n) == pytest.approx((-raster.ORIGIN, -raster.ORIGIN, raster.ORIGIN, raster.ORIGIN))
    assert raster.tile_bounds(1, 1, 0)[0] == pytest.approx(0)


def test_max_zoom_follows_pixel_size_and_is_clamped():
    assert raster.pick_max_zoom(80, 35.5) == 11
    assert raster.pick_max_zoom(20, 35.5) == 12  # would be 13, capped
    assert raster.pick_max_zoom(5000, 35.5) == 6  # floor
    assert raster.pick_max_zoom(80, 80) < raster.pick_max_zoom(80, 0) + 1


def test_canvas_is_tile_aligned_and_covers_the_data():
    data, transform_, crs = utm_raster()
    canvas = raster.build_canvas(data, transform_, crs, zmax=11)
    assert canvas.z == 11
    assert canvas.data.shape[0] % raster.TILE == 0 and canvas.data.shape[1] % raster.TILE == 0
    x, y = raster.lonlat_to_tile(*CENTER, 11)
    nx, ny = canvas.data.shape[1] // raster.TILE, canvas.data.shape[0] // raster.TILE
    assert canvas.tx0 <= x < canvas.tx0 + nx and canvas.ty0 <= y < canvas.ty0 + ny
    finite = np.isfinite(canvas.data)
    assert finite.any() and not finite.all()  # the data sits inside a larger, empty tile grid
    assert np.nanmin(canvas.data) == pytest.approx(5.0, abs=1e-4) and np.nanmax(canvas.data) == pytest.approx(5.0, abs=1e-4)
    # the pixel under the centre of the area really holds data
    bx, by, ex, ey = raster.tile_bounds(11, x, y)
    cx, cy = transform("EPSG:4326", "EPSG:3857", [CENTER[0]], [CENTER[1]])
    col = int((cx[0] - (-raster.ORIGIN + canvas.tx0 * raster.tile_size_m(11))) / (raster.tile_size_m(11) / raster.TILE))
    row = int(((raster.ORIGIN - canvas.ty0 * raster.tile_size_m(11)) - cy[0]) / (raster.tile_size_m(11) / raster.TILE))
    assert np.isfinite(canvas.data[row, col])


def test_canvas_drops_to_a_coarser_zoom_when_too_big():
    data, transform_, crs = utm_raster(rows=300, cols=400)
    canvas = raster.build_canvas(data, transform_, crs, zmax=12, max_canvas_px=512)
    assert canvas.z < 12
    assert max(canvas.data.shape) <= 512


@pytest.mark.parametrize("odd_shift", [0, 1])
def test_halving_keeps_values_and_alignment(odd_shift):
    data, transform_, crs = utm_raster(value=7.0)
    canvas = raster.build_canvas(data, transform_, crs, zmax=11)
    canvas = raster.Canvas(canvas.data, canvas.z, canvas.tx0 + odd_shift, canvas.ty0 + odd_shift)  # exercise odd origins
    half = raster.halve(canvas)
    assert half.z == canvas.z - 1
    assert (half.tx0, half.ty0) == (canvas.tx0 // 2, canvas.ty0 // 2)
    assert half.data.shape[0] % raster.TILE == 0 and half.data.shape[1] % raster.TILE == 0
    assert np.nanmin(half.data) == pytest.approx(7.0, abs=1e-4) and np.nanmax(half.data) == pytest.approx(7.0, abs=1e-4)
    if odd_shift == 0:  # (shifting the origin by hand moves the data off its ground, so only check the real grid)
        x, y = raster.lonlat_to_tile(*CENTER, canvas.z - 1)
        nx, ny = half.data.shape[1] // raster.TILE, half.data.shape[0] // raster.TILE
        assert half.tx0 <= x < half.tx0 + nx and half.ty0 <= y < half.ty0 + ny


def test_pyramid_runs_down_to_the_requested_zoom():
    data, transform_, crs = utm_raster()
    canvas = raster.build_canvas(data, transform_, crs, zmax=11)
    assert [c.z for c in raster.pyramid(canvas, 8)] == [11, 10, 9, 8]
    assert [c.z for c in raster.pyramid(canvas, 11)] == [11]


def test_colorize_makes_no_data_transparent_and_maps_the_ends():
    values = np.array([[np.nan, 0.0, 5.0, 10.0]], dtype=np.float32)
    gray = raster.colorize(values, 0.0, 10.0, "gray")
    assert gray[0, 0, 3] == 0 and (gray[0, 1:, 3] == 255).all()
    assert gray[0, 1, 0] < 40 and gray[0, 3, 0] > 220
    diverging = raster.colorize(np.array([[-1.0, 0.0, 1.0]], dtype=np.float32), -1.0, 1.0, "diverging")
    assert diverging[0, 0, 2] > diverging[0, 0, 0]  # blue end
    assert diverging[0, 2, 0] > diverging[0, 2, 2]  # red end
    assert tuple(diverging[0, 1, :3]) == (247, 247, 247)  # white in the middle
    clipped = raster.colorize(np.array([[-50.0, 50.0]], dtype=np.float32), 0.0, 1.0, "coherence")
    assert clipped[0, 0, 3] == 255 and clipped[0, 1, 3] == 255


def test_tiles_skip_empty_squares_and_are_valid_pngs():
    data, transform_, crs = utm_raster()
    canvas = raster.build_canvas(data, transform_, crs, zmax=11)
    rgba = raster.colorize(canvas.data, 0.0, 10.0, "gray")
    tiles = list(raster.iter_tiles(canvas, rgba))
    total = (canvas.data.shape[0] // raster.TILE) * (canvas.data.shape[1] // raster.TILE)
    assert 0 < len(tiles) <= total
    z, x, y, png = tiles[0]
    assert z == 11 and canvas.tx0 <= x and canvas.ty0 <= y
    image = Image.open(io.BytesIO(png))
    assert image.size == (raster.TILE, raster.TILE) and image.mode == "RGBA"
    assert list(raster.iter_tiles(canvas, np.zeros_like(rgba))) == []


def test_value_range_uses_percentiles_and_survives_flat_data():
    values = np.concatenate([np.linspace(0, 1, 1000), [np.nan, 1000.0]]).astype(np.float32)
    lo, hi = raster.value_range(values)
    assert 0 <= lo < 0.05 and 0.9 < hi < 1.1  # the 1000 outlier is ignored
    lo, hi = raster.value_range(np.array([-1.0, 4.0, np.nan], dtype=np.float32), symmetric=True)
    assert lo == -hi and hi > 0
    lo, hi = raster.value_range(np.full(10, 3.0, dtype=np.float32))
    assert hi > lo
    assert raster.value_range(np.full(4, np.nan, dtype=np.float32)) == (0.0, 1.0)


@pytest.mark.parametrize("north_up", [True, False])
def test_the_map_is_not_flipped(north_up):
    """Values that grow eastward and southward in the source must grow with column and row in the tiles."""
    data, transform_, crs = utm_raster()
    rows, cols = data.shape
    if not north_up:  # a south-up grid (y increases with row) must give the same picture
        transform_ = Affine(transform_.a, 0, transform_.c, 0, -transform_.e, transform_.f - transform_.e * rows)
    east = np.tile(np.arange(cols, dtype=np.float32), (rows, 1))
    south = np.tile(np.arange(rows, dtype=np.float32)[:, None], (1, cols))
    if not north_up:
        south = south[::-1]  # row 0 is the southern edge here, so "southward" runs against the row index
    for source, axis in ((east, 1), (south, 0)):
        canvas = raster.build_canvas(source.copy(), transform_, crs, zmax=11)
        finite = np.isfinite(canvas.data)
        index = np.indices(canvas.data.shape)[axis][finite]
        values = canvas.data[finite]
        assert np.corrcoef(index, values)[0, 1] > 0.95
