"""Reading NISAR HDF5 products straight from ASF with HTTP range requests.

A scene is 1-2 GB, so nothing is downloaded whole: `RangeFile` fetches only the blocks h5py asks
for, and `read_layer` crops to the area of interest and averages down to a manageable size.
Dataset paths follow the NISAR product specifications (JPL D-102274 GCOV, D-102272 GUNW).
"""

from __future__ import annotations

import io
import math
import re
from collections import OrderedDict
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import h5py
import numpy as np
import requests
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import transform_bounds
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

SUPPORTED_PRODUCTS = ("GCOV", "GUNW")
LSAR = "/science/LSAR"


class SourceError(Exception):
    """kind: 'auth' (Earthdata rejected us), 'upstream' (retry later), 'coverage' (scene misses the area)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


# ---------- HTTP range file ----------


def _session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=3, backoff_factor=1.0, status_forcelist=(500, 502, 503, 504), allowed_methods=("GET",))
    s.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=8))
    s.mount("http://", HTTPAdapter(max_retries=retry, pool_maxsize=8))
    return s


def resolve_download(url: str, token: str | None, session: requests.Session) -> tuple[str, dict]:
    """Follow ASF's redirects by hand so the bearer token never reaches another host.

    Returns the final (possibly signed) URL and the headers to use with it.
    """
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    home = urlparse(url).hostname
    current = url
    for _ in range(6):
        try:
            r = session.get(current, headers={**headers, "Range": "bytes=0-0"}, allow_redirects=False, stream=True, timeout=(10, 30))
        except requests.RequestException as err:
            raise SourceError("upstream", f"could not reach {urlparse(current).hostname}: {err}") from err
        r.close()
        if r.status_code in (301, 302, 303, 307, 308):
            nxt = urljoin(current, r.headers.get("Location", ""))
            host = urlparse(nxt).hostname or ""
            if host.endswith("urs.earthdata.nasa.gov"):
                raise SourceError("auth", "Earthdata Login did not accept the token (expired or invalid)")
            if host != home:
                headers = {}
            current = nxt
            continue
        if r.status_code in (401, 403):
            raise SourceError("auth", f"download refused with HTTP {r.status_code}")
        if r.status_code in (200, 206):
            return current, headers
        raise SourceError("upstream", f"download failed with HTTP {r.status_code}")
    raise SourceError("upstream", "too many redirects")


class RangeFile(io.RawIOBase):
    """Read-only file object backed by HTTP range requests, with a small block cache."""

    def __init__(self, url: str, token: str | None = None, block_size: int = 2 << 20, max_blocks: int = 64):
        self._session = _session()
        self._origin = (url, token)
        self._url, self._headers = resolve_download(url, token, self._session)
        self._block = block_size
        self._max_blocks = max_blocks
        self._cache: OrderedDict[int, bytes] = OrderedDict()
        self._pos = 0
        self.bytes_fetched = 0
        self.size = self._probe()

    def _get(self, start: int, end: int) -> requests.Response:
        for attempt in range(2):
            try:
                r = self._session.get(self._url, headers={**self._headers, "Range": f"bytes={start}-{end}"}, timeout=(10, 90))
            except requests.RequestException as err:
                raise SourceError("upstream", f"range read failed: {err}") from err
            if r.status_code in (401, 403) and attempt == 0:  # a signed URL expires: sign it again once
                self._url, self._headers = resolve_download(*self._origin, self._session)
                continue
            if r.status_code != 206:
                raise SourceError("upstream", f"range read returned HTTP {r.status_code}")
            return r
        raise SourceError("upstream", "range read refused")

    def _probe(self) -> int:
        r = self._get(0, 0)
        match = re.search(r"/(\d+)$", r.headers.get("Content-Range", ""))
        if not match:
            raise SourceError("upstream", "server did not report the file size")
        return int(match.group(1))

    def _block_bytes(self, index: int) -> bytes:
        if index in self._cache:
            self._cache.move_to_end(index)
            return self._cache[index]
        start = index * self._block
        end = min(start + self._block, self.size) - 1
        data = self._get(start, end).content
        self.bytes_fetched += len(data)
        self._cache[index] = data
        if len(self._cache) > self._max_blocks:
            self._cache.popitem(last=False)
        return data

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self.size}[whence]
        self._pos = max(0, base + offset)
        return self._pos

    def readinto(self, buffer) -> int:
        want = min(len(buffer), max(0, self.size - self._pos))
        done = 0
        while done < want:
            index, within = divmod(self._pos, self._block)
            chunk = self._block_bytes(index)[within : within + (want - done)]
            buffer[done : done + len(chunk)] = chunk
            done += len(chunk)
            self._pos += len(chunk)
        return done


def open_scene(url: str, token: str | None):
    """An open h5py.File for an http(s) URL (range reads) or a local path / file:// URL."""
    cache = dict(rdcc_nbytes=48 * 1024 * 1024)
    if url.startswith("file://"):
        return h5py.File(url[len("file://") :], "r", **cache)
    if not re.match(r"^https?://", url):
        return h5py.File(url, "r", **cache)
    try:
        return h5py.File(RangeFile(url, token), "r", **cache)
    except OSError as err:  # h5py could not parse what it was given
        raise SourceError("upstream", f"not a readable HDF5 file: {err}") from err


# ---------- what to draw ----------


@dataclass(frozen=True)
class LayerSpec:
    id: str  # layer id used in tile paths
    label: str
    dataset: str  # HDF5 path of the raster
    grid: str  # group holding xCoordinates, yCoordinates and projection
    kind: str  # 'db' | 'phase' | 'coherence'
    units: str
    style: str
    stat_key: str


def find_layers(h5: h5py.File, product: str) -> list[LayerSpec]:
    """The rasters worth drawing for a product, in the order they should be offered."""
    specs: list[LayerSpec] = []
    if product == "GCOV":
        grid = f"{LSAR}/GCOV/grids/frequencyA"
        if grid not in h5:
            return []
        chosen = [next((p for p in ("HH", "VV") if f"{p}{p}" in h5[grid]), None), next((p for p in ("HV", "VH") if f"{p}{p}" in h5[grid]), None)]
        for pol in filter(None, chosen):
            specs.append(
                LayerSpec(f"gcov_{pol.lower()}_db", f"{pol} backscatter", f"{grid}/{pol}{pol}", grid, "db", "dB", "gray", f"{pol.lower()}_db")
            )
    elif product == "GUNW":
        for pol in ("HH", "VV"):
            grid = f"{LSAR}/GUNW/grids/frequencyA/unwrappedInterferogram/{pol}"
            if grid not in h5:
                continue
            if "unwrappedPhase" in h5[grid]:
                specs.append(LayerSpec("gunw_unwrapped_phase", "Unwrapped phase", f"{grid}/unwrappedPhase", grid, "phase", "radians", "diverging", "unwrapped_phase"))
            if "coherenceMagnitude" in h5[grid]:
                specs.append(LayerSpec("gunw_coherence", "Coherence", f"{grid}/coherenceMagnitude", grid, "coherence", "unitless", "coherence", "coherence"))
            break
    return specs


@dataclass
class Raster:
    data: np.ndarray  # float32, NaN where there is no data
    transform: Affine
    crs: CRS
    pixel_m: float  # ground size of one (averaged) pixel
    lonlat_bounds: tuple[float, float, float, float]


def _grid_info(h5: h5py.File, grid: str):
    group = h5[grid]
    for name in ("xCoordinates", "yCoordinates", "projection"):
        if name not in group:
            raise SourceError("upstream", f"{grid} has no {name}")
    xs = np.asarray(group["xCoordinates"][:], dtype=np.float64)
    ys = np.asarray(group["yCoordinates"][:], dtype=np.float64)
    epsg = int(np.asarray(group["projection"][()]).reshape(-1)[0])
    if xs.size < 2 or ys.size < 2:
        raise SourceError("upstream", f"{grid} has an empty grid")
    return xs, ys, CRS.from_epsg(epsg)


def _span(coords: np.ndarray, lo: float, hi: float, step: float) -> tuple[int, int]:
    pad = abs(step)
    hits = np.nonzero((coords >= lo - pad) & (coords <= hi + pad))[0]
    if hits.size == 0:
        raise SourceError("coverage", "the scene does not cover the requested area")
    return int(hits[0]), int(hits[-1]) + 1


def read_layer(
    h5: h5py.File, spec: LayerSpec, bbox: list[float] | None, max_dim: int = 4096, margin: float = 0.25
) -> Raster:
    """Read the part of a layer around `bbox` (lon/lat), averaged down to at most `max_dim` pixels."""
    xs, ys, crs = _grid_info(h5, spec.grid)
    dx, dy = float(xs[1] - xs[0]), float(ys[1] - ys[0])
    if bbox:
        w, s, e, n = bbox
        mx, my = (e - w) * margin, (n - s) * margin
        minx, miny, maxx, maxy = transform_bounds(
            "EPSG:4326", crs, max(w - mx, -180), max(s - my, -89), min(e + mx, 180), min(n + my, 89), densify_pts=21
        )
        c0, c1 = _span(xs, minx, maxx, dx)
        r0, r1 = _span(ys, miny, maxy, dy)
    else:
        c0, c1, r0, r1 = 0, xs.size, 0, ys.size

    stride = max(1, math.ceil(max(r1 - r0, c1 - c0) / max_dim))
    out_rows, out_cols = (r1 - r0) // stride, (c1 - c0) // stride
    if out_rows < 1 or out_cols < 1:
        raise SourceError("coverage", "the requested area is smaller than one pixel of this scene")
    ds = h5[spec.dataset]
    if ds.dtype.kind == "c":
        raise SourceError("upstream", f"{spec.dataset} is complex; only real layers are drawn")
    out = np.full((out_rows, out_cols), np.nan, dtype=np.float32)

    # Read in horizontal strips, averaging stride x stride blocks (ignoring NaN) so memory stays small.
    strip = max(1, int(32e6 // max(1, 4 * (c1 - c0) * stride)))
    for row in range(0, out_rows, strip):
        rows_here = min(strip, out_rows - row)
        raw = ds[r0 + row * stride : r0 + (row + rows_here) * stride, c0 : c0 + out_cols * stride].astype(np.float32)
        raw[~np.isfinite(raw)] = np.nan
        if spec.kind == "db":
            raw[raw <= 0] = np.nan  # power is positive; zero or less is no data
        elif spec.kind == "phase":
            # Real GUNW files store unwrapped phase as exactly 0 where it was not computed (inside the swath, so not
            # NaN). Measured on two real scenes: those pixels are 98-99.8% exact zeros, while real phase is never
            # exactly 0. `connectedComponents` is NOT a usable mask: its label 0 is where the real phase lives.
            # Left in, the zeros would also pull the median that phase is shown relative to.
            raw[raw == 0] = np.nan
        if stride > 1:
            blocks = raw.reshape(rows_here, stride, out_cols, stride)
            finite = np.isfinite(blocks)
            total = np.where(finite, blocks, 0.0).sum(axis=(1, 3))
            count = finite.sum(axis=(1, 3))
            raw = np.where(count > 0, total / np.maximum(count, 1), np.nan).astype(np.float32)
        out[row : row + rows_here] = raw

    if spec.kind == "db":
        with np.errstate(divide="ignore", invalid="ignore"):
            out = (10.0 * np.log10(out)).astype(np.float32)
    elif spec.kind == "phase":
        if np.isfinite(out).any():
            out = (out - np.float32(np.nanmedian(out))).astype(np.float32)  # relative to the area's median
    elif spec.kind == "coherence":
        out = np.clip(out, 0.0, 1.0)

    x_edge, y_edge = float(xs[c0]) - dx / 2, float(ys[r0]) - dy / 2
    transform = Affine(dx * stride, 0, x_edge, 0, dy * stride, y_edge)
    left, top = x_edge, y_edge
    right, bottom = x_edge + dx * stride * out_cols, y_edge + dy * stride * out_rows
    wb = transform_bounds(crs, "EPSG:4326", min(left, right), min(top, bottom), max(left, right), max(top, bottom), densify_pts=21)
    return Raster(out, transform, crs, abs(dx) * stride, tuple(float(v) for v in wb))


def describe_scene(h5: h5py.File, product: str, stride: int = 8) -> dict:
    """What the drawable grids really contain, from a sparse sample: dtype, attributes, share of NaN and exact zeros."""
    out: dict = {"product": product, "grids": {}}
    roots = []
    if product == "GCOV":
        roots = [f"{LSAR}/GCOV/grids/frequencyA"]
    elif product == "GUNW":
        roots = [f"{LSAR}/GUNW/grids/frequencyA/{g}/{p}" for g in ("unwrappedInterferogram", "wrappedInterferogram") for p in ("HH", "VV")]
    for root in roots:
        if root not in h5:
            continue
        info = {}
        for name, ds in h5[root].items():
            if not isinstance(ds, h5py.Dataset) or ds.ndim != 2 or ds.dtype.kind not in "fiu":
                continue
            sample = np.asarray(ds[::stride, ::stride]).astype(np.float64)
            finite = np.isfinite(sample)
            values = sample[finite]
            info[name] = {
                "shape": list(ds.shape),
                "dtype": str(ds.dtype),
                "chunks": list(ds.chunks) if ds.chunks else None,
                "attrs": {k: str(v)[:60] for k, v in ds.attrs.items() if k in ("_FillValue", "units", "long_name", "description")},
                "nanFraction": round(float(1 - finite.mean()), 4),
                "zeroFraction": round(float((values == 0).mean()), 4) if values.size else None,
                "min": float(values.min()) if values.size else None,
                "max": float(values.max()) if values.size else None,
                "distinctValues": int(np.unique(values).size) if values.size and values.size < 200000 and ds.dtype.kind in "iu" else None,
            }
        out["grids"][root] = info
        # How the phase, its component label and the coherence relate (to tell fill from data in real files).
        group = h5[root]
        if all(n in group for n in ("unwrappedPhase", "connectedComponents", "coherenceMagnitude")):
            phase = np.asarray(group["unwrappedPhase"][::stride, ::stride], dtype=np.float64)
            label = np.asarray(group["connectedComponents"][::stride, ::stride]).astype(np.int64)
            coherence = np.asarray(group["coherenceMagnitude"][::stride, ::stride], dtype=np.float64)
            table = {}
            for value in np.unique(label)[:8]:
                pick = label == value
                p, c = phase[pick], coherence[pick]
                nonzero = p[np.isfinite(p) & (p != 0)]
                table[str(int(value))] = {
                    "share": round(float(pick.mean()), 4),
                    "phaseNaN": round(float(np.isnan(p).mean()), 4),
                    "phaseZero": round(float((p == 0).mean()), 4),
                    "phaseNonzeroP2P98": [round(float(v), 3) for v in np.percentile(nonzero, [2, 98])] if nonzero.size else None,
                    "coherenceMean": round(float(np.nanmean(c)), 4) if np.isfinite(c).any() else None,
                    "coherenceNaN": round(float(np.isnan(c).mean()), 4),
                }
            out.setdefault("crosstab", {})[root] = table
    return out
