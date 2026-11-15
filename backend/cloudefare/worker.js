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
  listSceneStats,
  listScenesForEvent,
  tileKey,
} from './dataManger.js';
import { authenticate, frontendOrigin, mountAuthRoutes } from './auth0.js';
import { HTTPException } from 'hono/http-exception';
import { chatHistory, getChat, limitChatBody, mountChatRoutes, saveChatMessages } from './chats.js';
import { normalizeRoomCode } from './sessionManger.js';
import { answerQuestion, hashQuestion, validateAskRequest } from './AI/AIManger.js';
import { AIError } from './AI/AIGateway.js';
import { describeAgents } from './AI/agents.js';
import { ChatError, getThread, runChat, validateChatRequest } from './AI/chat.js';
import { forecastEvent, parseHorizon } from './AI/forecast.js';
import { describeContext, ensureEventContext, promptContext } from './eventContext.js';
import { summarizeEvent, summaryCacheKey } from './AI/summary.js';
import { eventMedia } from './media.js';
import { mountProcessorRoutes } from './processor.js';
import { parseOutlookQuery, seismicOutlook } from './outlook.js';
import {
  EventError,
  datasetContext,
  fetchDataset,
  listDatasets,
  parseDatasetQuery,
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
export { Processor } from './processor.js';

const EVENT_CACHE_TTL = 60;
const ANSWER_CACHE_TTL = 3600;
const SUMMARY_CACHE_TTL = 3600;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LAYER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const app = new Hono();

app.use('/api/*', async (c, next) => {
  const origins = (c.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
  return cors({
    origin: origins.includes('*') ? '*' : origins,
    credentials: !origins.includes('*'),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })(c, next);
});
app.use('/tiles/*', async (c, next) => cors({ origin: c.env.CORS_ORIGIN || '*' })(c, next));
app.use('*', authenticate);
mountAuthRoutes(app);
mountChatRoutes(app);
mountProcessorRoutes(app);

app.onError((err, c) => {
  if (c.req.path.startsWith('/auth/')) {
    return c.json({ error: 'authentication_failed', message: 'Login could not be completed; start again at /auth/login' }, 400);
  }
  if (err instanceof HTTPException) return c.json({ error: 'unauthorized' }, err.status);
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

app.get('/', (c) => {
  // Browsers that land on the API root (after Auth0 logout, or login from another hostname)
  // are sent on to the frontend; API clients still get the service description.
  // When the frontend is hosted by this Worker (static assets), browsers get the app itself.
  if (c.req.header('accept')?.includes('text/html')) {
    const frontend = frontendOrigin(c.env);
    if (frontend && frontend !== new URL(c.req.url).origin) return c.redirect(c.env.FRONTEND_URL);
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({
    service: 'earth-replay-api',
    routes: [
      'GET /auth/login',
      'GET /auth/callback',
      'GET /auth/logout',
      'GET /api/auth/me',
      'POST /api/chats',
      'GET /api/chats',
      'GET /api/chats/:id',
      'GET /api/chats/:id/messages',
      'POST /api/chats/:id/messages',
      'GET /api/events',
      'GET /api/events/:id',
      'GET /api/events/:id/context',
      'GET /tiles/:event/:layer/:date/:z/:x/:y.png',
      'GET /api/discover/earthquakes',
      'POST /api/events/earthquake',
      'GET /api/nisar/search',
      'GET /api/geocode',
      'GET /api/datasets',
      'GET /api/datasets/context',
      'GET /api/datasets/:source',
      'POST /api/ingest',
      'GET /api/ingest/:id',
      'POST /api/ask',
      'GET /api/agents',
      'POST /api/chat',
      'GET /api/chat/:conversationId',
      'GET /api/events/:id/summary',
      'GET /api/events/:id/predict',
      'GET /api/events/:id/media',
      'GET /api/outlook',
      'WS /api/room/:code',
    ],
    credit: DATA_CREDIT,
  });
});

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

/** Stored supplementary NASA datasets for the event's area; refreshed when missing or older than six hours. */
app.get('/api/events/:id/context', async (c) => {
  const id = c.req.param('id');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid event id']);
  const event = await getEvent(c.env.DB, id);
  if (!event) return c.json({ error: 'not_found', message: `event ${id} not found` }, 404);
  return c.json({ ...describeContext(id, await ensureEventContext(c.env, event)), credit: DATA_CREDIT });
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

app.post('/api/ingest', async (c) => {
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
    const { minMagnitude, days, start, end, bbox } = parsed.value;
    const key = `discover:quakes:${minMagnitude}:${start ? `${start}..${end}` : days}:${bbox?.join(',') ?? 'world'}`;
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

app.post('/api/events/earthquake', async (c) => {
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

// ---------- supplementary NASA datasets ----------

app.get('/api/datasets', (c) => c.json({ sources: listDatasets(c.env) }));

app.get('/api/datasets/context', async (c) => {
  const parsed = parseDatasetQuery(new URL(c.req.url).searchParams);
  if (parsed.errors) return badRequest(c, parsed.errors);
  try { return c.json(await datasetContext(parsed.value, c.env)); }
  catch (err) { return eventErrorResponse(c, err); }
});

app.get('/api/datasets/:source', async (c) => {
  const parsed = parseDatasetQuery(new URL(c.req.url).searchParams);
  if (parsed.errors) return badRequest(c, parsed.errors);
  try { return c.json(await fetchDataset(c.req.param('source'), parsed.value, c.env)); }
  catch (err) { return eventErrorResponse(c, err); }
});

// ---------- AI ----------

app.post('/api/ask', limitChatBody, async (c) => {
  const parsed = validateAskRequest(await readJson(c));
  if (parsed.errors) return badRequest(c, parsed.errors);
  const { eventId, question, chatId } = parsed.value;
  if (!SAFE_ID_RE.test(eventId)) return badRequest(c, ['invalid eventId']);
  const owner = c.get('auth0User').sub;
  if (chatId) {
    const chat = await getChat(c.env.DB, owner, chatId);
    if (!chat) return c.json({ error: 'not_found', message: 'Chat not found' }, 404);
    if (chat.eventId !== eventId) return badRequest(c, ['eventId must match the chat event']);
  }
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return c.json({ error: 'not_found', message: `event ${eventId} not found` }, 404);
  try {
    if (chatId) {
      const [history, scenes, regionalContext] = await Promise.all([
        chatHistory(c.env.DB, owner, chatId), listScenesForEvent(c.env.DB, eventId), eventContextForPrompt(c.env, event),
      ]);
      const result = await answerQuestion(c.env, { event, scenes, question, history, privateConversation: true, regionalContext });
      const messages = await saveChatMessages(c.env.DB, owner, chatId, [
        { role: 'user', content: question },
        { role: 'assistant', content: result.answer, metadata: result },
      ]);
      if (!messages || messages.length !== 2) return c.json({ error: 'not_found', message: 'Chat not found' }, 404);
      return c.json({ ...result, chatId, messageIds: { user: messages[0].id, assistant: messages[1].id } });
    }
    const key = cacheKeys.answer(eventId, await hashQuestion(question));
    const result = await cached(c.env.CACHE, key, ANSWER_CACHE_TTL, async () => {
      const [scenes, regionalContext] = await Promise.all([listScenesForEvent(c.env.DB, eventId), eventContextForPrompt(c.env, event)]);
      return answerQuestion(c.env, { event, scenes, question, regionalContext });
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

/** Stored supplementary datasets in prompt form; null (never an error) when none are available. */
const eventContextForPrompt = async (env, event) => promptContext(await ensureEventContext(env, event));

const aiUnavailable = (c, what, err) => {
  console.error(`${what} failed`, err.message);
  return c.json({ error: 'ai_unavailable', message: 'The AI service is temporarily unavailable' }, 502);
};

app.get('/api/agents', (c) => c.json({ agents: describeAgents(c.env) }));

app.post('/api/chat', async (c) => {
  const parsed = validateChatRequest(await readJson(c));
  if (parsed.errors) return badRequest(c, parsed.errors);
  const { eventId, message, conversationId, agent } = parsed.value;
  if (!SAFE_ID_RE.test(eventId)) return badRequest(c, ['invalid eventId']);
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return c.json({ error: 'not_found', message: `event ${eventId} not found` }, 404);
  try {
    const [scenes, regionalContext] = await Promise.all([listScenesForEvent(c.env.DB, eventId), eventContextForPrompt(c.env, event)]);
    return c.json(await runChat(c.env, { event, scenes, message, conversationId, requestedAgent: agent, regionalContext }));
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof AIError) return aiUnavailable(c, 'chat', err);
    throw err;
  }
});

app.get('/api/chat/:conversationId', async (c) => {
  const id = c.req.param('conversationId');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid conversation id']);
  const thread = await getThread(c.env, id);
  if (!thread) return c.json({ error: 'not_found', message: `conversation ${id} not found` }, 404);
  return c.json(thread);
});

app.get('/api/events/:id/summary', async (c) => {
  const id = c.req.param('id');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid event id']);
  const event = await getEvent(c.env.DB, id);
  if (!event) return c.json({ error: 'not_found', message: `event ${id} not found` }, 404);
  try {
    const [scenes, layers, captions, regionalContext] = await Promise.all([
      listScenesForEvent(c.env.DB, id),
      listLayersForEvent(c.env.DB, id),
      listCaptionsForEvent(c.env.DB, id),
      eventContextForPrompt(c.env, event),
    ]);
    const result = await cached(c.env.CACHE, summaryCacheKey(event, scenes, captions, regionalContext), SUMMARY_CACHE_TTL, () =>
      summarizeEvent(c.env, { event, scenes, captions, layers, regionalContext }),
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof AIError) return aiUnavailable(c, 'summary', err);
    throw err;
  }
});

app.get('/api/events/:id/predict', async (c) => {
  const id = c.req.param('id');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid event id']);
  const horizon = parseHorizon(c.req.query('horizonDays'));
  if (horizon.error) return badRequest(c, [horizon.error]);
  const event = await getEvent(c.env.DB, id);
  if (!event) return c.json({ error: 'not_found', message: `event ${id} not found` }, 404);
  try {
    const [scenes, sceneStats, captions] = await Promise.all([
      listScenesForEvent(c.env.DB, id),
      listSceneStats(c.env.DB, id),
      listCaptionsForEvent(c.env.DB, id, 5),
    ]);
    const key = `predict:${id}:${horizon.value}:${scenes.length}:${sceneStats.length}`;
    const result = await cached(c.env.CACHE, key, SUMMARY_CACHE_TTL, () =>
      forecastEvent(c.env, { event, scenes, sceneStats, captions, horizonDays: horizon.value }),
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof AIError) return aiUnavailable(c, 'predict', err);
    throw err;
  }
});

// ---------- outlook and pictures ----------

const OUTLOOK_CACHE_TTL = 3600;
const MEDIA_CACHE_TTL = 6 * 3600;

// Modeled seismic outlook for a region, with AI-worded scenarios. Never an observation.
app.get('/api/outlook', async (c) => {
  const parsed = parseOutlookQuery(new URL(c.req.url).searchParams);
  if (parsed.errors) return badRequest(c, parsed.errors);
  const { bbox, horizonDays } = parsed.value;
  try {
    const result = await cached(c.env.CACHE, `outlook:${bbox.join(',')}:${horizonDays}`, OUTLOOK_CACHE_TTL, () =>
      seismicOutlook(c.env, { bbox, horizonDays }),
    );
    return c.json(result);
  } catch (err) {
    return eventErrorResponse(c, err);
  }
});

// USGS impact maps, related NASA photographs and photo links for one event.
app.get('/api/events/:id/media', async (c) => {
  const id = c.req.param('id');
  if (!SAFE_ID_RE.test(id)) return badRequest(c, ['invalid event id']);
  const event = await getEvent(c.env.DB, id);
  if (!event) return c.json({ error: 'not_found', message: `event ${id} not found` }, 404);
  return c.json(await cached(c.env.CACHE, `media:${id}`, MEDIA_CACHE_TTL, () => eventMedia(event)));
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
