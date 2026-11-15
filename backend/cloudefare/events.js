// Event discovery and external data fetching.
//   - USGS earthquakes (real, no key)  -> candidate events with a suggested NISAR AOI + date window
//   - NISAR scene preview (ASF DAAC)   -> what coverage exists before committing to an ingest
//   - Google Geocoding API (optional key GOOGLE_MAPS_API_KEY) -> place name to AOI
                                                                                                                                                                                                                                                  //   - NASA supplementary datasets: CMR granules, GEOS forecast files, FIRMS detections
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
  const raw = String(value ?? '').split(',');
  if (raw.some((s) => !s.trim())) return { error: 'bbox must be "west,south,east,north"' };
  const parts = raw.map(Number);
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
  // An explicit period (YYYY-MM-DD, inclusive) replaces "the last `days` days".
  let datesValid = true;
  const date = (key) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
      errors.push(`${key} must be a YYYY-MM-DD date`);
      datesValid = false;
    }
    return raw;
  };
  const start = date('start');
  const end = date('end');
  if ((start === null) !== (end === null)) errors.push('start and end must be given together');
  else if (start && end && datesValid) {
    if (start > end) errors.push('start must be on or before end');
    else if ((Date.parse(end) - Date.parse(start)) / DAY_MS > 366) errors.push('start and end must span at most 366 days');
  }
  let bbox = null;
  if (params.get('bbox')) {
    const b = parseBboxParam(params.get('bbox'));
    if (b.error) errors.push(b.error);
    else bbox = b.bbox;
  }
  if (errors.length) return { errors };
  return { value: { minMagnitude, days, bbox, ...(start && end ? { start, end } : {}) } };
}

export function buildUsgsUrl({ baseUrl = USGS_QUERY_URL, minMagnitude, days, start, end, bbox, now = Date.now(), limit = 20 }) {
  const url = new URL(baseUrl);
  url.searchParams.set('format', 'geojson');
  // A chosen period covers its whole last day, but never reaches past `now`.
  const from = start && end ? Date.parse(start) : now - days * DAY_MS;
  const to = start && end ? Math.min(Date.parse(end) + DAY_MS - 1000, now) : now;
  url.searchParams.set('starttime', new Date(from).toISOString().slice(0, 19));
  url.searchParams.set('endtime', new Date(to).toISOString().slice(0, 19));
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
export async function fetchEarthquakes({ minMagnitude = 6, days = 30, start, end, bbox = null, now = Date.now() } = {}, deps = {}) {
  const url = buildUsgsUrl({ minMagnitude, days, start, end, bbox, now });
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
  if (event?.type === 'dataset') return fetchDataset(event.source, event, env, deps);
  if (event?.type === 'dataset_context') return datasetContext(event, env, deps);
  if (event?.source === 'usgs') {
    const quake = await fetchEarthquakeById(event.usgsId, deps);
    if (!quake) throw new EventError(`USGS event ${event.usgsId} not found`, { code: 'not_found' });
    return registerEarthquake(env, quake, { now: deps.now });
  }
  if (event?.type === 'nisar') return nisarData(event, env, deps);
  if (event?.type === 'geocode') return googleMapApi(event, env, deps);
  throw new EventError(`unsupported event: ${JSON.stringify(event)?.slice(0, 100)}`, { code: 'invalid_request' });
}

// ---------- NASA supplementary sources ----------

const CMR_GRANULES_URL = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const GEOS_FORECAST_URL = 'https://portal.nccs.nasa.gov/datashare/gmao/geos-fp/forecast/';
const FIRMS_AREA_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/';
// Short names verified against NASA CMR collections on 2026-11-14.
export const NASA_DATASETS = Object.freeze({
  firms: { name: 'FIRMS / VIIRS NOAA-20 active fires', kind: 'fire_detections', credit: 'NASA LANCE FIRMS; NOAA-20 VIIRS.', requiredSecret: 'FIRMS_MAP_KEY', notes: 'Thermal detections, not confirmed wildfire perimeters or ignition forecasts. Query at most five inclusive days.' },
  gpm: { name: 'GPM IMERG Early daily precipitation', kind: 'granule_catalog', credit: 'NASA GPM / GES DISC.', shortNames: ['GPM_3IMERGDE'], notes: 'Daily precipitation estimates, not future rainfall forecasts.' },
  smap: { name: 'SMAP enhanced daily soil moisture', kind: 'granule_catalog', credit: 'NASA SMAP / NSIDC DAAC.', shortNames: ['SPL3SMP_E'], notes: 'Soil moisture; apply retrieval flags. Not direct vegetation fuel moisture.' },
  hls: { name: 'Harmonized Landsat Sentinel-2', kind: 'granule_catalog', credit: 'NASA HLS / USGS Landsat / ESA Sentinel-2 / LP DAAC.', shortNames: ['HLSL30', 'HLSS30'], notes: 'Optical reflectance; clouds and shadows require masking.' },
  geos: { name: 'GEOS-FP surface meteorology forecasts', kind: 'forecast_file_catalog', credit: 'NASA GMAO / NCCS GEOS-FP.', notes: 'Global tavg1_2d_slv_Nx NetCDF files; initialization is runDate (default start) and cycle (default 00). Archive retention is limited. Variable extraction needs a processor.' },
  terrain: { name: 'NASADEM elevation', kind: 'granule_catalog', credit: 'NASA / JPL / USGS / LP DAAC.', shortNames: ['NASADEM_HGT'], static: true, notes: 'Static terrain; requested dates do not filter this source. Coverage is not all latitudes.' },
  grace: { name: 'GRACE / GRACE-FO JPL mascon water storage', kind: 'granule_catalog', credit: 'NASA / JPL / PO.DAAC GRACE and GRACE-FO.', shortNames: ['TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4'], notes: 'Regional total water-storage anomalies, not parcel-scale groundwater. A granule can contain a multi-month time series; slice by date in a processor.' },
});

export function listDatasets(env = {}) {
  return Object.entries(NASA_DATASETS).map(([id, source]) => ({
    id, ...source, configured: !source.requiredSecret || Boolean(env[source.requiredSecret]),
    measurementsRetrieved: false,
  }));
}

const validDatasetDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;

/** Common regional query, independent of NISAR launch date. */
export function parseDatasetQuery(params) {
  const errors = [];
  const region = parseBboxParam(params.get('bbox'));
  if (region.error) errors.push(region.error);
  const start = params.get('start');
  const end = params.get('end');
  if (!validDatasetDate(start) || !validDatasetDate(end)) errors.push('start and end must be YYYY-MM-DD dates');
  else if (start > end || Date.parse(end) - Date.parse(start) > 366 * DAY_MS) errors.push('date range must be ordered and span at most 366 days');
  const limit = params.has('limit') ? Number(params.get('limit')) : 10;
  const page = params.has('page') ? Number(params.get('page')) : 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) errors.push('limit must be an integer from 1 to 50');
  if (!Number.isInteger(page) || page < 1 || page > 10000) errors.push('page must be an integer from 1 to 10000');
  const sources = params.has('sources') ? [...new Set(params.get('sources').split(','))] : Object.keys(NASA_DATASETS);
  if (!sources.length || sources.some((s) => !Object.hasOwn(NASA_DATASETS, s))) errors.push('sources must contain supported dataset IDs');
  const runDate = params.get('runDate') ?? start;
  if (!validDatasetDate(runDate)) errors.push('runDate must be a YYYY-MM-DD date');
  const cycle = params.get('cycle') ?? '00';
  if (!['00', '06', '12', '18'].includes(cycle)) errors.push('cycle must be 00, 06, 12 or 18');
  return errors.length ? { errors } : { value: { bbox: region.bbox, start, end, limit, page, sources, runDate, cycle } };
}

function validateDatasetInput(query) {
  const params = new URLSearchParams();
  for (const key of ['bbox', 'start', 'end', 'limit', 'page', 'sources', 'runDate', 'cycle']) {
    if (query?.[key] !== undefined) params.set(key, Array.isArray(query[key]) ? query[key].join(',') : String(query[key]));
  }
  const parsed = parseDatasetQuery(params);
  if (parsed.errors) throw new EventError(parsed.errors.join('; '), { code: 'invalid_request' });
  return parsed.value;
}

/** Bound both transferred bytes and duration. Never expose provider error text or credential-bearing URLs. */
async function datasetResponse(url, label, deps, maxBytes = 2_000_000) {
  let res;
  let reader;
  try {
    res = await (deps.fetch ?? fetch)(url, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new EventError(`${label} returned HTTP ${res.status}`, {
        status: res.status, code: res.status === 404 ? 'not_found' : 'upstream_error', retryable: res.status === 429 || res.status >= 500,
      });
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel();
      throw new EventError(`${label} response exceeds size limit`, { code: 'upstream_error' });
    }
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new EventError(`${label} response exceeds size limit`, { code: 'upstream_error' });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
    return { text, headers: res.headers };
  } catch (err) {
    if (err instanceof EventError) throw err;
    throw new EventError(`${label} request failed`, { code: 'upstream_unreachable', retryable: true });
  } finally {
    reader?.releaseLock();
  }
}

async function fetchCmrDataset(source, q, deps) {
  const spec = NASA_DATASETS[source];
  const url = new URL(CMR_GRANULES_URL);
  for (const name of spec.shortNames) url.searchParams.append('short_name[]', name);
  url.searchParams.set('bounding_box', q.bbox.join(','));
  if (!spec.static) url.searchParams.set('temporal', `${q.start}T00:00:00Z,${q.end}T23:59:59Z`);
  url.searchParams.set('page_size', String(q.limit));
  url.searchParams.set('page_num', String(q.page));
  url.searchParams.append('sort_key[]', 'start_date');
  url.searchParams.append('sort_key[]', 'producer_granule_id');
  const { text, headers } = await datasetResponse(url.toString(), 'NASA CMR', deps);
  let body;
  try { body = JSON.parse(text); } catch { throw new EventError('NASA CMR returned invalid JSON', { code: 'upstream_error', retryable: true }); }
  if (!Array.isArray(body?.feed?.entry)) throw new EventError('NASA CMR response missing granules', { code: 'upstream_error', retryable: true });
  const items = body.feed.entry.map((g) => ({
    id: g.id, title: g.title, start: g.time_start ?? null, end: g.time_end ?? null,
    collectionId: g.collection_concept_id ?? null, sizeMB: g.granule_size ?? null,
    boxes: g.boxes ?? [], polygons: g.polygons ?? [],
    downloads: (g.links ?? []).filter((l) => !l.inherited && l.rel?.endsWith('/data#') && /^https:\/\//.test(l.href)).map((l) => l.href),
  }));
  const rawTotal = headers.get('CMR-Hits');
  const total = rawTotal !== null && /^\d+$/.test(rawTotal) ? Number(rawTotal) : null;
  const more = total === null ? items.length === q.limit : q.page * q.limit < total;
  return {
    items, total, nextPage: more ? q.page + 1 : null, truncated: more,
    temporalFilterApplied: !spec.static, spatialSubsetApplied: false,
    access: 'Catalog references only. File downloads generally require Earthdata Login; raster extraction needs the external processor.',
  };
}

// FIRMS CSV contains quoted fields; do not split a CSV row on commas alone.
function parseFirmsCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new EventError('FIRMS returned malformed CSV', { code: 'upstream_error' });
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift() ?? [];
  if (!['latitude', 'longitude', 'acq_date', 'acq_time'].every((k) => header.includes(k)))
    throw new EventError('FIRMS returned an invalid detection table; check the map key and product availability', { code: 'upstream_error' });
  const numeric = (v) => v?.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
  return rows.flatMap((r) => {
    const v = Object.fromEntries(header.map((k, i) => [k, r[i] ?? '']));
    const lat = numeric(v.latitude), lon = numeric(v.longitude);
    const time = v.acq_time.padStart(4, '0');
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !validDatasetDate(v.acq_date) || !/^([01]\d|2[0-3])[0-5]\d$/.test(time)) return [];
    return [{ latitude: lat, longitude: lon, acquiredAt: `${v.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`,
      confidence: v.confidence || null, frpMW: numeric(v.frp), satellite: v.satellite || null,
      daynight: v.daynight || null, instrument: v.instrument || 'VIIRS' }];
  });
}

async function fetchFirmsDataset(q, env, deps) {
  if (!env.FIRMS_MAP_KEY) throw new EventError('FIRMS_MAP_KEY is required; an Earthdata token is not a FIRMS map key', { code: 'not_configured' });
  const days = (Date.parse(q.end) - Date.parse(q.start)) / DAY_MS + 1;
  if (days > 5) throw new EventError('FIRMS date range must contain at most five inclusive days', { code: 'invalid_request' });
  const url = `${FIRMS_AREA_URL}${encodeURIComponent(env.FIRMS_MAP_KEY)}/VIIRS_NOAA20_NRT/${q.bbox.join(',')}/${days}/${q.start}`;
  const { text } = await datasetResponse(url, 'NASA FIRMS', deps);
  const detections = parseFirmsCsv(text).filter((d) => d.longitude >= q.bbox[0] && d.longitude <= q.bbox[2] && d.latitude >= q.bbox[1] && d.latitude <= q.bbox[3] && d.acquiredAt.slice(0, 10) >= q.start && d.acquiredAt.slice(0, 10) <= q.end);
  const offset = (q.page - 1) * q.limit;
  return { items: detections.slice(offset, offset + q.limit), total: detections.length,
    nextPage: offset + q.limit < detections.length ? q.page + 1 : null,
    truncated: offset + q.limit < detections.length, measurementsRetrieved: true, spatialSubsetApplied: true,
  };
}

async function fetchGeosDataset(q, deps) {
  const [year, month, day] = q.runDate.split('-');
  const root = `${GEOS_FORECAST_URL}Y${year}/M${month}/D${day}/H${q.cycle}/`;
  const { text } = await datasetResponse(root, 'NASA GEOS-FP', deps, 4_000_000);
  const files = new Map();
  const pattern = /href="(GEOS\.fp\.fcst\.tavg1_2d_slv_Nx\.(\d{8})_(\d{2})(?:%2[Bb]|\+)(\d{8})_(\d{4})\.V\d+\.nc4)"/g;
  const date = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  for (const match of text.matchAll(pattern)) {
    const [, filename, initDate, hour, validDate, validTime] = match;
    const initializedAt = `${date(initDate)}T${hour}:00:00Z`;
    if (date(initDate) !== q.runDate || hour !== q.cycle) continue;
    files.set(filename, { id: decodeURIComponent(filename), url: new URL(filename, root).toString(), initializedAt,
      validAt: `${date(validDate)}T${validTime.slice(0, 2)}:${validTime.slice(2)}:00Z`, coverage: 'global' });
  }
  if (!files.size) throw new EventError('GEOS-FP listing contains no recognized surface meteorology files', { code: 'upstream_error' });
  const matching = [...files.values()].filter((f) => f.validAt.slice(0, 10) >= q.start && f.validAt.slice(0, 10) <= q.end).sort((a, b) => a.validAt.localeCompare(b.validAt));
  const offset = (q.page - 1) * q.limit;
  return { items: matching.slice(offset, offset + q.limit), total: matching.length,
    nextPage: offset + q.limit < matching.length ? q.page + 1 : null,
    truncated: offset + q.limit < matching.length, spatialSubsetApplied: false,
    access: 'Global NetCDF file references only; bbox is not applied to forecast grids. Crop and extract weather variables in the processor. Forecasts are model outputs, not observations.',
  };
}

/** Retrieve bounded metadata or detections. Large raster payloads stay outside the Worker. */
export async function fetchDataset(source, query, env = {}, deps = {}) {
  if (!Object.hasOwn(NASA_DATASETS, source)) throw new EventError('Unsupported NASA dataset source', { code: 'invalid_request' });
  const q = validateDatasetInput(query);
  const spec = NASA_DATASETS[source];
  const result = source === 'firms' ? await fetchFirmsDataset(q, env, deps)
    : source === 'geos' ? await fetchGeosDataset(q, deps) : await fetchCmrDataset(source, q, deps);
  return { source, name: spec.name, kind: spec.kind, query: q, credit: spec.credit, notes: spec.notes,
    measurementsRetrieved: false, ...result, count: result.items.length };
}

/** Query independent providers concurrently; one failure does not erase the other sources. */
export async function datasetContext(query, env = {}, deps = {}) {
  const q = validateDatasetInput(query);
  const settled = await Promise.allSettled(q.sources.map((source) => fetchDataset(source, q, env, deps)));
  const results = Object.fromEntries(settled.map((r, i) => [q.sources[i], r.status === 'fulfilled'
    ? { ok: true, result: r.value }
    : { ok: false, error: r.reason instanceof EventError ? r.reason.code : 'upstream_error',
      message: r.reason instanceof EventError ? r.reason.message : 'Dataset request failed', retryable: r.reason?.retryable ?? false }]));
  return { query: q, partial: settled.some((r) => r.status === 'rejected'), results };
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
