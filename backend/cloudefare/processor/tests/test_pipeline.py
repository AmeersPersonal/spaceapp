import io
import re

import pytest
from PIL import Image

import nisar
import pipeline
from helpers import BBOX, CENTER, Sink
from uploader import UploadError, WorkerUploader

TOKEN = "proc-token"


def job(file, product="GCOV", **over):
    return {
        "eventId": "ev1",
        "sceneId": "NISAR_L2_PR_GCOV_001_002_A_003_4005_SHNA_A_20261002T071128_20261002T071157_P05007_N_F_J_001",
        "product": product,
        "url": str(file),
        "acquiredAt": "2026-10-02T07:11:28.000Z",
        "bbox": BBOX,
        "callbackBase": "unused",
        **over,
    }


def run(j, sink, **kw):
    return pipeline.process_job(j, make_uploader=lambda x: WorkerUploader(sink.base, TOKEN, x["eventId"], x["sceneId"]), **kw)


def test_scene_date_prefers_the_catalog_then_the_name():
    assert pipeline.scene_date("2026-10-02T07:11:28Z", "x") == "2026-10-02"
    assert pipeline.scene_date(None, "NISAR_..._20260914T184515_20260914T184540_x") == "2026-09-14"
    with pytest.raises(ValueError):
        pipeline.scene_date(None, "no-date-here")


def test_gcov_scene_becomes_tiles_then_a_manifest(gcov_file, sink):
    out = run(job(gcov_file), sink)
    assert out["status"] == "ready" and out["layers"] == ["gcov_hh_db", "gcov_hv_db"] and out["date"] == "2026-10-02"
    assert out["tiles"] == len(sink.tiles) > 0
    assert sink.order[-1] == "manifest" and sink.order.count("manifest") == 1  # the manifest goes last, once

    manifest = sink.manifest
    assert [l["layer"] for l in manifest["layers"]] == ["gcov_hh_db", "gcov_hv_db"]
    for layer in manifest["layers"]:
        assert layer["date"] == "2026-10-02" and layer["units"] == "dB"
        assert 3 <= layer["minZoom"] < layer["maxZoom"] <= 12
        w, s, e, n = layer["bounds"]
        assert w < CENTER[0] < e and s < CENTER[1] < n
        assert layer["range"][0] < layer["range"][1]
    assert manifest["stats"]["hh_db"]["mean"] == pytest.approx(-8.7, abs=1.5)  # 0.1-0.2 power: about -10 to -7 dB
    assert manifest["stats"]["hh_db"]["validFraction"] > 0.9
    assert manifest["stats"]["hv_db"]["mean"] < manifest["stats"]["hh_db"]["mean"]  # cross-pol is weaker

    pattern = re.compile(r"^/internal/processor/ev1/NISAR_[^/]+/tiles/(gcov_h[hv]_db)/2026-10-02/(\d+)/(\d+)/(\d+)$")
    zooms = set()
    for path, png in sink.tiles.items():
        m = pattern.match(path)
        assert m, path
        zooms.add(int(m.group(2)))
        assert Image.open(io.BytesIO(png)).size == (256, 256)
    layer = manifest["layers"][0]
    assert zooms == set(range(layer["minZoom"], layer["maxZoom"] + 1))
    assert sink.auth_seen == {f"Bearer {TOKEN}"}


def test_gunw_scene_gives_phase_and_coherence(gunw_file, sink):
    out = run(job(gunw_file, product="GUNW", bbox=None), sink)  # the whole grid, so the masked block is included
    assert out["layers"] == ["gunw_unwrapped_phase", "gunw_coherence"]
    phase, coherence = sink.manifest["layers"]
    assert phase["units"] == "radians" and phase["range"][0] == -phase["range"][1]  # symmetric about zero
    assert coherence["range"] == [0.0, 1.0]
    assert sink.manifest["stats"]["unwrapped_phase"]["median"] == pytest.approx(0.0, abs=0.2)
    assert sink.manifest["stats"]["unwrapped_phase"]["validFraction"] < 0.95  # the unwrapper's no-solution pixels are not data
    assert sink.manifest["stats"]["coherence"]["p98"] <= 1.0


def test_products_without_a_renderer_are_skipped_without_opening_the_file(sink):
    def explode(*a):
        raise AssertionError("must not open the scene")

    for product in ("GOFF", "SME2"):
        out = run(job("/nope", product=product), sink, open_scene=explode)
        assert out["status"] == "skipped" and product in out["reason"]
    assert sink.tiles == {} and sink.manifest is None


def test_a_file_with_nothing_to_draw_is_skipped(tmp_path, sink):
    import h5py

    path = tmp_path / "empty.h5"
    with h5py.File(path, "w") as f:
        f.create_group("/science/LSAR/GCOV/grids/frequencyA")
    out = run(job(path), sink)
    assert out["status"] == "skipped" and "no drawable" in out["reason"]
    assert sink.manifest is None


def test_an_area_the_scene_misses_is_skipped_or_reported(gcov_file, sink):
    far = [-100.0, 30.0, -99.5, 30.5]
    out = run(job(gcov_file, bbox=far), sink)  # every layer misses: skipped, nothing uploaded
    assert out["status"] == "skipped" and "does not cover" in out["reason"]
    assert sink.manifest is None


def test_a_missing_acquisition_date_is_an_error(gcov_file, sink):
    with pytest.raises(ValueError):
        run(job(gcov_file, acquiredAt=None, sceneId="no-date"), sink)


def test_authentication_failures_propagate(range_server, sink):
    j = job(range_server.url)
    with pytest.raises(nisar.SourceError) as err:
        run(j, sink, token="wrong")
    assert err.value.kind == "auth"


def test_uploads_to_a_worker_that_refuses_fail_loudly(gcov_file):
    bad = Sink(token="another-token")
    try:
        with pytest.raises(UploadError, match="401"):
            run(job(gcov_file), bad)
        assert bad.manifest is None
    finally:
        bad.close()


def test_uploads_retry_server_errors_then_give_up(gcov_file):
    down = Sink(fail_with=500)
    try:
        with pytest.raises(UploadError):
            run(job(gcov_file), down)
    finally:
        down.close()
