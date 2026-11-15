"""HTTP face of the processor, run inside a Cloudflare Container.

POST /process  {eventId, sceneId, product, url, acquiredAt, bbox, polarizations, callbackBase}
  200 {status:'ready', layers, tiles}     tiles and manifest are in R2 (through the Worker)
  200 {status:'skipped', reason}          nothing to draw for this scene; try nothing else
  401                                     no bearer token (it is passed on to the Worker's callback routes)
  424 {error:'earthdata_auth'}            Earthdata Login rejected EARTHDATA_TOKEN
  429 {error:'busy'}                      already working on a scene; retry later
  502 {error:'upstream'|'upload'}         ASF or the Worker failed; retry later
  422 {error:'invalid_job'}               the job is malformed
"""

from __future__ import annotations

import logging
import os
import re
import threading
from typing import Optional

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError, field_validator

import nisar
import pipeline
from uploader import UploadError, WorkerUploader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("processor")

app = FastAPI(title="Earth Replay processor")
_busy = threading.Lock()  # one scene at a time: a scene's blocks and canvases need the instance's memory

SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")


class Job(BaseModel):
    eventId: str
    sceneId: str
    product: str
    url: str
    callbackBase: str
    acquiredAt: Optional[str] = None
    bbox: Optional[list[float]] = Field(default=None, min_length=4, max_length=4)
    polarizations: list[str] = []
    earthdataToken: Optional[str] = Field(default=None, repr=False)  # per job, so a new secret needs no restart

    @field_validator("eventId", "sceneId")
    @classmethod
    def _safe(cls, v: str) -> str:
        if not SAFE_ID.match(v):
            raise ValueError("unsafe identifier")
        return v

    @field_validator("callbackBase")
    @classmethod
    def _http(cls, v: str) -> str:
        if not re.match(r"^https?://", v):
            raise ValueError("callbackBase must be an http(s) URL")
        return v


def _bearer(header: Optional[str]) -> str:
    """The token sent with the request (empty when there is none).

    The container is only reachable through the Worker, and the Worker's own routes are what the token
    protects, so the container keeps no copy: it uses the one it is given to report back. A wrong token
    simply fails there, and rotating the secret needs no restart.
    """
    match = re.match(r"^Bearer (\S+)$", header or "")
    return match.group(1) if match else ""


@app.get("/health")
def health():
    return {"ok": True, "busy": _busy.locked(), "earthdataToken": bool(os.environ.get("EARTHDATA_TOKEN"))}


@app.post("/process")
def process(payload: dict, authorization: Optional[str] = Header(default=None)):
    proc_token = _bearer(authorization)
    if not proc_token:
        return JSONResponse({"error": "unauthorized", "message": "send Authorization: Bearer <token>"}, status_code=401)
    try:
        job = Job(**payload)
    except ValidationError as err:
        # field names and reasons only: never echo the values back (one of them is a token)
        problems = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in err.errors())
        return JSONResponse({"error": "invalid_job", "message": problems[:300]}, status_code=422)
    except TypeError as err:
        return JSONResponse({"error": "invalid_job", "message": "malformed job"}, status_code=422)

    if not _busy.acquire(blocking=False):
        return JSONResponse({"error": "busy", "message": "already processing a scene"}, status_code=429)
    try:
        token = job.earthdataToken or os.environ.get("EARTHDATA_TOKEN") or None
        log.info("job %s %s %s", job.eventId, job.product, job.sceneId)
        result = pipeline.process_job(
            job.model_dump(),
            make_uploader=lambda j: WorkerUploader(j["callbackBase"], proc_token, j["eventId"], j["sceneId"]),
            token=token,
        )
        log.info("job done: %s", result)
        return result
    except nisar.SourceError as err:
        log.warning("source error (%s): %s", err.kind, err)
        if err.kind == "auth":
            return JSONResponse({"error": "earthdata_auth", "message": str(err)}, status_code=424)
        if err.kind == "coverage":
            return {"status": "skipped", "reason": str(err)}
        return JSONResponse({"error": "upstream", "message": str(err)}, status_code=502)
    except UploadError as err:
        log.warning("upload error: %s", err)
        return JSONResponse({"error": "upload", "message": str(err)}, status_code=502)
    except ValueError as err:  # e.g. no acquisition date
        return JSONResponse({"error": "invalid_job", "message": str(err)}, status_code=422)
    except Exception as err:  # noqa: BLE001 - report, never crash the instance
        log.exception("processing failed")
        return JSONResponse({"error": "internal", "message": f"{type(err).__name__}: {err}"[:300]}, status_code=500)
    finally:
        _busy.release()


@app.post("/inspect")
def inspect_scene(payload: dict, authorization: Optional[str] = Header(default=None)):
    """What a scene's drawable grids really contain (dtype, fill values, share of NaN and zeros), from a sparse sample."""
    if not _bearer(authorization):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        url, product = str(payload["url"]), str(payload["product"])
    except KeyError:
        return JSONResponse({"error": "invalid_job", "message": "url and product are required"}, status_code=422)
    token = payload.get("earthdataToken") or os.environ.get("EARTHDATA_TOKEN") or None
    if not _busy.acquire(blocking=False):
        return JSONResponse({"error": "busy"}, status_code=429)
    try:
        h5 = nisar.open_scene(url, token)
        try:
            return nisar.describe_scene(h5, product)
        finally:
            h5.close()
    except nisar.SourceError as err:
        auth = err.kind == "auth"
        return JSONResponse({"error": "earthdata_auth" if auth else "upstream", "message": str(err)}, status_code=424 if auth else 502)
    except Exception as err:  # noqa: BLE001
        log.exception("inspect failed")
        return JSONResponse({"error": "internal", "message": f"{type(err).__name__}: {err}"[:300]}, status_code=500)
    finally:
        _busy.release()
