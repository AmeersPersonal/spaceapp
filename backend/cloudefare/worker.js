// Earth Replay API — Cloudflare Worker entry point (Hono).
// Exposes the REST/tile/WebSocket contract from backend/CLAUDE.md plus the queue and cron handlers,
// and exports the Workflow and Durable Object classes bound in wrangler.jsonc.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  DATA_CREDIT,
  cacheKeys,
  cached,
  getEvent,
  insertEvent,
  listCaptionsForEvent,
  listEvents,
  listLayersForEvent,
  listScenesForEvent,
  tileKey,
} from './dataManger.js';
import { requireIngestKey } from './oAuth.js';
import { normalizeRoomCode } from './sessionManger.js';
import { answerQuestion, hashQuestion, validateAskRequest } from './AI/AIManger.js';
import { AIError } from './AI/AIGateway.js';
import {
  EventError,
  SUPPLEMENTARY_CREDIT,
  fetchEarthquakes,
  googleMapApi,
  handleEvent,
  nisarData,
  parseBboxParam,
  parseDiscoverQuery,
  quakeToIngestRequest,
} from './events.js';
import { getIngestStatus, handleQueue, parseIngestRequest, runScheduledPoll, startIngest } from './workFlowManger.js';

export { IngestWorkflow } from './workFlowManger.js';
export { ReplayRoom } from './replay.js';

const EVENT_CACHE_TTL = 60;
const ANSWER_CACHE_TTL = 3600;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LAYER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const app = new Hono();

app.use('/api/*', async (c, next) => cors({ origin: c.env.CORS_ORIGIN || '*' })(c, next));
app.use('/tiles/*', async (c, next) => cors({ origin: c.env.CORS_ORIGIN || '*' })(c, next));

app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: 'internal_error', message: 'Unexpected server error' }, 500);
});
app.notFound((c) => c.json({ error: 'not_found' }, 404));

const badRequest = (c, errors) => c.json({ error: 'invalid_request', details: errors }, 400);

async function readJson(c) {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

app.get('/', (c) =>
  c.json({
    service: 'earth-replay-api',
    routes: [
      'GET /api/events',
      'GET /api/events/:id',
      'GET /tiles/:event/:layer/:date/:z/:x/:y.png',
      'GET /api/discover/earthquakes',
      'POST /api/events/earthquake',
      'GET /api/nisar/search',
      'GET /api/geocode',
      'POST /api/ingest',
      'GET /api/ingest/:id',
      'POST /api/ask',
      'WS /api/room/:code',
    ],
    credit: DATA_CREDIT,
  }),
);

// ---------- catalog ----------

app.get('/api/events', async (c) => {
  const events = await cached(c.env.CACHE, cacheKeys.eventList(), EVENT_CACHE_TTL, () => listEvents(c.env.DB));
  return c.json({ events, credit: DATA_CREDIT });
});

app.get('/api/events/:id', async (c) => {
  const id = c.req.param('id');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid event id']);
  const detail = await cached(c.env.CACHE, cacheKeys.event(id), EVENT_CACHE_TTL, async () => {
    const event = await getEvent(c.env.DB, id);
    if (!event) return null;
    const [scenes, layers, captions] = await Promise.all([
      listScenesForEvent(c.env.DB, id),
      listLayersForEvent(c.env.DB, id),
      listCaptionsForEvent(c.env.DB, id),
    ]);
    return {
      event,
      scenes,
      dates: [...new Set(scenes.map((s) => s.acquiredAt.slice(0, 10)))].sort(),
      polarizations: [...new Set(scenes.flatMap((s) => s.polarizations))].sort(),
      layers,
      captions,
    };
  });
  if (!detail) return c.json({ error: 'not_found', message: `event ${id} not found` }, 404);
  return c.json({ ...detail, credit: DATA_CREDIT });
});

// ---------- tiles ----------

/** Validate z/x/y web-mercator tile coordinates. */
export function parseTileCoords(z, x, yFile) {
  const m = /^(\d{1,8})\.png$/.exec(yFile ?? '');
  if (!m || !/^\d{1,2}$/.test(z) || !/^\d{1,8}$/.test(x)) return null;
  const [zi, xi, yi] = [Number(z), Number(x), Number(m[1])];
  if (zi > 22) return null;
  const n = 2 ** zi;
  if (xi >= n || yi >= n) return null;
  return { z: zi, x: xi, y: yi };
}

app.get('/tiles/:event/:layer/:date/:z/:x/:y', async (c) => {
  const { event, layer, date, z, x, y } = c.req.param();
  const coords = parseTileCoords(z, x, y);
  if (!SAFE_ID_RE.test(event) || !LAYER_RE.test(layer) || !DATE_RE.test(date) || !coords) {
    return badRequest(c, ['invalid tile path; expected /tiles/:event/:layer/:YYYY-MM-DD/:z/:x/:y.png']);
  }
  const obj = await c.env.TILES.get(tileKey(event, layer, date, coords.z, coords.x, coords.y));
  if (!obj) return c.body(null, 404, { 'cache-control': 'public, max-age=300' });
  const headers = {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=86400',
    etag: obj.httpEtag,
    'x-data-credit': 'NISAR: NASA/JPL-Caltech, ISRO; ASF DAAC',
  };
  if (c.req.header('if-none-match') === obj.httpEtag) return c.body(null, 304, headers);
  return c.body(obj.body, 200, headers);
});

// ---------- ingest ----------

function newEventId(name) {
  const slug = (name ?? 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
  return `${slug}-${crypto.randomUUID().slice(0, 6)}`;
}

app.post('/api/ingest', requireIngestKey(), async (c) => {
  const body = await readJson(c);
  const parsed = parseIngestRequest(body);
  if (parsed.errors) return badRequest(c, parsed.errors);
  const req = parsed.value;

  let event = req.eventId ? await getEvent(c.env.DB, req.eventId) : null;
  if (!event) {
    event = await insertEvent(c.env.DB, {
      id: req.eventId ?? newEventId(req.name),
      name: req.name ?? `AOI ${req.aoi.bbox.map((n) => n.toFixed(2)).join(', ')}`,
      type: req.type,
      description: req.description,
      aoiWkt: req.aoi.wkt,
      bbox: req.aoi.bbox,
      products: req.products,
      watch: req.watch,
    });
  }
  const ingest = await startIngest(c.env, { event, start: req.dateRange.start, end: req.dateRange.end });
  return c.json({ ...ingest, statusUrl: `/api/ingest/${ingest.id}` }, 202);
});

app.get('/api/ingest/:id', async (c) => {
  const id = c.req.param('id');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid ingest id']);
  const status = await getIngestStatus(c.env, id);
  if (!status) return c.json({ error: 'not_found', message: `ingest ${id} not found` }, 404);
  return c.json({ ...status, credit: DATA_CREDIT });
});

// ---------- discovery & external data ----------

const DISCOVER_CACHE_TTL = 600;
const STATUS_BY_CODE = { invalid_request: 400, not_found: 404, not_configured: 503 };

/** Map an EventError to an HTTP response; rethrow anything else. */
function eventErrorResponse(c, err) {
  if (!(err instanceof EventError)) throw err;
  const status = STATUS_BY_CODE[err.code] ?? 502;
  if (status >= 500) console.error(`${err.code}: ${err.message}`);
  return c.json({ error: err.code, message: status === 502 ? 'Upstream data source is unavailable' : err.message }, status);
}

app.get('/api/discover/earthquakes', async (c) => {
  const parsed = parseDiscoverQuery(new URL(c.req.url).searchParams);
  if (parsed.errors) return badRequest(c, parsed.errors);
  try {
    const key = `discover:quakes:${parsed.value.minMagnitude}:${parsed.value.days}:${parsed.value.bbox?.join(',') ?? 'world'}`;
    const quakes = await cached(c.env.CACHE, key, DISCOVER_CACHE_TTL, () => fetchEarthquakes(parsed.value));
    const earthquakes = await Promise.all(
      quakes.map(async (q) => {
        const suggested = quakeToIngestRequest(q);
        return { ...q, suggested, registered: Boolean(await getEvent(c.env.DB, suggested.eventId)) };
      }),
    );
    return c.json({ earthquakes, credit: { ...DATA_CREDIT, supplementary: SUPPLEMENTARY_CREDIT.usgs } });
  } catch (err) {
    return eventErrorResponse(c, err);
  }
});

app.post('/api/events/earthquake', requireIngestKey(), async (c) => {
  const body = await readJson(c);
  if (typeof body?.usgsId !== 'string') return badRequest(c, ['usgsId is required (e.g. "us6000u18k")']);
  try {
    const out = await handleEvent({ source: 'usgs', usgsId: body.usgsId }, c.env);
    return c.json(out, 202);
  } catch (err) {
    return eventErrorResponse(c, err);
  }
});

app.get('/api/nisar/search', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const bbox = parseBboxParam(q.get('bbox'));
  if (bbox.error) return badRequest(c, [bbox.error]);
  const products = q.get('products') ? q.get('products').split(',') : undefined;
  try {
    const out = await nisarData({ bbox: bbox.bbox, start: q.get('start'), end: q.get('end'), products }, c.env);
    return c.json({ ...out, credit: DATA_CREDIT });
  } catch (err) {
    return eventErrorResponse(c, err);
  }
});

app.get('/api/geocode', async (c) => {
  try {
    const result = await googleMapApi({ query: c.req.query('q') }, c.env);
    if (!result) return c.json({ error: 'not_found', message: 'No place matched that query' }, 404);
    return c.json(result);
  } catch (err) {
    return eventErrorResponse(c, err);
  }
});

// ---------- AI ----------

app.post('/api/ask', async (c) => {
  const parsed = validateAskRequest(await readJson(c));
  if (parsed.errors) return badRequest(c, parsed.errors);
  const { eventId, question } = parsed.value;
  if (!SAFE_ID_RE.test(eventId)) return badRequest(c, ['invalid eventId']);
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return c.json({ error: 'not_found', message: `event ${eventId} not found` }, 404);
  try {
    const key = cacheKeys.answer(eventId, await hashQuestion(question));
    const result = await cached(c.env.CACHE, key, ANSWER_CACHE_TTL, async () => {
      const scenes = await listScenesForEvent(c.env.DB, eventId);
      return answerQuestion(c.env, { event, scenes, question });
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof AIError) {
      console.error('ask failed', err.message);
      return c.json({ error: 'ai_unavailable', message: 'The AI service is temporarily unavailable' }, 502);
    }
    throw err;
  }
});

// ---------- replay rooms ----------

app.get('/api/room/:code', async (c) => {
  const code = normalizeRoomCode(c.req.param('code'));
  if (!code) return badRequest(c, ['room code must be 4-12 letters or digits']);
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'upgrade_required', message: 'Connect with a WebSocket' }, 426);
  }
  const stub = c.env.REPLAY_ROOM.get(c.env.REPLAY_ROOM.idFromName(code));
  return stub.fetch(c.req.raw);
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runScheduledPoll(env, controller.scheduledTime));
  },
};
