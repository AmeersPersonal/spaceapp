// The NISAR tile processor, hosted on Cloudflare: a Container running the Python service in
// processor/, plus the routes it reports to.
//
//   queue message -> dispatchScene (workFlowManger.js) -> callContainer -> POST /process in the container
//   container reads the scene from ASF, draws tiles, then PUTs them to /internal/processor/... here
//   this Worker stores them in R2, so the container never needs R2 credentials
//
// Routes (all need `Authorization: Bearer PROCESSOR_TOKEN`):
//   PUT /internal/processor/:eventId/:sceneId/tiles/:layer/:date/:z/:x/:y   one PNG tile
//   PUT /internal/processor/:eventId/:sceneId/manifest                     last: registers layers, marks the scene ready
//   GET /internal/processor/health                                         is the container up, does it have an Earthdata token
//   POST /internal/processor/dispatch {sceneId | eventId}                  queue scenes for processing again
//   POST /internal/processor/inspect {sceneId}                             what the scene's grids really contain

import { Container, getContainer } from '@cloudflare/containers';
import { deleteCaptionsForScene, getEvent, getScene, listScenesForEvent, manifestKey, setSceneStatus, tileKey } from './dataManger.js';
import { safeEqual, processorHeaders } from './oAuth.js';
import { PermanentError, handleManifestNotification, validateManifest } from './workFlowManger.js';

export const PROCESSOR_INSTANCES = 2; // keep equal to max_instances in wrangler.jsonc
export const CONTAINER_TIMEOUT_MS = 14 * 60 * 1000; // a queue consumer may run for 15 minutes
const MAX_TILE_BYTES = 1_000_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SCENE_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const LAYER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export class Processor extends Container {
  defaultPort = 8080;
  sleepAfter = '20m'; // longer than one job can take; an instance idle this long is stopped and the next job starts it again
  enableInternet = true; // it reads scenes from ASF and reports to this Worker

  constructor(ctx, env) {
    super(ctx, env);
    // Only a fallback: each job carries the current EARTHDATA_TOKEN, and the request carries PROCESSOR_TOKEN.
    this.envVars = { EARTHDATA_TOKEN: env.EARTHDATA_TOKEN ?? '' };
  }
}

/** Instance names to try for a scene, starting with the one its name hashes to, so a retry finds the job it started. */
export function instanceOrder(sceneId, instances = PROCESSOR_INSTANCES) {
  let h = 0;
  for (const ch of String(sceneId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: instances }, (_, i) => `p${(h + i) % instances}`);
}

export const pickInstance = (sceneId, instances = PROCESSOR_INSTANCES) => instanceOrder(sceneId, instances)[0];

/**
 * POST a job to the processor container and return its Response. An instance works on one scene at a time and
 * answers 429 when busy, so the next instance is tried before giving that answer back.
 */
export async function callContainer(env, job, timeoutMs = CONTAINER_TIMEOUT_MS) {
  let last;
  for (const name of instanceOrder(job.sceneId)) {
    last = await getContainer(env.PROCESSOR, name).fetch(
      new Request('http://processor/process', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...processorHeaders(env) },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (last.status !== 429) return last;
  }
  return last;
}

/** Null when the caller holds PROCESSOR_TOKEN; otherwise the Response to send back. */
function denied(c) {
  const token = c.env.PROCESSOR_TOKEN;
  if (!token) return c.json({ error: 'not_configured', message: 'PROCESSOR_TOKEN is not set' }, 503);
  if (!safeEqual(c.req.header('authorization') ?? '', `Bearer ${token}`)) return c.json({ error: 'unauthorized' }, 401);
  return null;
}

export function mountProcessorRoutes(app) {
  // Is the processor up, and does it have an Earthdata token? Starts an instance if none is running.
  app.get('/internal/processor/health', async (c) => {
    const no = denied(c);
    if (no) return no;
    if (!c.env.PROCESSOR) return c.json({ error: 'not_configured', message: 'no PROCESSOR container binding' }, 503);
    try {
      const res = await getContainer(c.env.PROCESSOR, instanceOrder('health')[0]).fetch(new Request('http://processor/health'));
      return c.json({ processor: await res.json(), status: res.status, earthdataTokenSet: Boolean(c.env.EARTHDATA_TOKEN) });
    } catch (err) {
      return c.json({ error: 'processor_unavailable', message: String(err?.message ?? err).slice(0, 200) }, 502);
    }
  });

  // What a scene's grids really contain (fill values, share of NaN and zeros), read by the container from ASF.
  app.post('/internal/processor/inspect', async (c) => {
    const no = denied(c);
    if (no) return no;
    const body = await c.req.json().catch(() => null);
    if (typeof body?.sceneId !== 'string' || !SCENE_ID_RE.test(body.sceneId)) return c.json({ error: 'invalid_request', message: 'send {"sceneId": ...}' }, 400);
    if (!c.env.PROCESSOR) return c.json({ error: 'not_configured', message: 'no PROCESSOR container binding' }, 503);
    const scene = await getScene(c.env.DB, body.sceneId);
    if (!scene) return c.json({ error: 'not_found', message: 'unknown scene' }, 404);
    try {
      const res = await getContainer(c.env.PROCESSOR, instanceOrder('inspect')[0]).fetch(
        new Request('http://processor/inspect', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...processorHeaders(c.env) },
          body: JSON.stringify({ url: scene.url, product: scene.product, ...(c.env.EARTHDATA_TOKEN ? { earthdataToken: c.env.EARTHDATA_TOKEN } : {}) }),
          signal: AbortSignal.timeout(CONTAINER_TIMEOUT_MS),
        }),
      );
      return c.json(await res.json(), res.status);
    } catch (err) {
      return c.json({ error: 'processor_unavailable', message: String(err?.message ?? err).slice(0, 200) }, 502);
    }
  });

  // Send scenes to the processor again (after replacing EARTHDATA_TOKEN, say) without signing in:
  // {sceneId} for one scene, or {eventId} for every scene of that event that is not ready yet. With
  // "force": true, scenes that are ready are drawn again too (after a change to how layers are drawn).
  app.post('/internal/processor/dispatch', async (c) => {
    const no = denied(c);
    if (no) return no;
    const body = await c.req.json().catch(() => null);
    let scenes = [];
    if (typeof body?.sceneId === 'string' && SCENE_ID_RE.test(body.sceneId)) {
      const scene = await getScene(c.env.DB, body.sceneId);
      scenes = scene ? [scene] : [];
    } else if (typeof body?.eventId === 'string' && EVENT_ID_RE.test(body.eventId)) {
      if (!(await getEvent(c.env.DB, body.eventId))) return c.json({ error: 'not_found', message: 'unknown event' }, 404);
      scenes = (await listScenesForEvent(c.env.DB, body.eventId)).filter((s) => body.force === true || s.status !== 'ready');
    } else {
      return c.json({ error: 'invalid_request', message: 'send {"sceneId": ...} or {"eventId": ...}' }, 400);
    }
    if (!scenes.length) return c.json({ error: 'not_found', message: 'no scenes to send' }, 404);
    for (let i = 0; i < scenes.length; i += 100) {
      await c.env.INGEST_QUEUE.sendBatch(
        scenes.slice(i, i + 100).map((s) => ({ body: { type: 'process', ingestId: null, eventId: s.eventId, sceneId: s.id, ...(body.force === true ? { force: true } : {}) } })),
      );
    }
    return c.json({ queued: scenes.length, sceneIds: scenes.map((s) => s.id) }, 202);
  });

  app.put('/internal/processor/:eventId/:sceneId/tiles/:layer/:date/:z/:x/:y', async (c) => {
    const no = denied(c);
    if (no) return no;
    const { eventId, sceneId, layer, date, z, x, y } = c.req.param();
    const zoom = /^\d{1,2}$/.test(z) ? Number(z) : NaN;
    const tx = /^\d{1,8}$/.test(x) ? Number(x) : NaN;
    const ty = /^\d{1,8}$/.test(y) ? Number(y) : NaN;
    const n = 2 ** zoom;
    if (!EVENT_ID_RE.test(eventId) || !SCENE_ID_RE.test(sceneId) || !LAYER_RE.test(layer) || !DATE_RE.test(date) || !(zoom <= 22) || !(tx < n) || !(ty < n)) {
      return c.json({ error: 'invalid_request', message: 'invalid tile path' }, 400);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_TILE_BYTES) {
      return c.json({ error: 'invalid_request', message: `tile must be 1 to ${MAX_TILE_BYTES} bytes` }, body.byteLength ? 413 : 400);
    }
    const head = new Uint8Array(body, 0, 4);
    if (!PNG_MAGIC.every((b, i) => head[i] === b)) return c.json({ error: 'invalid_request', message: 'tile must be a PNG' }, 415);
    await c.env.TILES.put(tileKey(eventId, layer, date, zoom, tx, ty), body, { httpMetadata: { contentType: 'image/png' } });
    return c.json({ ok: true });
  });

  app.put('/internal/processor/:eventId/:sceneId/manifest', async (c) => {
    const no = denied(c);
    if (no) return no;
    const { eventId, sceneId } = c.req.param();
    if (!EVENT_ID_RE.test(eventId) || !SCENE_ID_RE.test(sceneId)) return c.json({ error: 'invalid_request', message: 'invalid path' }, 400);
    const text = await c.req.text();
    if (text.length > MAX_MANIFEST_BYTES) return c.json({ error: 'invalid_request', message: 'manifest is too large' }, 413);
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      return c.json({ error: 'invalid_request', message: 'manifest must be JSON' }, 400);
    }
    const invalid = validateManifest(manifest);
    if (invalid) return c.json({ error: 'invalid_manifest', message: invalid }, 422);

    const key = manifestKey(eventId, sceneId);
    await c.env.TILES.put(key, text, { httpMetadata: { contentType: 'application/json' } });
    // Drawn again: the old caption describes the old numbers, so replace it (a scene that was not ready gets one anyway).
    const before = await getScene(c.env.DB, sceneId).catch(() => null);
    if (before?.status === 'ready') {
      const ids = await deleteCaptionsForScene(c.env.DB, sceneId);
      if (ids.length) await c.env.VECTORS.deleteByIds(ids).catch((err) => console.error('could not remove old caption vectors:', err.message));
      await setSceneStatus(c.env.DB, sceneId, 'processing');
    }
    try {
      // The same step an R2 notification would run: register layers and stats, mark the scene ready, caption it.
      await handleManifestNotification(c.env, { object: { key } });
      return c.json({ status: 'ready' });
    } catch (err) {
      if (err instanceof PermanentError) return c.json({ error: 'manifest_rejected', message: err.message }, 422);
      // A caption (AI) failure comes after the scene is already ready: the tiles are live, so report success.
      const scene = await getScene(c.env.DB, sceneId).catch(() => null);
      if (scene?.status === 'ready') {
        console.error('processor manifest accepted, caption failed:', err.message);
        return c.json({ status: 'ready', caption: 'failed' });
      }
      console.error('processor manifest failed:', err.message);
      return c.json({ error: 'manifest_failed', message: 'could not register the manifest' }, 502);
    }
  });
}
