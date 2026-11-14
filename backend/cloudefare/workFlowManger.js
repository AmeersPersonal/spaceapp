// Ingest pipeline:
//   POST /api/ingest or cron  ->  IngestWorkflow (search ASF, catalog scenes, enqueue)
//   INGEST_QUEUE 'process' msg ->  dispatch scene to the Python processor (h5py/rasterio, outside the Worker)
//   processor writes tiles + manifests/{eventId}/{sceneId}.json to R2
//   R2 event notification      ->  INGEST_QUEUE  ->  register layers in D1, mark scene ready, AI caption
//   messages that exhaust retries -> earth-replay-ingest-dlq -> scene marked failed
// HDF5 is never opened inside the Worker (CLAUDE.md constraint).

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { AsfError, NISAR_PRODUCTS, searchNisar } from './asf.js';
import { processorHeaders } from './oAuth.js';
import { captionScene } from './AI/AIManger.js';
import {
  createIngest,
  extendEventDates,
  getEvent,
  getIngest,
  getScene,
  invalidateEvent,
  listScenesForIngest,
  listWatchedEvents,
  manifestKey,
  markEventPolled,
  parseManifestKey,
  readManifest,
  setSceneStatus,
  updateIngest,
  upsertLayers,
  upsertScenes,
} from './dataManger.js';

export const NISAR_LAUNCH_DATE = '2025-07-30';
export const MAX_RANGE_DAYS = 366;
export const MAX_AOI_DEGREES = 5;
export const EVENT_TYPES = Object.freeze(['earthquake', 'flood', 'wetland', 'forest', 'crop', 'glacier', 'soil_moisture', 'other']);
const DEFAULT_PRODUCTS = {
  earthquake: ['GUNW'],
  glacier: ['GOFF'],
  soil_moisture: ['SME2'],
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LAYER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const TERMINAL_SCENE_STATUSES = new Set(['ready', 'failed']);

// ---------- request validation ----------

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Accepts [w,s,e,n] or a GeoJSON Polygon. Returns { bbox, wkt } or { error }. */
export function parseAoi(aoi) {
  let ring;
  if (Array.isArray(aoi) && aoi.length === 4 && aoi.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const [w, s, e, n] = aoi;
    ring = [[w, s], [e, s], [e, n], [w, n], [w, s]];
  } else if (aoi?.type === 'Polygon' && Array.isArray(aoi.coordinates?.[0])) {
    ring = aoi.coordinates[0];
    if (ring.length < 4 || !ring.every((p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite)))
      return { error: 'aoi Polygon must have a closed ring of at least 4 [lon, lat] positions' };
    const [f, l] = [ring[0], ring[ring.length - 1]];
    if (f[0] !== l[0] || f[1] !== l[1]) return { error: 'aoi Polygon ring must be closed' };
  } else {
    return { error: 'aoi must be [west, south, east, north] or a GeoJSON Polygon' };
  }
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const [w, s, e, n] = bbox;
  if (w < -180 || e > 180 || s < -90 || n > 90) return { error: 'aoi coordinates out of range' };
  if (!(w < e) || !(s < n)) return { error: 'aoi must have non-zero area (west < east, south < north)' };
  if (e - w > MAX_AOI_DEGREES || n - s > MAX_AOI_DEGREES) return { error: `aoi must be at most ${MAX_AOI_DEGREES} degrees on each side` };
  const wkt = `POLYGON((${ring.map((p) => `${p[0]} ${p[1]}`).join(',')}))`;
  return { bbox, wkt };
}

export function parseIngestRequest(body, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: ['body must be a JSON object'] };

  const aoi = parseAoi(body.aoi);
  if (aoi.error) errors.push(aoi.error);

  const start = body.dateRange?.start;
  const end = body.dateRange?.end;
  if (!isValidDate(start) || !isValidDate(end)) {
    errors.push('dateRange.start and dateRange.end must be YYYY-MM-DD dates');
  } else {
    if (start > end) errors.push('dateRange.start must be on or before dateRange.end');
    if (end < NISAR_LAUNCH_DATE) errors.push(`dateRange must end on or after NISAR launch (${NISAR_LAUNCH_DATE})`);
    if (start > today) errors.push('dateRange.start cannot be in the future');
    const days = (Date.parse(end) - Date.parse(start)) / 86400000;
    if (days > MAX_RANGE_DAYS) errors.push(`dateRange must span at most ${MAX_RANGE_DAYS} days`);
  }

  const type = body.type ?? 'other';
  if (!EVENT_TYPES.includes(type)) errors.push(`type must be one of ${EVENT_TYPES.join(', ')}`);

  let products = body.products ?? DEFAULT_PRODUCTS[type] ?? ['GCOV'];
  if (!Array.isArray(products) || !products.length || !products.every((p) => NISAR_PRODUCTS.includes(p)))
    errors.push(`products must be a non-empty array of ${NISAR_PRODUCTS.join(', ')}`);
  else products = [...new Set(products)];

  if (body.eventId !== undefined && !(typeof body.eventId === 'string' && EVENT_ID_RE.test(body.eventId)))
    errors.push('eventId must be 3-64 chars of lowercase letters, digits, "-" or "_"');
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120))
    errors.push('name must be a non-empty string of at most 120 characters');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000))
    errors.push('description must be a string of at most 1000 characters');
  if (body.watch !== undefined && typeof body.watch !== 'boolean') errors.push('watch must be a boolean');

  if (errors.length) return { errors };
  return {
    value: {
      eventId: body.eventId ?? null,
      name: body.name?.trim() ?? null,
      description: body.description ?? null,
      type,
      products,
      watch: body.watch ?? false,
      aoi,
      dateRange: { start, end },
    },
  };
}

// ---------- starting ingests ----------

/** Record an ingest in D1 and start its Workflow instance. Used by the API route and the cron poller. */
export async function startIngest(env, { event, start, end, trigger = 'api' }) {
  const id = `ing_${crypto.randomUUID()}`;
  await createIngest(env.DB, { id, eventId: event.id, start, end, trigger });
  const params = {
    ingestId: id,
    eventId: event.id,
    wkt: event.aoiWkt,
    start,
    end,
    products: event.products,
    maxScenes: Number(env.MAX_SCENES_PER_INGEST) || 25,
  };
  try {
    await env.INGEST_WORKFLOW.create({ id, params });
  } catch (err) {
    await updateIngest(env.DB, id, { status: 'failed', error: `could not start workflow: ${err.message}` });
    throw err;
  }
  return { id, eventId: event.id, status: 'queued', dateRange: { start, end } };
}

/** Status for GET /api/ingest/:id: D1 record + per-scene progress + Workflow instance status. */
export async function getIngestStatus(env, id) {
  const ingest = await getIngest(env.DB, id);
  if (!ingest) return null;
  const scenes = await listScenesForIngest(env.DB, id);
  const counts = {};
  for (const s of scenes) counts[s.status] = (counts[s.status] ?? 0) + 1;

  let status = ingest.status;
  if (status === 'dispatched' && scenes.every((s) => TERMINAL_SCENE_STATUSES.has(s.status))) status = 'complete';

  let workflow = null;
  try {
    const instance = await env.INGEST_WORKFLOW.get(id);
    const s = await instance.status();
    workflow = { status: s.status, error: s.error ?? null };
  } catch {
    workflow = { status: 'unknown', error: null };
  }

  return {
    ...ingest,
    status,
    workflow,
    progress: { total: scenes.length, ...counts },
    scenes: scenes.map((s) => ({ id: s.id, product: s.product, acquiredAt: s.acquiredAt, status: s.status, error: s.error, url: s.url })),
  };
}

// ---------- Workflow ----------

export class IngestWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const p = event.payload;
    try {
      await step.do('mark-searching', async () => {
        await updateIngest(this.env.DB, p.ingestId, { status: 'searching' });
        return true;
      });

      const scenes = await step.do(
        'search-asf',
        { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        async () => {
          try {
            return await searchNisar(this.env, { wkt: p.wkt, start: p.start, end: p.end, products: p.products, maxResults: p.maxScenes });
          } catch (err) {
            if (err instanceof AsfError && !err.retryable) throw new NonRetryableError(err.message);
            throw err;
          }
        },
      );

      await step.do('catalog-scenes', async () => {
        await upsertScenes(this.env.DB, p.eventId, p.ingestId, scenes);
        if (scenes.length) await extendEventDates(this.env.DB, p.eventId, p.start, p.end);
        return scenes.length;
      });

      await step.do('enqueue-scenes', async () => {
        for (let i = 0; i < scenes.length; i += 100) {
          await this.env.INGEST_QUEUE.sendBatch(
            scenes.slice(i, i + 100).map((s) => ({ body: { type: 'process', ingestId: p.ingestId, eventId: p.eventId, sceneId: s.id } })),
          );
        }
        return scenes.length;
      });

      await step.do('finalize', async () => {
        await updateIngest(this.env.DB, p.ingestId, { status: 'dispatched', sceneCount: scenes.length });
        await invalidateEvent(this.env.CACHE, p.eventId);
        return true;
      });

      return { ingestId: p.ingestId, sceneCount: scenes.length, sceneIds: scenes.map((s) => s.id) };
    } catch (err) {
      await step.do('mark-failed', async () => {
        await updateIngest(this.env.DB, p.ingestId, { status: 'failed', error: String(err?.message ?? err).slice(0, 500) });
        return true;
      });
      throw err;
    }
  }
}

// ---------- Queue consumer ----------

class PermanentError extends Error {}

/** Send a scene to the external processor. Marks it processing, or awaiting_processor when none is configured. */
export async function dispatchScene(env, body, fetchImpl = fetch) {
  const scene = await getScene(env.DB, body.sceneId);
  if (!scene) throw new PermanentError(`unknown scene ${body.sceneId}`);
  if (scene.status === 'ready') return 'already-ready';
  const event = await getEvent(env.DB, scene.eventId);
  if (!env.PROCESSOR_URL) {
    await setSceneStatus(env.DB, scene.id, 'awaiting_processor');
    return 'awaiting_processor';
  }
  const job = {
    eventId: scene.eventId,
    sceneId: scene.id,
    product: scene.product,
    url: scene.url,
    polarizations: scene.polarizations,
    bbox: event?.bbox ?? null,
    output: { tilePrefix: `tiles/${scene.eventId}/`, manifestKey: manifestKey(scene.eventId, scene.id) },
  };
  const res = await fetchImpl(env.PROCESSOR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...processorHeaders(env) },
    body: JSON.stringify(job),
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentError(`processor rejected job: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`processor unavailable: HTTP ${res.status}`);
  await setSceneStatus(env.DB, scene.id, 'processing');
  return 'processing';
}

export function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.layers)) return 'manifest.layers must be an array';
  for (const l of manifest.layers) {
    if (!LAYER_RE.test(l?.layer ?? '')) return `invalid layer id "${l?.layer}"`;
    if (!isValidDate(l.date)) return `invalid layer date "${l.date}"`;
    const minZ = l.minZoom ?? 0;
    const maxZ = l.maxZoom ?? 12;
    if (!Number.isInteger(minZ) || !Number.isInteger(maxZ) || minZ < 0 || maxZ > 22 || minZ > maxZ) return `invalid zoom range for ${l.layer}`;
  }
  return null;
}

/** Handle an R2 object-create notification for manifests/{eventId}/{sceneId}.json. */
export async function handleManifestNotification(env, body) {
  const ref = parseManifestKey(body.object?.key);
  if (!ref) return 'ignored';
  const manifest = await readManifest(env.TILES, body.object.key);
  if (!manifest) throw new Error(`manifest ${body.object.key} not readable yet`);
  const invalid = validateManifest(manifest);
  if (invalid) throw new PermanentError(invalid);
  const [scene, event] = await Promise.all([getScene(env.DB, ref.sceneId), getEvent(env.DB, ref.eventId)]);
  if (!scene || !event || scene.eventId !== event.id) throw new PermanentError(`manifest for unknown scene ${ref.sceneId}`);

  await upsertLayers(env.DB, event.id, scene.id, manifest.layers);
  const wasReady = scene.status === 'ready';
  await setSceneStatus(env.DB, scene.id, 'ready');
  await invalidateEvent(env.CACHE, event.id);
  // Caption once per scene; an AI failure retries the message (layer registration is idempotent).
  if (!wasReady) await captionScene(env, { event, scene, manifest });
  return 'ready';
}

const isR2Notification = (body) => typeof body?.object?.key === 'string' && typeof body?.action === 'string';

export async function handleQueue(batch, env, deps = {}) {
  if (batch.queue.endsWith('-dlq')) return handleDeadLetters(batch, env);
  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      if (body?.type === 'process') await dispatchScene(env, body, deps.fetch);
      else if (isR2Notification(body)) {
        if (/^(PutObject|CopyObject|CompleteMultipartUpload)$/.test(body.action)) await handleManifestNotification(env, body);
      } else console.warn('ingest queue: dropping unrecognized message', JSON.stringify(body)?.slice(0, 200));
      msg.ack();
    } catch (err) {
      if (err instanceof PermanentError) {
        console.error('ingest queue: permanent failure', err.message);
        const sceneId = body?.sceneId ?? parseManifestKey(body?.object?.key)?.sceneId;
        if (sceneId) await setSceneStatus(env.DB, sceneId, 'failed', err.message).catch(() => {});
        msg.ack();
      } else {
        console.warn('ingest queue: retrying', err.message);
        msg.retry({ delaySeconds: Math.min(300, 15 * 2 ** (msg.attempts - 1)) });
      }
    }
  }
}

export async function handleDeadLetters(batch, env) {
  for (const msg of batch.messages) {
    const body = msg.body;
    const sceneId = body?.sceneId ?? parseManifestKey(body?.object?.key)?.sceneId;
    if (sceneId) {
      const reason = body?.type === 'process' ? 'processor dispatch failed after retries' : 'manifest registration failed after retries';
      await setSceneStatus(env.DB, sceneId, 'failed', reason);
    }
    msg.ack();
  }
}

// ---------- Cron ----------

/** Start an ingest for every watched event covering the time since it was last polled. */
export async function runScheduledPoll(env, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const fallbackStart = new Date(nowMs - 12 * 86400000).toISOString().slice(0, 10); // NISAR 12-day repeat
  const started = [];
  const failed = [];
  for (const event of await listWatchedEvents(env.DB)) {
    const start = event.lastPolledAt?.slice(0, 10) ?? event.endDate ?? fallbackStart;
    try {
      const ingest = await startIngest(env, { event, start: start > today ? today : start, end: today, trigger: 'cron' });
      await markEventPolled(env.DB, event.id, new Date(nowMs).toISOString());
      started.push(ingest.id);
    } catch (err) {
      console.error(`cron: failed to start ingest for ${event.id}`, err.message);
      failed.push(event.id);
    }
  }
  return { started, failed };
}
