"""Sends tiles and the manifest to the Earth Replay Worker, which stores them in R2.

The container has no R2 credentials: the Worker owns the bucket and accepts PUTs on
/internal/processor/... from anyone holding PROCESSOR_TOKEN.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


class UploadError(Exception):
    pass


class WorkerUploader:
    def __init__(self, base_url: str, token: str, event_id: str, scene_id: str, workers: int = 8):
        self.base = f"{base_url.rstrip('/')}/internal/processor/{quote(event_id, safe='')}/{quote(scene_id, safe='')}"
        self.workers = workers
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"
        retry = Retry(total=3, backoff_factor=0.5, status_forcelist=(500, 502, 503, 504), allowed_methods=("PUT",))
        self.session.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=workers))
        self.session.mount("http://", HTTPAdapter(max_retries=retry, pool_maxsize=workers))
        self.tiles_sent = 0

    def _put(self, url: str, body: bytes, content_type: str) -> None:
        try:
            r = self.session.put(url, data=body, headers={"content-type": content_type}, timeout=(10, 60))
        except requests.RequestException as err:
            raise UploadError(f"upload failed: {err}") from err
        if not r.ok:
            raise UploadError(f"upload rejected with HTTP {r.status_code}: {r.text[:200]}")

    def put_tiles(self, layer: str, date: str, tiles) -> int:
        """Upload (z, x, y, png) tuples with a few requests in flight; returns how many were sent."""
        sent = 0
        batch = []

        def flush():
            nonlocal sent
            if not batch:
                return
            with ThreadPoolExecutor(self.workers) as pool:
                list(pool.map(lambda t: self._put(f"{self.base}/tiles/{layer}/{date}/{t[0]}/{t[1]}/{t[2]}", t[3], "image/png"), batch))
            sent += len(batch)
            batch.clear()

        for tile in tiles:
            batch.append(tile)
            if len(batch) >= self.workers * 4:
                flush()
        flush()
        self.tiles_sent += sent
        return sent

    def put_manifest(self, manifest: dict) -> None:
        import json

        self._put(f"{self.base}/manifest", json.dumps(manifest).encode(), "application/json")
