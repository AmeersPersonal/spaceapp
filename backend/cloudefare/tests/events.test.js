import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, introspectWorkflow, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';
import { sessionCookie } from './auth0-helpers.js';
import {
  EventError,
  bboxAround,
  buildUsgsUrl,
  fetchEarthquakeById,
  fetchEarthquakes,
  googleMapApi,
  halfWidthForMagnitude,
  handleEvent,
  handleEventBatch,
  handleEventQueue,
  handleNisarDataBatch,
  limitBbox,
  nisarData,
  normalizeQuake,
  parseBboxParam,
  parseDiscoverQuery,
  parseGeocodeResponse,
  quakeToIngestRequest,
} from '../events.js';
import { getEvent } from '../dataManger.js';
import { parseIngestRequest } from '../workFlowManger.js';
import usgsFixture from './fixtures/usgs-earthquakes.json';
import { asfFixture, resetDb, testEnv } from './helpers.js';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-11-14T12:00:00Z');
const json = (body, status = 200) => async () => Response.json(body, { status });
const panama = () => normalizeQuake(structuredClone(usgsFixture).features[0]); // M7.7, 2026-10-09

// Google responses below are shaped from the Geocoding API documentation (no key available to record one).
const googleOk = (viewport) => ({
  status: 'OK',
  results: [
    {
      formatted_address: 'Panama City, Panama',
      geometry: { location: { lat: 8.98, lng: -79.52 }, viewport: viewport ?? { northeast: { lat: 9.1, lng: -79.4 }, southwest: { lat: 8.9, lng: -79.6 } } },
    },
  ],
});

describe('AOI helpers', () => {
  it('scales the AOI with magnitude within bounds', () => {
    expect(halfWidthForMagnitude(4)).toBe(0.25);
    expect(halfWidthForMagnitude(7.7)).toBeGreaterThan(halfWidthForMagnitude(6.5));
    expect(halfWidthForMagnitude(9.9)).toBeLessThanOrEqual(2.4);
  });
  it('bboxAround clamps to the globe and limitBbox caps each side at 5 degrees', () => {
    expect(bboxAround(179.9, 89.9, 1)).toEqual([178.9, 88.9, 180, 90]);
    const [w, s, e, n] = limitBbox([-20, -10, 20, 10]);
    expect([e - w, n - s]).toEqual([5, 5]);
    expect(limitBbox([0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
  });
  it('parses bbox query params', () => {
    expect(parseBboxParam('-114,23,-111,25').bbox).toEqual([-114, 23, -111, 25]);
    expect(parseBboxParam('1,2,3').error).toBeTruthy();
    expect(parseBboxParam('a,b,c,d').error).toBeTruthy();
    expect(parseBboxParam('0,0,20,1').error).toMatch(/at most/);
  });
});

describe('USGS earthquakes', () => {
  it('normalizes the recorded USGS features', () => {
    const q = panama();
    expect(q).toMatchObject({ source: 'usgs', sourceId: 'us6000u18k', type: 'earthquake', magnitude: 7.7, longitude: -80.7566, latitude: 7.6069 });
    expect(q.time).toBe('2026-10-09T17:56:05.537Z');
  });
  it('drops non-earthquakes and features without a location', () => {
    const f = structuredClone(usgsFixture).features[0];
    expect(normalizeQuake({ ...f, properties: { ...f.properties, type: 'quarry blast' } })).toBeNull();
    expect(normalizeQuake({ ...f, geometry: { type: 'Point', coordinates: [] } })).toBeNull();
    expect(normalizeQuake({ ...f, properties: { ...f.properties, mag: null } })).toBeNull();
    expect(normalizeQuake(null)).toBeNull();
  });

  it('validates the discover query', () => {
    expect(parseDiscoverQuery(new URLSearchParams('')).value).toEqual({ minMagnitude: 6, days: 30, bbox: null });
    const bad = parseDiscoverQuery(new URLSearchParams('minMagnitude=2&days=1000&bbox=1,2'));
    expect(bad.errors).toHaveLength(3);
  });

  it('accepts an explicit date range for discovery and validates it', () => {
    expect(parseDiscoverQuery(new URLSearchParams('start=2026-05-14&end=2026-11-14')).value).toMatchObject({ start: '2026-05-14', end: '2026-11-14' });
    expect(parseDiscoverQuery(new URLSearchParams('start=2026-05-14')).errors).toEqual(['start and end must be given together']);
    expect(parseDiscoverQuery(new URLSearchParams('start=2026-11-14&end=2026-05-14')).errors).toEqual(['start must be on or before end']);
    expect(parseDiscoverQuery(new URLSearchParams('start=2025-01-01&end=2026-11-14')).errors).toEqual(['start and end must span at most 366 days']);
    expect(parseDiscoverQuery(new URLSearchParams('start=soon&end=2026-11-14')).errors).toHaveLength(1);
  });

  it('builds the USGS URL for an explicit period, covering its last day but not the future', () => {
    const url = new URL(buildUsgsUrl({ minMagnitude: 6, start: '2026-05-14', end: '2026-06-01', now: NOW }));
    expect(url.searchParams.get('starttime')).toBe('2026-05-14T00:00:00');
    expect(url.searchParams.get('endtime')).toBe('2026-06-01T23:59:59');
    const open = new URL(buildUsgsUrl({ minMagnitude: 6, start: '2026-05-14', end: '2026-11-14', now: NOW }));
    expect(open.searchParams.get('endtime')).toBe('2026-11-14T12:00:00');
  });

  it('builds the USGS URL with time window and optional bbox', () => {
    const url = new URL(buildUsgsUrl({ minMagnitude: 6, days: 30, bbox: [-90, 0, -70, 10], now: NOW }));
    expect(url.searchParams.get('starttime')).toBe('2026-10-15T12:00:00');
    expect(url.searchParams.get('minmagnitude')).toBe('6');
    expect(url.searchParams.get('minlongitude')).toBe('-90');
    expect(url.searchParams.get('maxlatitude')).toBe('10');
  });

  it('fetches earthquakes, dropping any from before NISAR launched', async () => {
    const body = structuredClone(usgsFixture);
    body.features.push({ ...structuredClone(body.features[0]), id: 'us_old', properties: { ...body.features[0].properties, time: Date.parse('2024-01-01') } });
    const quakes = await fetchEarthquakes({ now: NOW }, { fetch: json(body) });
    expect(quakes.map((q) => q.sourceId)).toEqual(['us6000u18k', 'us6000u43g']);
  });

  it('classifies upstream failures', async () => {
    await expect(fetchEarthquakes({}, { fetch: json({}, 503) })).rejects.toMatchObject({ retryable: true, code: 'upstream_error' });
    await expect(fetchEarthquakes({}, { fetch: json({}, 400) })).rejects.toMatchObject({ retryable: false });
    await expect(fetchEarthquakes({}, { fetch: async () => { throw new Error('dns'); } })).rejects.toMatchObject({ retryable: true, code: 'upstream_unreachable' });
    await expect(fetchEarthquakes({}, { fetch: json({ nope: 1 }) })).rejects.toBeInstanceOf(EventError);
  });

  it('fetches one quake by id (Feature or collection), null when unknown, rejects bad ids', async () => {
    const feature = structuredClone(usgsFixture).features[0];
    expect((await fetchEarthquakeById('us6000u18k', { fetch: json(feature) })).sourceId).toBe('us6000u18k');
    expect((await fetchEarthquakeById('us6000u18k', { fetch: json(usgsFixture) })).sourceId).toBe('us6000u18k');
    expect(await fetchEarthquakeById('us6000u18k', { fetch: json('', 404) })).toBeNull();
    await expect(fetchEarthquakeById('../etc', {})).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('quakeToIngestRequest', () => {
  it('suggests a GUNW window from 36 days before to 60 days after, clipped to today', () => {
    const r = quakeToIngestRequest(panama(), NOW);
    expect(r).toMatchObject({ eventId: 'usgs-us6000u18k', type: 'earthquake', products: ['GUNW'], dateRange: { start: '2026-09-03', end: '2026-11-14' } });
    expect(r.aoi[0]).toBeLessThan(-80.7566);
    expect(r.description).toMatch(/USGS/);
  });
  it('clips the window start to NISAR launch', () => {
    const q = { ...panama(), time: '2025-08-05T00:00:00.000Z' };
    expect(quakeToIngestRequest(q, NOW).dateRange.start).toBe('2025-07-30');
  });
  it('produces a request that passes ingest validation', () => {
    const r = quakeToIngestRequest(panama(), NOW);
    expect(parseIngestRequest(r, { today: '2026-11-14' }).errors).toBeUndefined();
  });
});

describe('nisarData', () => {
  const query = { bbox: [-114, 23, -111, 25], start: '2026-11-01', end: '2026-11-14', products: ['GCOV', 'GUNW'] };

  it('summarizes scenes by product, date and polarization', async () => {
    const out = await nisarData(query, env, { fetch: json(asfFixture) });
    expect(out).toMatchObject({ count: 3, byProduct: { GCOV: 2, GUNW: 1 }, truncated: false });
    expect(out.polarizations).toEqual(expect.arrayContaining(['VH', 'VV']));
    expect(out.dates).toEqual(['2026-08-13', '2026-11-14']);
    expect(out.query.bbox).toEqual([-114, 23, -111, 25]);
  });
  it('flags truncated results when the limit is reached', async () => {
    expect((await nisarData(query, { ...env, MAX_SCENES_PER_INGEST: '3' }, { fetch: json(asfFixture) })).truncated).toBe(true);
  });
  it('rejects invalid queries before calling ASF', async () => {
    const fetch = vi.fn();
    await expect(nisarData({ ...query, bbox: [0, 0, 0, 0] }, env, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(nisarData({ ...query, products: ['RSLC'] }, env, { fetch })).rejects.toBeInstanceOf(EventError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('maps ASF errors, keeping the retryable flag', async () => {
    await expect(nisarData(query, env, { fetch: json({}, 503) })).rejects.toMatchObject({ retryable: true });
    await expect(nisarData(query, env, { fetch: json({}, 400) })).rejects.toMatchObject({ retryable: false });
  });
  it('batch preview reports per-query results', async () => {
    const out = await handleNisarDataBatch([query, { ...query, bbox: [0, 0, 0, 0] }], env, { fetch: json(asfFixture) });
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });
});

describe('Google geocoding', () => {
  it('parses results into location, viewport bbox and a capped AOI', () => {
    const out = parseGeocodeResponse(googleOk());
    expect(out).toMatchObject({ formattedAddress: 'Panama City, Panama', location: { lat: 8.98, lng: -79.52 }, bbox: [-79.6, 8.9, -79.4, 9.1] });
    const huge = parseGeocodeResponse(googleOk({ northeast: { lat: 60, lng: 40 }, southwest: { lat: 10, lng: -20 } }));
    expect(huge.aoi[2] - huge.aoi[0]).toBe(5);
  });
  it('falls back to a box around the point for antimeridian viewports', () => {
    const out = parseGeocodeResponse(googleOk({ northeast: { lat: 10, lng: -179 }, southwest: { lat: 5, lng: 179 } }));
    expect(out.bbox[0]).toBeLessThan(out.bbox[2]);
  });
  it('treats ZERO_RESULTS as no match, quota errors as retryable and denial as permanent', () => {
    expect(parseGeocodeResponse({ status: 'ZERO_RESULTS', results: [] })).toBeNull();
    expect(() => parseGeocodeResponse({ status: 'OVER_QUERY_LIMIT' })).toThrow(expect.objectContaining({ retryable: true }));
    expect(() => parseGeocodeResponse({ status: 'REQUEST_DENIED', error_message: 'bad key' })).toThrow(/bad key/);
    try {
      parseGeocodeResponse({ status: 'REQUEST_DENIED' });
    } catch (e) {
      expect(e.retryable).toBe(false);
    }
  });

  it('requires a key and a sane query, and sends the key as a URL parameter', async () => {
    await expect(googleMapApi({ query: 'Panama' }, {})).rejects.toMatchObject({ code: 'not_configured' });
    await expect(googleMapApi({ query: 'x' }, { GOOGLE_MAPS_API_KEY: 'k' })).rejects.toMatchObject({ code: 'invalid_request' });
    const fetch = vi.fn(json(googleOk()));
    const out = await googleMapApi({ query: ' Panama City ' }, { GOOGLE_MAPS_API_KEY: 'k' }, { fetch });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('address')).toBe('Panama City');
    expect(url.searchParams.get('key')).toBe('k');
    expect(out.credit).toMatch(/Google/);
  });
  it('returns null when nothing matches', async () => {
    expect(await googleMapApi({ query: 'zzzzzz' }, { GOOGLE_MAPS_API_KEY: 'k' }, { fetch: json({ status: 'ZERO_RESULTS', results: [] }) })).toBeNull();
  });
  it('never leaks the API key in error messages', async () => {
    const err = await googleMapApi({ query: 'Panama' }, { GOOGLE_MAPS_API_KEY: 'SECRETKEY' }, { fetch: json({}, 500) }).catch((e) => e);
    expect(err.message).not.toMatch(/SECRETKEY/);
  });
});

describe('handleEvent / batch / queue', () => {
  it('registers a USGS earthquake: creates the event once and starts an ingest each time', async () => {
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => m.mockStepResult({ name: 'search-asf' }, []));
    const deps = { fetch: json(structuredClone(usgsFixture).features[0]), now: Date.now() };
    const first = await handleEvent({ source: 'usgs', usgsId: 'us6000u18k' }, testEnv(), deps);
    expect(first).toMatchObject({ eventId: 'usgs-us6000u18k', created: true });
    expect(await getEvent(env.DB, 'usgs-us6000u18k')).toMatchObject({ type: 'earthquake', products: ['GUNW'], watch: false });
    const second = await handleEvent({ source: 'usgs', usgsId: 'us6000u18k' }, testEnv(), deps);
    expect(second.created).toBe(false);
    expect(second.ingest.id).not.toBe(first.ingest.id);
    await (await wf.get())[0].waitForStatus('complete');
  });
  it('rejects unknown quakes, quakes that predate NISAR, and unsupported event shapes', async () => {
    await expect(handleEvent({ source: 'usgs', usgsId: 'us0000none' }, testEnv(), { fetch: json('', 404) })).rejects.toMatchObject({ code: 'not_found' });
    const old = { ...structuredClone(usgsFixture).features[0] };
    old.properties.time = Date.parse('2025-01-01');
    await expect(handleEvent({ source: 'usgs', usgsId: 'us6000u18k' }, testEnv(), { fetch: json(old) })).rejects.toThrow(/NISAR launch/);
    await expect(handleEvent({ hello: 1 }, env)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('routes nisar and geocode events', async () => {
    const q = { type: 'nisar', bbox: [-114, 23, -111, 25], start: '2026-11-01', end: '2026-11-14' };
    expect((await handleEvent(q, env, { fetch: json(asfFixture) })).count).toBe(3);
    expect((await handleEvent({ type: 'geocode', query: 'Panama' }, { GOOGLE_MAPS_API_KEY: 'k' }, { fetch: json(googleOk()) })).formattedAddress).toMatch(/Panama/);
  });
  it('batch handling reports failures per event', async () => {
    const out = await handleEventBatch([{ hello: 1 }, { type: 'geocode', query: 'Panama' }], { GOOGLE_MAPS_API_KEY: 'k' }, { fetch: json(googleOk()) });
    expect(out.map((o) => o.ok)).toEqual([false, true]);
  });
  it('queue handler acks successes and permanent failures, retries transient ones with backoff', async () => {
    const mk = (body, attempts = 1) => ({ body, attempts, ack: vi.fn(), retry: vi.fn() });
    const ok = mk({ type: 'geocode', query: 'Panama' });
    const bad = mk({ hello: 1 });
    const transient = mk({ type: 'geocode', query: 'Panama' }, 3);
    const e = { GOOGLE_MAPS_API_KEY: 'k' };
    await handleEventQueue({ messages: [ok, bad] }, e, { fetch: json(googleOk()) });
    expect(ok.ack).toHaveBeenCalled();
    expect(bad.ack).toHaveBeenCalled();
    await handleEventQueue({ messages: [transient] }, e, { fetch: json({}, 503) });
    expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(transient.ack).not.toHaveBeenCalled();
  });
});

describe('HTTP routes', () => {
  /** Route upstream URLs to canned responses by hostname. */
  function mockUpstreams({ usgs, asf, google } = {}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'earthquake.usgs.gov') return usgs ? usgs(url) : Response.json({}, { status: 500 });
      if (url.hostname === 'asf.test') return asf ? asf(url) : Response.json(asfFixture);
      if (url.hostname === 'maps.googleapis.com') return google ? google(url) : Response.json(googleOk());
      throw new Error(`unexpected fetch to ${url.hostname}`);
    });
  }
  async function call(path, init, e = testEnv()) {
    if (init?.method === 'POST') init = { ...init, headers: { cookie: await sessionCookie(), ...init.headers } };
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://api.test${path}`, init), e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const post = (path, body, e) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, e);

  it('GET /api/discover/earthquakes lists quakes with suggested ingest, flags registered ones, and caches', async () => {
    const spy = mockUpstreams({ usgs: () => Response.json(usgsFixture) });
    const res = await call('/api/discover/earthquakes?minMagnitude=7');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earthquakes).toHaveLength(2);
    expect(body.earthquakes[0]).toMatchObject({ sourceId: 'us6000u18k', registered: false, suggested: { type: 'earthquake', products: ['GUNW'] } });
    expect(body.credit.supplementary).toMatch(/USGS/);
    await call('/api/discover/earthquakes?minMagnitude=7');
    expect(spy).toHaveBeenCalledTimes(1);
    // A different period is a different query, not a cache hit.
    expect((await call('/api/discover/earthquakes?minMagnitude=7&start=2026-01-01&end=2026-03-01')).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await call('/api/discover/earthquakes?start=2026-01-01')).status).toBe(400);
  });
  it('discover validates input and hides upstream details on failure', async () => {
    expect((await call('/api/discover/earthquakes?days=0')).status).toBe(400);
    mockUpstreams(); // USGS answers 500
    const res = await call('/api/discover/earthquakes');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream_error', message: 'Upstream data source is unavailable' });
  });

  it('POST /api/events/earthquake registers the quake and starts an ingest', async () => {
    mockUpstreams({ usgs: () => Response.json(structuredClone(usgsFixture).features[0]) });
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => m.mockStepResult({ name: 'search-asf' }, []));
    const res = await post('/api/events/earthquake', { usgsId: 'us6000u18k' });
    expect(res.status).toBe(202);
    const out = await res.json();
    expect(out).toMatchObject({ eventId: 'usgs-us6000u18k', created: true, ingest: { status: 'queued' } });
    expect(out.ingest.statusUrl).toBe(`/api/ingest/${out.ingest.id}`);
    await (await wf.get())[0].waitForStatus('complete');
  });
  it('POST /api/events/earthquake handles bad input, unknown ids and missing login', async () => {
    expect((await post('/api/events/earthquake', {})).status).toBe(400);
    expect((await post('/api/events/earthquake', { usgsId: '../x' })).status).toBe(400);
    mockUpstreams({ usgs: () => new Response('', { status: 404 }) });
    expect((await post('/api/events/earthquake', { usgsId: 'us0000none' })).status).toBe(404);
    expect((await call('/api/events/earthquake', { method: 'POST', headers: { 'content-type': 'application/json', cookie: '' }, body: JSON.stringify({ usgsId: 'us6000u18k' }) })).status).toBe(401);
  });

  it('GET /api/nisar/search previews scenes and validates input', async () => {
    mockUpstreams();
    const ok = await call('/api/nisar/search?bbox=-114,23,-111,25&start=2026-11-01&end=2026-11-14&products=GCOV,GUNW');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ count: 3, credit: { data: expect.stringMatching(/ASF/) } });
    expect((await call('/api/nisar/search?bbox=nope&start=2026-11-01&end=2026-11-14')).status).toBe(400);
    expect((await call('/api/nisar/search?bbox=-114,23,-111,25&start=2026-11-01')).status).toBe(400);
    mockUpstreams({ asf: () => new Response('', { status: 503 }) });
    expect((await call('/api/nisar/search?bbox=-114,23,-111,25&start=2026-11-01&end=2026-11-14')).status).toBe(502);
  });

  it('GET /api/geocode needs a key, returns matches and 404s on no match', async () => {
    expect((await call('/api/geocode?q=Panama')).status).toBe(503);
    const keyed = testEnv({ GOOGLE_MAPS_API_KEY: 'k' });
    mockUpstreams();
    const ok = await call('/api/geocode?q=Panama%20City', undefined, keyed);
    expect(await ok.json()).toMatchObject({ formattedAddress: 'Panama City, Panama', aoi: expect.any(Array) });
    expect((await call('/api/geocode?q=a', undefined, keyed)).status).toBe(400);
    mockUpstreams({ google: () => Response.json({ status: 'ZERO_RESULTS', results: [] }) });
    expect((await call('/api/geocode?q=zzzzzz', undefined, keyed)).status).toBe(404);
  });
});
