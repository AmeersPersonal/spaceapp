import h5py
import numpy as np
import pytest

import nisar
from helpers import BBOX, CENTER, RangeServer, make_gcov, make_gunw


def test_finds_the_layers_to_draw(gcov_file, gunw_file, tmp_path):
    with h5py.File(gcov_file) as f:
        assert [s.id for s in nisar.find_layers(f, "GCOV")] == ["gcov_hh_db", "gcov_hv_db"]
        assert nisar.find_layers(f, "GUNW") == []  # wrong product for this file
        assert nisar.find_layers(f, "GOFF") == []
    with h5py.File(gunw_file) as f:
        specs = nisar.find_layers(f, "GUNW")
        assert [s.id for s in specs] == ["gunw_unwrapped_phase", "gunw_coherence"]
        assert specs[0].units == "radians" and specs[0].dataset.endswith("HH/unwrappedPhase")
    vv = make_gcov(tmp_path / "vv.h5", pols=("VV", "VH"))
    with h5py.File(vv) as f:
        assert [s.id for s in nisar.find_layers(f, "GCOV")] == ["gcov_vv_db", "gcov_vh_db"]


def test_backscatter_becomes_decibels_with_no_data_masked(gcov_file):
    with h5py.File(gcov_file) as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        r = nisar.read_layer(f, spec, None)
    assert r.data.shape == (400, 500) and r.data.dtype == np.float32
    assert np.isnan(r.data[:10, :10]).all() and np.isnan(r.data[20:30, 20:30]).all()  # NaN and zero power
    assert np.nanmin(r.data) == pytest.approx(10 * np.log10(0.1), abs=0.01)  # left edge of the ramp: 0.1 -> -10 dB
    assert np.nanmax(r.data) < -6.9  # 0.2 at most -> about -7 dB
    assert r.pixel_m == 30.0 and r.crs.to_epsg() == 32611


def test_crops_to_the_area_and_keeps_its_place(gcov_file):
    with h5py.File(gcov_file) as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        full = nisar.read_layer(f, spec, None)
        part = nisar.read_layer(f, spec, BBOX)
    assert part.data.shape[0] < full.data.shape[0] and part.data.shape[1] < full.data.shape[1]
    west, south, east, north = part.lonlat_bounds
    assert west < CENTER[0] < east and south < CENTER[1] < north
    assert west <= BBOX[0] and east >= BBOX[2]  # at least the requested box, plus the margin


def test_large_areas_are_averaged_down(gcov_file):
    with h5py.File(gcov_file) as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        full = nisar.read_layer(f, spec, None)
        small = nisar.read_layer(f, spec, None, max_dim=100)
    assert max(small.data.shape) <= 100 and small.pixel_m > full.pixel_m
    assert small.pixel_m == pytest.approx(30.0 * 5)  # 500 px -> stride 5
    assert np.nanmean(small.data) == pytest.approx(np.nanmean(full.data), abs=0.3)  # same picture, fewer pixels
    assert small.lonlat_bounds[0] == pytest.approx(full.lonlat_bounds[0], abs=1e-4)


def test_an_area_the_scene_misses_is_a_coverage_error(gcov_file):
    with h5py.File(gcov_file) as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        with pytest.raises(nisar.SourceError) as err:
            nisar.read_layer(f, spec, [-100.0, 30.0, -99.5, 30.5])
    assert err.value.kind == "coverage"


def test_unwrapped_phase_is_relative_and_coherence_is_clipped(gunw_file):
    with h5py.File(gunw_file) as f:
        phase_spec, coh_spec = nisar.find_layers(f, "GUNW")
        phase = nisar.read_layer(f, phase_spec, None)
        coherence = nisar.read_layer(f, coh_spec, None)
    assert np.nanmedian(phase.data) == pytest.approx(0.0, abs=1e-4)  # the +40 rad offset is gone
    assert np.nanmax(phase.data) - np.nanmin(phase.data) == pytest.approx(12.0, abs=0.1)
    assert np.isnan(phase.data[:5, :5]).all()
    # phase the file stored as exactly 0 is fill: masked, not drawn
    assert np.isnan(phase.data[200, 50])
    assert np.isfinite(phase.data[200, 200]) and np.isfinite(phase.data[50, 50])
    assert np.nanmax(coherence.data) == 1.0 and np.nanmin(coherence.data) >= 0.0


def test_zero_phase_is_fill_whatever_the_component_label_says(tmp_path):
    """Measured on real scenes: component 0 holds the real phase and component 1 the zeros. Never mask by label."""
    for components in (True, False):
        path = make_gunw(tmp_path / f"c{components}.h5", components=components)
        with h5py.File(path) as f:
            spec = nisar.find_layers(f, "GUNW")[0]
            raw = np.asarray(f[spec.dataset][:])
            phase = nisar.read_layer(f, spec, None)
        assert np.isnan(phase.data[raw == 0]).all()  # every stored zero is gone
        real = np.isfinite(raw) & (raw != 0)
        assert np.isfinite(phase.data[real]).all()  # and every real value is kept (the label-0 pixels the file calls "no component")


def test_the_median_is_taken_over_real_data_only(tmp_path):
    """Fill being a large share of the pixels must not move the zero point of the phase."""
    path = make_gunw(tmp_path / "half.h5")
    with h5py.File(path) as f:
        spec = nisar.find_layers(f, "GUNW")[0]
        raw = np.asarray(f[spec.dataset][:])
        valid = raw[np.isfinite(raw) & (raw != 0)]
        phase = nisar.read_layer(f, spec, None)
    assert np.nanmedian(phase.data) == pytest.approx(0.0, abs=1e-4)
    assert np.nanmax(phase.data) == pytest.approx(np.nanmax(valid) - np.median(valid), abs=0.01)


def test_complex_layers_are_refused(tmp_path):
    path = make_gcov(tmp_path / "c.h5", complex_hh=True)
    with h5py.File(path) as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        with pytest.raises(nisar.SourceError, match="complex"):
            nisar.read_layer(f, spec, None)


def test_a_file_without_coordinates_is_reported(tmp_path):
    path = tmp_path / "broken.h5"
    with h5py.File(path, "w") as f:
        g = f.create_group("/science/LSAR/GCOV/grids/frequencyA")
        g.create_dataset("HHHH", data=np.ones((4, 4), dtype=np.float32))
    with h5py.File(path) as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        with pytest.raises(nisar.SourceError, match="xCoordinates"):
            nisar.read_layer(f, spec, None)


# ---------- reading over HTTP ----------


def test_reads_over_range_requests_and_keeps_the_token_off_the_signed_host(range_server):
    with nisar.open_scene(range_server.url, "good-token") as f:
        spec = nisar.find_layers(f, "GCOV")[0]
        r = nisar.read_layer(f, spec, BBOX)
    assert r.data.size > 0 and np.isfinite(r.data).any()
    assert all(rng.startswith("bytes=") for _, rng, _ in range_server.requests[1:])
    signed = [(p, a) for p, _, a in range_server.requests if p.startswith("/signed")]
    assert signed and all(a is None for _, a in signed)  # the token never goes to the other host
    assert range_server.requests[0][2] == "Bearer good-token"


def test_a_rejected_token_is_an_auth_error(range_server):
    with pytest.raises(nisar.SourceError) as err:
        nisar.open_scene(range_server.url, "expired-token")
    assert err.value.kind == "auth"
    with pytest.raises(nisar.SourceError) as err:
        nisar.open_scene(range_server.url, None)
    assert err.value.kind == "auth"


def test_an_expired_signed_url_is_signed_again(gcov_file):
    server = RangeServer(gcov_file, expire_on_signed_request=3)  # after the two checks made while opening
    try:
        with nisar.open_scene(server.url, "good-token") as f:
            assert nisar.find_layers(f, "GCOV")
        assert [p for p, _, _ in server.requests].count("/scene.h5") == 2  # signed once, then again after the 403
    finally:
        server.close()


def test_a_server_without_range_support_is_an_upstream_error(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    class NoRanges(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "3")
            self.end_headers()
            self.wfile.write(b"abc")

    server = ThreadingHTTPServer(("127.0.0.1", 0), NoRanges)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with pytest.raises(nisar.SourceError) as err:
            nisar.open_scene(f"http://127.0.0.1:{server.server_address[1]}/x.h5", "t")
        assert err.value.kind == "upstream"
    finally:
        server.shutdown()
        server.server_close()


def test_a_local_path_or_file_url_opens_directly(gcov_file):
    for url in (str(gcov_file), f"file://{gcov_file}"):
        with nisar.open_scene(url, None) as f:
            assert nisar.find_layers(f, "GCOV")
