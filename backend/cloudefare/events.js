// Event discovery and external data fetching.
//   - USGS earthquakes (real, no key)  -> candidate events with a suggested NISAR AOI + date window
//   - NISAR scene preview (ASF DAAC)   -> what coverage exists before committing to an ingest
//   - Google Geocoding API (optional key GOOGLE_MAPS_API_KEY) -> place name to AOI
// Every fetcher takes `deps.fetch` so tests never touch the network.

import { AsfError, searchNisar } from './asf.js';
import { getEvent, insertEvent } from './dataManger.js';
import { NISAR_LAUNCH_DATE, MAX_AOI_DEGREES, parseAoi, parseIngestRequest, startIngest } from './workFlowManger.js';

export const USGS_QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
export const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
export const SUPPLEMENTARY_CREDIT = Object.freeze({
  usgs: 'Earthquake catalog: U.S. Geological Survey (USGS) ANSS ComCat.',
  googleMaps: 'Geocoding: Google Maps Platform.',
});

const FETCH_TIMEOUT_MS = 10_000;
const USGS_ID_RE = /^[a-z]{2}[a-z0-9]{6,12}$/i;
const DAY_MS = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Failure talking to, or configuring, an upstream. `retryable` drives queue retry vs ack. */
export class EventError extends Error {
  constructor(message, { status, retryable = false, code = 'event_error' } = {}) {
    super(message);
    this.name = 'EventError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

// ---------- shared fetch ----------

/** GET JSON with a timeout. Returns null for 404; throws EventError otherwise. */
export async function fetchJson(url, { fetchImpl = fetch, headers = {}, label = 'upstream' } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new EventError(`${label} network error: ${err.message}`, { retryable: true, code: 'upstream_unreachable' });
  }
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) {
    throw new EventError(`${label} failed with HTTP ${res.status}`, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
      code: 'upstream_error',
    });
  }
  try {
    return await res.json();
  } catch {
    throw new EventError(`${label} returned invalid JSON`, { retryable: true, code: 'upstream_error' });
  }
}

// ---------- AOI helpers ----------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Half-width in degrees of a box around an earthquake epicenter. Heuristic: Wells & Coppersmith (1994)
 * surface rupture length log10(L km) = -2.44 + 0.59 M, plus 0.2 deg margin, kept within [0.25, 2.4].
 * It is a starting AOI, not a rupture model.
 */
export function halfWidthForMagnitude(mag) {
  const lengthKm = 10 ** (-2.44 + 0.59 * mag);
  return clamp(lengthKm / 111 + 0.2, 0.25, MAX_AOI_DEGREES / 2 - 0.1);
}

/** [w,s,e,n] around a point, clamped to valid lon/lat. */
export function bboxAround(lon, lat, halfDeg) {
  return [clamp(lon - halfDeg, -180, 180), clamp(lat - halfDeg, -90, 90), clamp(lon + halfDeg, -180, 180), clamp(lat + halfDeg, -90, 90)].map(
    (n) => Number(n.toFixed(4)),
  );
}

/** Shrink a [w,s,e,n] box around its center so no side exceeds MAX_AOI_DEGREES. */
export function limitBbox([w, s, e, n]) {
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hx = Math.min((e - w) / 2, MAX_AOI_DEGREES / 2);
  const hy = Math.min((n - s) / 2, MAX_AOI_DEGREES / 2);
  return [cx - hx, cy - hy, cx + hx, cy + hy].map((x) => Number(x.toFixed(4)));
}

/** Parse "w,s,e,n" from a query string. */
export function parseBboxParam(value) {
  const parts = String(value ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { error: 'bbox must be "west,south,east,north"' };
  const aoi = parseAoi(parts);
  return aoi.error ? { error: aoi.error } : { bbox: aoi.bbox };
}

// ---------- USGS earthquakes ----------

/** Normalize a USGS GeoJSON feature. Returns null for anything that is not a located earthquake. */
export function normalizeQuake(feature) {
  const p = feature?.properties;
  const c = feature?.geometry?.coordinates;
  if (!feature?.id || !p || p.type !== 'earthquake' || typeof p.mag !== 'number' || typeof p.time !== 'number') return null;
  if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return {
    source: 'usgs',
    sourceId: feature.id,
    type: 'earthquake',
    title: p.title ?? `M ${p.mag} - ${p.place ?? 'unknown location'}`,
    place: p.place ?? null,
    magnitude: p.mag,
    time: new Date(p.time).toISOString(),
    longitude: c[0],
    latitude: c[1],
    depthKm: Number.isFinite(c[2]) ? c[2] : null,
    tsunami: p.tsunami === 1,
    alert: p.alert ?? null,
    url: p.url ?? null,
  };
}

export function parseDiscoverQuery(params) {
  const errors = [];
  const num = (key, dflt, lo, hi) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < lo || n > hi) errors.push(`${key} must be a number between ${lo} and ${hi}`);
    return n;
  };
  const minMagnitude = num('minMagnitude', 6, 4.5, 9.9);
  const days = num('days', 30, 1, 365);
  let bbox = null;
  if (params.get('bbox')) {
    const b = parseBboxParam(params.get('bbox'));
    if (b.error) errors.push(b.error);
    else bbox = b.bbox;
  }
  return errors.length ? { errors } : { value: { minMagnitude, days, bbox } };
}

export function buildUsgsUrl({ baseUrl = USGS_QUERY_URL, minMagnitude, days, bbox, now = Date.now(), limit = 20 }) {
  const url = new URL(baseUrl);
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('starttime', new Date(now - days * DAY_MS).toISOString().slice(0, 19));
  url.searchParams.set('endtime', new Date(now).toISOString().slice(0, 19));
  url.searchParams.set('minmagnitude', String(minMagnitude));
  url.searchParams.set('orderby', 'time');
  url.searchParams.set('limit', String(limit));
  if (bbox) {
    const [w, s, e, n] = bbox;
    url.searchParams.set('minlongitude', String(w));
    url.searchParams.set('minlatitude', String(s));
    url.searchParams.set('maxlongitude', String(e));
    url.searchParams.set('maxlatitude', String(n));
  }
  return url.toString();
}

/** Recent earthquakes from USGS, newest first. Quakes before NISAR launch are dropped (no possible data). */
export async function fetchEarthquakes({ minMagnitude = 6, days = 30, bbox = null, now = Date.now() } = {}, deps = {}) {
  const url = buildUsgsUrl({ minMagnitude, days, bbox, now });
  const body = await fetchJson(url, { fetchImpl: deps.fetch, label: 'USGS' });
  if (!body || !Array.isArray(body.features)) throw new EventError('USGS response missing features array', { retryable: true, code: 'upstream_error' });
  return body.features.map(normalizeQuake).filter((q) => q && q.time.slice(0, 10) >= NISAR_LAUNCH_DATE);
}

/** One earthquake by USGS id, or null if unknown. */
export async function fetchEarthquakeById(usgsId, deps = {}) {
  if (!USGS_ID_RE.test(usgsId ?? '')) throw new EventError('usgsId is not a valid USGS event id', { code: 'invalid_request' });
  const url = new URL(USGS_QUERY_URL);
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('eventid', usgsId);
  const body = await fetchJson(url.toString(), { fetchImpl: deps.fetch, label: 'USGS' });
  if (!body) return null;
  return normalizeQuake(body.type === 'FeatureCollection' ? body.features?.[0] : body);
}

/**
 * Suggested NISAR ingest for a quake: GUNW needs a pre-event reference, so the window starts 36 days (3 repeat cycles)
 * before the quake and runs 60 days after it, clipped to NISAR launch and today.
 */
export function quakeToIngestRequest(quake, now = Date.now()) {
  const t = Date.parse(quake.time);
  const today = isoDate(now);
  const start = isoDate(Math.max(t - 36 * DAY_MS, Date.parse(NISAR_LAUNCH_DATE)));
  const end = isoDate(Math.min(t + 60 * DAY_MS, now));
  const bbox = bboxAround(quake.longitude, quake.latitude, halfWidthForMagnitude(quake.magnitude));
  return {
    eventId: `usgs-${quake.sourceId.toLowerCase()}`,
    name: quake.title,
    type: 'earthquake',
    products: ['GUNW'],
    description: `${quake.title} (${quake.time}). AOI is a magnitude-scaled box around the USGS epicenter. ${SUPPLEMENTARY_CREDIT.usgs}`,
    aoi: bbox,
    dateRange: { start: start > today ? today : start, end },
  };
}

/** Register a quake as a catalog event (idempotent) and start an ingest. Returns { eventId, created, ingest }. */
export async function registerEarthquake(env, quake, { now = Date.now() } = {}) {
  const request = quakeToIngestRequest(quake, now);
  const parsed = parseIngestRequest(request, { today: isoDate(now) });
  if (parsed.errors) throw new EventError(`earthquake cannot be ingested: ${parsed.errors.join('; ')}`, { code: 'invalid_request' });
  const req = parsed.value;

  let event = await getEvent(env.DB, req.eventId);
  const created = !event;
  if (!event) {
    event = await insertEvent(env.DB, {
      id: req.eventId,
      name: req.name,
      type: req.type,
      description: req.description,
      aoiWkt: req.aoi.wkt,
      bbox: req.aoi.bbox,
      products: req.products,
      startDate: null,
      endDate: null,
      watch: false,
    });
  }
  const ingest = await startIngest(env, { event, start: req.dateRange.start, end: req.dateRange.end });
  return { eventId: event.id, created, ingest: { ...ingest, statusUrl: `/api/ingest/${ingest.id}` } };
}

// ---------- NISAR preview ----------

/**
 * Preview NISAR scenes for an area and period without cataloging anything.
 * `event` accepts { aoi | bbox, dateRange | {start,end}, products? }.
 */
export async function nisarData(event, env, deps = {}) {
  const body = {
    aoi: event?.aoi ?? event?.bbox,
    dateRange: event?.dateRange ?? { start: event?.start, end: event?.end },
    products: event?.products,
  };
  const parsed = parseIngestRequest(body);
  if (parsed.errors) throw new EventError(parsed.errors.join('; '), { code: 'invalid_request' });
  const { aoi, dateRange, products } = parsed.value;
  const limit = Number(env.MAX_SCENES_PER_INGEST) || 25;
  let scenes;
  try {
    scenes = await searchNisar(env, { wkt: aoi.wkt, start: dateRange.start, end: dateRange.end, products, maxResults: limit }, deps.fetch);
  } catch (err) {
    if (err instanceof AsfError) throw new EventError(err.message, { status: err.status, retryable: err.retryable, code: 'upstream_error' });
    throw err;
  }
  const byProduct = {};
  for (const s of scenes) byProduct[s.product] = (byProduct[s.product] ?? 0) + 1;
  return {
    query: { bbox: aoi.bbox, dateRange, products },
    count: scenes.length,
    byProduct,
    dates: [...new Set(scenes.map((s) => s.acquiredAt.slice(0, 10)))],
    polarizations: [...new Set(scenes.flatMap((s) => s.polarizations))].sort(),
    scenes,
    truncated: scenes.length >= limit,
  };
}

export const handleNisarData = async (event, env, deps) => nisarData(event, env, deps);

/** Run many previews; one bad query does not stop the rest. */
export const handleNisarDataBatch = async (events, env, deps) =>
  Promise.all(
    events.map((e) =>
      handleNisarData(e, env, deps).then(
        (result) => ({ ok: true, result }),
        (err) => ({ ok: false, error: err.message, retryable: err.retryable ?? false }),
      ),
    ),
  );

// ---------- Google geocoding ----------

/** Pure: turn a Google Geocoding response into { formattedAddress, location, bbox, aoi } or null. */
export function parseGeocodeResponse(body) {
  switch (body?.status) {
    case 'OK':
      break;
    case 'ZERO_RESULTS':
      return null;
    case 'OVER_QUERY_LIMIT':
    case 'UNKNOWN_ERROR':
      throw new EventError(`Google Geocoding ${body.status}`, { retryable: true, code: 'upstream_error' });
    default:
      // REQUEST_DENIED / INVALID_REQUEST: our key or request is wrong; retrying will not help.
      throw new EventError(`Google Geocoding ${body?.status ?? 'invalid response'}${body?.error_message ? `: ${body.error_message}` : ''}`, {
        code: 'upstream_error',
      });
  }
  const r = body.results?.[0];
  const loc = r?.geometry?.location;
  if (!r || !Number.isFinite(loc?.lat) || !Number.isFinite(loc?.lng)) return null;
  const vp = r.geometry.viewport ?? r.geometry.bounds;
  let bbox = vp ? [vp.southwest.lng, vp.southwest.lat, vp.northeast.lng, vp.northeast.lat] : bboxAround(loc.lng, loc.lat, 0.25);
  // A viewport crossing the antimeridian has west > east; fall back to a box around the point.
  if (bbox[0] >= bbox[2]) bbox = bboxAround(loc.lng, loc.lat, 0.25);
  return {
    formattedAddress: r.formatted_address ?? null,
    location: { lat: loc.lat, lng: loc.lng },
    bbox,
    aoi: limitBbox(bbox),
  };
}

/** Geocode a place name or address. Needs the GOOGLE_MAPS_API_KEY secret. Returns null when nothing matches. */
export async function googleMapApi(event, env, deps = {}) {
  const query = typeof event?.query === 'string' ? event.query.trim() : '';
  if (query.length < 2 || query.length > 200) throw new EventError('query must be 2-200 characters', { code: 'invalid_request' });
  if (!env.GOOGLE_MAPS_API_KEY) throw new EventError('Geocoding is not configured (GOOGLE_MAPS_API_KEY missing)', { code: 'not_configured' });
  const url = new URL(env.GOOGLE_GEOCODE_URL || GOOGLE_GEOCODE_URL);
  url.searchParams.set('address', query);
  url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);
  // The key travels in the URL (Google's API requires it), so never include the URL in errors or logs.
  const body = await fetchJson(url.toString(), { fetchImpl: deps.fetch, label: 'Google Geocoding' });
  if (!body) return null;
  const result = parseGeocodeResponse(body);
  return result && { query, ...result, credit: SUPPLEMENTARY_CREDIT.googleMaps };
}

export const handleGoogleMapApi = async (event, env, deps) => googleMapApi(event, env, deps);

// ---------- generic event messages ----------

/**
 * Handle one event message. Supported shapes:
 *   { source: 'usgs', usgsId }                      register a USGS earthquake and start an ingest
 *   { type: 'nisar', aoi|bbox, dateRange, ... }     preview NISAR coverage
 *   { type: 'geocode', query }                      geocode a place
 */
export async function handleEvent(event, env, deps = {}) {
  if (event?.source === 'usgs') {
    const quake = await fetchEarthquakeById(event.usgsId, deps);
    if (!quake) throw new EventError(`USGS event ${event.usgsId} not found`, { code: 'not_found' });
    return registerEarthquake(env, quake, { now: deps.now });
  }
  if (event?.type === 'nisar') return nisarData(event, env, deps);
  if (event?.type === 'geocode') return googleMapApi(event, env, deps);
  throw new EventError(`unsupported event: ${JSON.stringify(event)?.slice(0, 100)}`, { code: 'invalid_request' });
}

/** Handle many events; failures are reported per event rather than aborting the batch. */
export async function handleEventBatch(events, env, deps) {
  const results = [];
  for (const event of events) {
    try {
      results.push({ ok: true, result: await handleEvent(event, env, deps) });
    } catch (err) {
      results.push({ ok: false, error: err.message, retryable: err.retryable ?? false });
    }
  }
  return results;
}

/**
 * Queue-consumer style handler: acks done or permanently failed messages, retries transient ones with backoff.
 * Not bound to a queue in wrangler.jsonc yet; export it from a queue handler to use it.
 */
export async function handleEventQueue(batch, env, deps) {
  for (const message of batch.messages) {
    try {
      await handleEvent(message.body, env, deps);
      message.ack();
    } catch (err) {
      if (err instanceof EventError && err.retryable) {
        message.retry({ delaySeconds: Math.min(300, 15 * 2 ** ((message.attempts ?? 1) - 1)) });
      } else {
        console.error('event message failed permanently:', err.message);
        message.ack();
      }
    }
  }
}
