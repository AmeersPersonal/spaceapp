import threading

import pytest
from fastapi.testclient import TestClient

import nisar
import server
from helpers import BBOX
from uploader import UploadError

client = TestClient(server.app)
TOKEN = "proc-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("EARTHDATA_TOKEN", "edl-token")


def payload(**over):
    return {
        "eventId": "ev1",
        "sceneId": "scene_1",
        "product": "GCOV",
        "url": "https://example.test/scene.h5",
        "callbackBase": "https://worker.test",
        "acquiredAt": "2026-10-02T00:00:00Z",
        "bbox": BBOX,
        "polarizations": ["HH"],
        **over,
    }


def test_health_needs_no_token_and_reports_state():
    r = client.get("/health")
    assert r.status_code == 200 and r.json() == {"ok": True, "busy": False, "earthdataToken": True}


def test_needs_a_bearer_token_and_passes_it_on(monkeypatch):
    for headers in ({}, {"Authorization": "Bearer "}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer two words"}):
        r = client.post("/process", json=payload(), headers=headers)
        assert r.status_code == 401 and r.json()["error"] == "unauthorized", headers
    seen = {}

    def fake(job, make_uploader, token):
        seen["base"] = make_uploader(job).session.headers["Authorization"]
        return {"status": "ready"}

    monkeypatch.setattr(server.pipeline, "process_job", fake)
    client.post("/process", json=payload(), headers={"Authorization": "Bearer rotated-secret"})
    assert seen["base"] == "Bearer rotated-secret"  # the container keeps no token of its own: it reports back with this one


@pytest.mark.parametrize(
    "bad",
    [{"eventId": "../etc"}, {"sceneId": "a b"}, {"callbackBase": "ftp://x"}, {"bbox": [1, 2, 3]}, {"url": None}],
)
def test_rejects_malformed_jobs(bad):
    r = client.post("/process", json=payload(**bad), headers=AUTH)
    assert r.status_code == 422 and r.json()["error"] == "invalid_job"


def test_the_jobs_own_token_wins_over_the_containers(monkeypatch):
    seen = []
    monkeypatch.setattr(server.pipeline, "process_job", lambda job, make_uploader, token: seen.append(token) or {"status": "ready"})
    client.post("/process", json=payload(earthdataToken="fresh-token"), headers=AUTH)
    client.post("/process", json=payload(), headers=AUTH)
    assert seen == ["fresh-token", "edl-token"]  # the secret changed since the container started: the job's token is used


def test_error_messages_never_echo_the_token():
    r = client.post("/process", json=payload(earthdataToken="super-secret-value", eventId="../bad"), headers=AUTH)
    assert r.status_code == 422
    assert "super-secret-value" not in r.text and "eventId" in r.json()["message"]


def test_a_finished_job_returns_the_summary(monkeypatch):
    seen = {}

    def fake(job, make_uploader, token):
        seen.update(job=job, token=token, uploader=make_uploader(job))
        return {"status": "ready", "layers": ["gcov_hh_db"], "tiles": 3}

    monkeypatch.setattr(server.pipeline, "process_job", fake)
    r = client.post("/process", json=payload(), headers=AUTH)
    assert r.status_code == 200 and r.json() == {"status": "ready", "layers": ["gcov_hh_db"], "tiles": 3}
    assert seen["token"] == "edl-token" and seen["job"]["sceneId"] == "scene_1"
    assert seen["uploader"].base == "https://worker.test/internal/processor/ev1/scene_1"


@pytest.mark.parametrize(
    "error, status, body",
    [
        (nisar.SourceError("auth", "token rejected"), 424, "earthdata_auth"),
        (nisar.SourceError("upstream", "ASF is down"), 502, "upstream"),
        (UploadError("worker said no"), 502, "upload"),
        (ValueError("no acquisition date"), 422, "invalid_job"),
        (RuntimeError("boom"), 500, "internal"),
    ],
)
def test_failures_map_to_status_codes(monkeypatch, error, status, body):
    def fail(*a, **k):
        raise error

    monkeypatch.setattr(server.pipeline, "process_job", fail)
    r = client.post("/process", json=payload(), headers=AUTH)
    assert r.status_code == status and r.json()["error"] == body


def test_a_scene_that_misses_the_area_is_skipped_not_failed(monkeypatch):
    def miss(*a, **k):
        raise nisar.SourceError("coverage", "the scene does not cover the requested area")

    monkeypatch.setattr(server.pipeline, "process_job", miss)
    r = client.post("/process", json=payload(), headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "skipped"


def test_only_one_scene_at_a_time(monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow(*a, **k):
        started.set()
        release.wait(10)
        return {"status": "ready", "layers": [], "tiles": 0}

    monkeypatch.setattr(server.pipeline, "process_job", slow)
    first = {}
    t = threading.Thread(target=lambda: first.update(r=client.post("/process", json=payload(), headers=AUTH)))
    t.start()
    assert started.wait(10)
    assert client.get("/health").json()["busy"] is True
    busy = client.post("/process", json=payload(sceneId="scene_2"), headers=AUTH)
    assert busy.status_code == 429 and busy.json()["error"] == "busy"
    release.set()
    t.join(10)
    assert first["r"].status_code == 200
    assert client.get("/health").json()["busy"] is False  # the lock is released


def test_full_job_over_http_with_a_real_file(gcov_file, sink):
    r = client.post(
        "/process",
        json=payload(url=str(gcov_file), callbackBase=sink.base),
        headers={"Authorization": f"Bearer {sink.token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready" and r.json()["tiles"] == len(sink.tiles) > 0
    assert sink.manifest["layers"][0]["layer"] == "gcov_hh_db"


def test_inspect_describes_the_grids_and_needs_a_token(gunw_file):
    assert client.post("/inspect", json={"url": str(gunw_file), "product": "GUNW"}).status_code == 401
    assert client.post("/inspect", json={"product": "GUNW"}, headers=AUTH).status_code == 422
    r = client.post("/inspect", json={"url": str(gunw_file), "product": "GUNW"}, headers=AUTH)
    assert r.status_code == 200
    grids = r.json()["grids"]
    (info,) = [v for k, v in grids.items() if k.endswith("unwrappedInterferogram/HH")]
    assert info["unwrappedPhase"]["dtype"] == "float32" and 0 < info["unwrappedPhase"]["nanFraction"] < 1
    assert info["coherenceMagnitude"]["max"] > 1  # the fixture's coherence exceeds 1 on purpose


def test_inspect_reports_a_rejected_token(monkeypatch):
    def refuse(url, token):
        raise nisar.SourceError("auth", "token rejected")

    monkeypatch.setattr(server.nisar, "open_scene", refuse)
    r = client.post("/inspect", json={"url": "https://x.test/a.h5", "product": "GCOV"}, headers=AUTH)
    assert r.status_code == 424 and r.json()["error"] == "earthdata_auth"
