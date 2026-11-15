"""Fixtures for the processor tests: NISAR-shaped HDF5 files, a range-request server, an upload sink."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import h5py
import numpy as np
from rasterio.warp import transform

CENTER = (-117.2, 35.5)  # lon, lat: UTM zone 11N
BBOX = [CENTER[0] - 0.03, CENTER[1] - 0.03, CENTER[0] + 0.03, CENTER[1] + 0.03]
EPSG = 32611


def _grid(rows: int, cols: int, step: float):
    cx, cy = transform("EPSG:4326", f"EPSG:{EPSG}", [CENTER[0]], [CENTER[1]])
    xs = cx[0] + (np.arange(cols) - cols / 2) * step + step / 2
    ys = cy[0] - (np.arange(rows) - rows / 2) * step - step / 2  # north-up: y decreases
    return xs, ys


def _put_grid(group: h5py.Group, xs, ys):
    group["xCoordinates"] = xs
    group["yCoordinates"] = ys
    proj = group.create_dataset("projection", data=np.int32(EPSG))
    proj.attrs["epsg_code"] = EPSG


def _raster(group, name, values):
    group.create_dataset(name, data=values.astype(np.float32), chunks=(64, 64), compression="gzip")


def make_gcov(path, rows=400, cols=500, step=30.0, pols=("HH", "HV"), hh_power=0.1, complex_hh=False):
    """A GCOV file shaped like JPL D-102274: frequencyA/{HHHH,...} with shared coordinates."""
    xs, ys = _grid(rows, cols, step)
    with h5py.File(path, "w") as f:
        g = f.create_group("/science/LSAR/GCOV/grids/frequencyA")
        _put_grid(g, xs, ys)
        for pol in pols:
            copol = pol[0] == pol[1]
            power = np.full((rows, cols), hh_power if copol else 0.01, dtype=np.float32)
            power += (np.arange(cols, dtype=np.float32) / cols) * power  # a gentle left-to-right ramp
            power[:10, :10] = np.nan  # a hole of no data
            power[20:30, 20:30] = 0.0  # zero power: also no data
            name = pol * 2  # the spec names covariance terms HHHH, HVHV, VVVV, VHVH
            if complex_hh and copol:
                g.create_dataset(name, data=power.astype(np.complex64), chunks=(64, 64))
            else:
                _raster(g, name, power)
    return path


def make_gunw(path, rows=300, cols=360, step=80.0, pol="HH", components=True):
    """A GUNW file shaped like JPL D-102272: unwrappedInterferogram/HH/{unwrappedPhase,coherenceMagnitude}."""
    xs, ys = _grid(rows, cols, step)
    with h5py.File(path, "w") as f:
        g = f.create_group(f"/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/{pol}")
        _put_grid(g, xs, ys)
        col = np.arange(cols, dtype=np.float32)
        phase = np.tile(col / cols * 12.0 + 40.0, (rows, 1))  # a ramp riding on a large offset
        phase[:5, :5] = np.nan
        # like the real files: phase is stored as exactly 0 where it was not computed, and those pixels carry
        # component label 1, while the real phase sits under label 0 (the reverse of the usual convention)
        labels = np.zeros((rows, cols), dtype=np.uint16)
        labels[150:, :120] = 1
        phase[labels == 1] = 0.0
        coherence = np.tile(col / cols * 1.4, (rows, 1))  # exceeds 1 on purpose: must be clipped
        if components:
            ds = g.create_dataset("connectedComponents", data=labels, chunks=(64, 64), compression="gzip")
            ds.attrs["_FillValue"] = np.uint16(65535)
        _raster(g, "unwrappedPhase", phase)
        _raster(g, "coherenceMagnitude", coherence)
    return path


class RangeServer:
    """Serves one file with Range support, behaving like ASF: a bearer-token redirect to a signed URL."""

    def __init__(self, path, token="good-token", expire_on_signed_request=None):
        self.path, self.token = path, token
        self.requests: list[tuple[str, str, str | None]] = []  # (path, range, authorization)
        self.expire_on = expire_on_signed_request  # 403 this numbered signed-URL request, once
        self.signed_count = 0
        outer = self
        data = open(path, "rb").read()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _empty(self, status, location=None):
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):
                rng = self.headers.get("Range", "")
                outer.requests.append((self.path, rng, self.headers.get("Authorization")))
                port = outer.server.server_address[1]
                if self.path == "/scene.h5":
                    if self.headers.get("Authorization") == f"Bearer {outer.token}":
                        return self._empty(302, f"http://localhost:{port}/signed/scene.h5")  # another host name
                    return self._empty(302, "https://urs.earthdata.nasa.gov/oauth/authorize?client_id=x")
                if self.path == "/signed/scene.h5":
                    outer.signed_count += 1
                    if outer.signed_count == outer.expire_on:
                        return self._empty(403)
                    start, end = [int(v) for v in rng.removeprefix("bytes=").split("-")]
                    end = min(end, len(data) - 1)
                    body = data[start : end + 1]
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                return self._empty(404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.size = len(data)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/scene.h5"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Sink:
    """Stands in for the Worker's /internal/processor routes: records every PUT."""

    def __init__(self, token="proc-token", fail_with=None):
        self.token, self.fail_with = token, fail_with
        self.tiles: dict[str, bytes] = {}
        self.manifest: dict | None = None
        self.order: list[str] = []
        self.auth_seen: set[str | None] = set()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_PUT(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.auth_seen.add(self.headers.get("Authorization"))
                if outer.fail_with:
                    self.send_response(outer.fail_with)
                elif self.headers.get("Authorization") != f"Bearer {outer.token}":
                    self.send_response(401)
                else:
                    if self.path.endswith("/manifest"):
                        outer.manifest = json.loads(body)
                        outer.order.append("manifest")
                    else:
                        outer.tiles[self.path] = body
                        outer.order.append("tile")
                    self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
