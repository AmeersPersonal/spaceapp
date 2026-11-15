"""End-to-end check of the built image, run inside it (see processor/SPEC.md, "Tests").

The service is already listening on :8080 with EARTHDATA_TOKEN=good-token (the proc-token below is sent per request).
This script plays ASF (range requests behind an Earthdata-style redirect) and the Worker (tile and
manifest PUTs), sends real jobs to POST /process, and checks what came back.
"""

import io
import sys
import tempfile
import time
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers import BBOX, RangeServer, Sink, make_gcov, make_gunw  # noqa: E402

BASE = "http://127.0.0.1:8080"
AUTH = {"Authorization": "Bearer proc-token"}
tmp = Path(tempfile.mkdtemp())


def job(url, product, sink, **over):
    return {
        "eventId": "ev-e2e", "sceneId": f"NISAR_{product}_20261002T071128_x", "product": product, "url": url,
        "acquiredAt": "2026-10-02T07:11:28Z", "bbox": BBOX, "polarizations": ["HH"], "callbackBase": sink.base, **over,
    }


def post(body, headers=AUTH):
    return requests.post(f"{BASE}/process", json=body, headers=headers, timeout=300)


for _ in range(30):
    try:
        if requests.get(f"{BASE}/health", timeout=2).ok:
            break
    except requests.RequestException:
        time.sleep(1)
print("health:", requests.get(f"{BASE}/health").json())

# 1. GCOV over HTTP: redirect, range reads, tiles and a manifest delivered to the Worker stand-in.
gcov = RangeServer(make_gcov(tmp / "gcov.h5"))
sink = Sink()
r = post(job(gcov.url, "GCOV", sink))
print("GCOV:", r.status_code, r.json())
assert r.status_code == 200 and r.json()["status"] == "ready" and r.json()["layers"] == ["gcov_hh_db", "gcov_hv_db"], r.text
assert sink.order[-1] == "manifest" and len(sink.tiles) == r.json()["tiles"] > 0
assert Image.open(io.BytesIO(next(iter(sink.tiles.values())))).size == (256, 256)
signed = [a for p, _, a in gcov.requests if p.startswith("/signed")]
assert signed and all(a is None for a in signed), "the Earthdata token must not reach the signed host"
print("  tiles:", len(sink.tiles), "| range requests:", len(gcov.requests), "| manifest layers:", [l["layer"] for l in sink.manifest["layers"]])

# 2. GUNW.
gunw = RangeServer(make_gunw(tmp / "gunw.h5"))
sink2 = Sink()
r = post(job(gunw.url, "GUNW", sink2, sceneId="NISAR_GUNW_20261002T071128_y"))
print("GUNW:", r.status_code, r.json())
assert r.status_code == 200 and r.json()["layers"] == ["gunw_unwrapped_phase", "gunw_coherence"], r.text

# 3. An expired Earthdata token comes back as 424, so the Worker can keep the scene waiting.
bad = RangeServer(tmp / "gcov.h5", token="some-other-token")
r = post(job(bad.url, "GCOV", Sink()))
print("bad token:", r.status_code, r.json())
assert r.status_code == 424 and r.json()["error"] == "earthdata_auth"

# 4. A product that is not drawn is skipped; a request without a bearer token is refused.
r = post(job(gcov.url, "GOFF", Sink()))
assert r.status_code == 200 and r.json()["status"] == "skipped", r.text
assert post(job(gcov.url, "GCOV", Sink()), headers={}).status_code == 401

# 5. The Worker answering 401 (token mismatch) surfaces as a retryable 502, never a silent success.
r = post(job(gcov.url, "GCOV", Sink(token="different")))
print("worker refuses:", r.status_code, r.json())
assert r.status_code == 502 and r.json()["error"] == "upload"
print("E2E OK")
