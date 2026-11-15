// Regional context for an event: fetch the supplementary NASA datasets for the event's area,
// store them in D1 (event_context) and hand a compact copy to the AI prompts.
// Everything here is best-effort: a provider outage must never break an API response or an AI answer.

import { datasetContext, NASA_DATASETS } from './events.js';

const DAY_MS = 86_400_000;
export const CONTEXT_WINDOW_DAYS = 30;
export const FIRMS_WINDOW_DAYS = 5; // FIRMS accepts at most five inclusive days
export const CONTEXT_TTL_MS = 6 * 3_600_000;
const ATTEMPT_THROTTLE_SECONDS = 600; // after an attempt, do not query providers again for this event
const ITEM_LIMIT = 5;
const PROMPT_EXAMPLES = 3;
// GEOS-FP is a global forecast file listing with short retention; it adds prompt noise, not area context.
export const CONTEXT_SOURCES = Object.freeze(['gpm', 'smap', 'hls', 'terrain', 'grace']);

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Last 30 days of the event (or its own shorter span); events that have ended use their end date. */
export function contextWindow(event, now = Date.now()) {
  const today = isoDay(now);
  const eventEnd = event.endDate?.slice(0, 10);
  const end = eventEnd && eventEnd < today ? eventEnd : today;
  const floor = isoDay(Date.parse(end) - (CONTEXT_WINDOW_DAYS - 1) * DAY_MS);
  let start = event.startDate?.slice(0, 10) ?? floor;
  if (start < floor || start > end) start = floor;
  return { start, end };
}

function rowFromDb(r) {
  return {
    source: r.source,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    ok: r.ok === 1,
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error,
    fetchedAt: r.fetched_at,
  };
}

export async function getStoredContext(db, eventId) {
  const { results } = await db.prepare('SELECT * FROM event_context WHERE event_id = ? ORDER BY source').bind(eventId).all();
  return results.map(rowFromDb);
}

/** A good stored result is never replaced by a later failure; a failure only fills an empty slot or replaces an older failure. */
async function storeContext(db, eventId, entries, fetchedAt) {
  if (!entries.length) return;
  await db.batch(entries.map((e) => db.prepare(
    `INSERT INTO event_context (event_id, source, window_start, window_end, ok, result, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, source) DO UPDATE SET window_start = excluded.window_start, window_end = excluded.window_end,
       ok = excluded.ok, result = excluded.result, error = excluded.error, fetched_at = excluded.fetched_at
     WHERE excluded.ok = 1 OR event_context.ok = 0`,
  ).bind(eventId, e.source, e.windowStart, e.windowEnd, e.ok ? 1 : 0, e.ok ? JSON.stringify(e.result) : null, e.ok ? null : e.error, fetchedAt)));
}

function toEntries(context, window) {
  return Object.entries(context.results).map(([source, r]) => ({
    source, windowStart: window.start, windowEnd: window.end, ok: r.ok,
    result: r.ok ? r.result : null, error: r.ok ? null : `${r.error}: ${r.message}`.slice(0, 300),
  }));
}

/** Query the providers for the event's area and store the outcome. Returns the stored rows. */
export async function refreshEventContext(env, event, { now = Date.now(), deps = {} } = {}) {
  if (!event.bbox) return getStoredContext(env.DB, event.id);
  const window = contextWindow(event, now);
  const base = { bbox: event.bbox, limit: ITEM_LIMIT };
  const firmsFloor = isoDay(Date.parse(window.end) - (FIRMS_WINDOW_DAYS - 1) * DAY_MS);
  const firmsWindow = { start: window.start > firmsFloor ? window.start : firmsFloor, end: window.end };
  // FIRMS needs its own key and a five-day range, so without the key it is skipped rather than stored as a failure.
  const [main, fire] = await Promise.all([
    datasetContext({ ...base, ...window, sources: CONTEXT_SOURCES }, env, deps),
    env.FIRMS_MAP_KEY ? datasetContext({ ...base, ...firmsWindow, sources: ['firms'] }, env, deps) : null,
  ]);
  await storeContext(env.DB, event.id, [...toEntries(main, window), ...(fire ? toEntries(fire, firmsWindow) : [])], new Date(now).toISOString());
  return getStoredContext(env.DB, event.id);
}

/**
 * Stored context, refreshed first when missing or older than six hours. Never throws, and provider
 * attempts per event are throttled so a failing provider is not hit on every request.
 * `EVENT_CONTEXT=off` disables provider queries and serves only what is already stored.
 */
export async function ensureEventContext(env, event, { now = Date.now(), deps = {} } = {}) {
  let rows = [];
  try {
    rows = await getStoredContext(env.DB, event.id);
    const newest = Math.max(0, ...rows.map((r) => Date.parse(r.fetchedAt)));
    if (env.EVENT_CONTEXT !== 'off' && event.bbox && (!rows.length || now - newest > CONTEXT_TTL_MS)) {
      const key = `ctx:attempt:${event.id}`;
      if (!(await env.CACHE.get(key))) {
        await env.CACHE.put(key, '1', { expirationTtl: ATTEMPT_THROTTLE_SECONDS });
        rows = await refreshEventContext(env, event, { now, deps });
      }
    }
  } catch (err) {
    console.error('event context unavailable', err?.message);
  }
  return rows;
}

/** API view of the stored rows. */
export function describeContext(eventId, rows) {
  return {
    eventId,
    fetchedAt: rows.map((r) => r.fetchedAt).sort().at(-1) ?? null,
    sources: rows.map((r) => ({
      source: r.source,
      name: NASA_DATASETS[r.source]?.name ?? r.source,
      kind: NASA_DATASETS[r.source]?.kind ?? null,
      credit: NASA_DATASETS[r.source]?.credit ?? null,
      notes: NASA_DATASETS[r.source]?.notes ?? null,
      ok: r.ok,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      fetchedAt: r.fetchedAt,
      ...(r.ok ? {
        total: r.result.total ?? r.result.count ?? 0,
        count: r.result.count ?? 0,
        measurementsRetrieved: Boolean(r.result.measurementsRetrieved),
        items: r.result.items ?? [],
      } : { error: r.error }),
    })),
  };
}

const clip = (text, n = 90) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n - 1)}…` : text);

function exampleOf(source, item) {
  return source === 'firms'
    ? { acquiredAt: item.acquiredAt, confidence: item.confidence, frpMW: item.frpMW }
    : { title: clip(item.title), start: item.start, end: item.end };
}

/** Compact copy for AI prompts: counts and a few examples per source, no download links. Null when nothing usable. */
export function promptContext(rows) {
  const good = rows.filter((r) => r.ok && r.result);
  if (!good.length) return null;
  return {
    note: 'Supplementary NASA datasets for this event area. Most entries are catalog records showing which data exists, not measurements of the ground; ' +
      'only FIRMS entries are actual thermal detections. None of this is NISAR data.',
    fetchedAt: good.map((r) => r.fetchedAt).sort().at(-1),
    sources: Object.fromEntries(good.map((r) => [r.source, {
      name: NASA_DATASETS[r.source]?.name ?? r.source,
      window: [r.windowStart, r.windowEnd],
      [r.source === 'firms' ? 'detections' : 'matchingRecords']: r.result.total ?? r.result.count ?? 0,
      examples: (r.result.items ?? []).slice(0, PROMPT_EXAMPLES).map((item) => exampleOf(r.source, item)),
      caveat: NASA_DATASETS[r.source]?.notes ?? null,
    }])),
    unavailable: rows.filter((r) => !r.ok).map((r) => r.source),
  };
}
