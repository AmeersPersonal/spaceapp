import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';
import { datasetContext, fetchDataset, listDatasets, parseDatasetQuery } from '../events.js';
import { testEnv } from './helpers.js';

afterEach(() => vi.restoreAllMocks());
const query = { bbox: [-119, 35, -118, 36], start: '2026-11-01', end: '2026-11-03', limit: 2, page: 1 };
const granule = { id: 'G1-TEST', title: 'real-scene', time_start: '2026-11-01T00:00:00Z', links: [
  { href: 'https://data.nasa.gov/scene.h5', rel: 'http://esipfed.org/ns/fedsearch/1.1/data#' },
  { href: 'https://example.org/documentation', inherited: true, rel: 'http://esipfed.org/ns/fedsearch/1.1/data#' },
] };
const cmrFetch = vi.fn(async () => Response.json({ feed: { entry: [granule] } }, { headers: { 'CMR-Hits': '3' } }));

describe('NASA source discovery', () => {
  it('lists seven sources and identifies the separate FIRMS credential', () => {
    expect(listDatasets({}).map((s) => s.id)).toEqual(['firms', 'gpm', 'smap', 'hls', 'geos', 'terrain', 'grace']);
    expect(listDatasets({}).find((s) => s.id === 'firms')).toMatchObject({ configured: false, requiredSecret: 'FIRMS_MAP_KEY' });
    expect(JSON.stringify(listDatasets({ FIRMS_MAP_KEY: 'private-key' }))).not.toContain('private-key');
  });
  it('validates dates, region, pagination, sources and forecast cycle before fetching', () => {
    const parse = (s) => parseDatasetQuery(new URLSearchParams(s));
    expect(parse('bbox=-119,35,-118,36&start=2020-01-01&end=2020-01-03').value).toMatchObject({ start: '2020-01-01', limit: 10, page: 1 });
    for (const extra of ['start=2026-02-30', 'end=2025-01-01', 'limit=0', 'limit=51', 'page=1.5', 'sources=nope', 'cycle=03', 'runDate=bad']) {
      const p = new URLSearchParams('bbox=-119,35,-118,36&start=2026-11-01&end=2026-11-03');
      for (const [k, v] of new URLSearchParams(extra)) p.set(k, v);
      expect(parseDatasetQuery(p).errors, extra).toBeTruthy();
    }
    expect(parse('bbox=0,0,50,50&start=2026-01-01&end=2026-01-02').errors).toBeTruthy();
    expect(parse('bbox=,0,1,1&start=2026-01-01&end=2026-01-02').errors).toBeTruthy();
  });
  it.each(['gpm', 'smap', 'hls', 'terrain', 'grace'])('queries %s in CMR and returns references, not raster measurements', async (source) => {
    cmrFetch.mockClear();
    const result = await fetchDataset(source, query, {}, { fetch: cmrFetch });
    expect(result).toMatchObject({ source, kind: 'granule_catalog', measurementsRetrieved: false, total: 3, count: 1 });
    expect(result.items[0]).toMatchObject({ id: 'G1-TEST', downloads: ['https://data.nasa.gov/scene.h5'] });
    const url = new URL(cmrFetch.mock.calls[0][0]);
    expect(url.hostname).toBe('cmr.earthdata.nasa.gov');
    expect(url.searchParams.get('bounding_box')).toBe('-119,35,-118,36');
    expect(url.searchParams.has('temporal')).toBe(source !== 'terrain');
    expect(cmrFetch.mock.calls[0][1].headers.authorization).toBeUndefined();
    expect(result.nextPage).toBe(2);
  });
  it('reports empty catalog coverage without inventing measurements', async () => {
    const r = await fetchDataset('smap', query, {}, { fetch: async () => Response.json({ feed: { entry: [] } }, { headers: { 'CMR-Hits': '0' } }) });
    expect(r).toMatchObject({ count: 0, total: 0, nextPage: null, items: [] });
  });
  it('passes subsequent pages to CMR and requests both HLS instruments', async () => {
    const fetch = vi.fn(async () => Response.json({ feed: { entry: [granule] } }, { headers: { 'CMR-Hits': '3' } }));
    const r = await fetchDataset('hls', { ...query, page: 2 }, {}, { fetch });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('page_num')).toBe('2');
    expect(url.searchParams.getAll('short_name[]')).toEqual(['HLSL30', 'HLSS30']);
    expect(r.nextPage).toBeNull();
  });
  it('rejects unsupported sources and malformed provider payloads', async () => {
    await expect(fetchDataset('nope', query, {})).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(fetchDataset('smap', query, {}, { fetch: async () => Response.json({ error: 'bad' }) })).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

describe('FIRMS fire detections', () => {
  it('requires a FIRMS key rather than treating the NASA token as a map key', async () => {
    await expect(fetchDataset('firms', query, { EARTHDATA_TOKEN: 'not-a-firms-key' })).rejects.toMatchObject({ code: 'not_configured' });
  });
  it('parses quoted CSV, preserves confidence, excludes invalid coordinates and paginates', async () => {
    const csv = 'latitude,longitude,acq_date,acq_time,confidence,frp,satellite\r\n35.5,-118.5,2026-11-01,0030,n,2.5,"NOAA,20"\r\n35.6,-118.6,2026-11-01,0130,h,4,20\r\n35.7,-118.7,2026-11-01,0230,l,0,20\r\n,-118.5,2026-11-01,0030,n,2,20';
    const fetch = vi.fn(async () => new Response(csv));
    const r = await fetchDataset('firms', query, { FIRMS_MAP_KEY: 'secret' }, { fetch });
    expect(r).toMatchObject({ kind: 'fire_detections', measurementsRetrieved: true, count: 2, total: 3, nextPage: 2 });
    expect(r.items[0]).toMatchObject({ latitude: 35.5, longitude: -118.5, acquiredAt: '2026-11-01T00:30:00Z', confidence: 'n', frpMW: 2.5, satellite: 'NOAA,20' });
    expect(fetch.mock.calls[0][0]).toContain('/VIIRS_NOAA20_NRT/-119,35,-118,36/3/2026-11-01');
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('accepts header-only CSV and rejects text errors and too-long date windows', async () => {
    const env = { FIRMS_MAP_KEY: 'secret' };
    expect((await fetchDataset('firms', query, env, { fetch: async () => new Response('latitude,longitude,acq_date,acq_time\n') })).items).toEqual([]);
    await expect(fetchDataset('firms', query, env, { fetch: async () => new Response('Invalid MAP_KEY secret') })).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(fetchDataset('firms', { ...query, end: '2026-11-10' }, env)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rejects malformed quoted CSV and filters detections outside the requested region and dates', async () => {
    const env = { FIRMS_MAP_KEY: 'secret' };
    await expect(fetchDataset('firms', query, env, { fetch: async () => new Response('latitude,longitude,acq_date,acq_time\n"35,-118,2026-11-01,0030') })).rejects.toMatchObject({ code: 'upstream_error' });
    const r = await fetchDataset('firms', query, env, { fetch: async () => new Response('latitude,longitude,acq_date,acq_time\n0,0,2026-11-01,0030\n35.5,-118.5,2025-11-01,0030\n') });
    expect(r.items).toEqual([]);
  });
});

describe('GEOS forecast file discovery', () => {
  it('finds surface meteorology files, filters valid times, and preserves initialization time', async () => {
    const fetch = vi.fn(async () => new Response('<a href="GEOS.fp.fcst.tavg1_2d_slv_Nx.20261101_00%2B20261102_0030.V01.nc4">file</a><a href="https://evil.test/x.nc4">bad</a><a href="GEOS.fp.fcst.tavg1_2d_slv_Nx.20261101_00%2B20261105_0030.V01.nc4">later</a>'));
    const r = await fetchDataset('geos', query, {}, { fetch });
    expect(fetch.mock.calls[0][0]).toBe('https://portal.nccs.nasa.gov/datashare/gmao/geos-fp/forecast/Y2026/M11/D01/H00/');
    expect(r).toMatchObject({ source: 'geos', kind: 'forecast_file_catalog', measurementsRetrieved: false, spatialSubsetApplied: false, count: 1 });
    expect(r.items[0]).toMatchObject({ initializedAt: '2026-11-01T00:00:00Z', validAt: '2026-11-02T00:30:00Z' });
    expect(r.items[0].url).toContain('portal.nccs.nasa.gov');
  });
  it('does not confuse a missing archive or a changed listing with zero matching forecasts', async () => {
    await expect(fetchDataset('geos', query, {}, { fetch: async () => new Response('', { status: 404 }) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fetchDataset('geos', query, {}, { fetch: async () => new Response('<html>maintenance</html>') })).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

describe('bounded fetches and partial context', () => {
  it('sanitizes network and HTTP errors so provider URLs/keys do not escape', async () => {
    for (const fetch of [async () => { throw new Error('https://private/secret'); }, async () => new Response('secret', { status: 429 })]) {
      await expect(fetchDataset('firms', query, { FIRMS_MAP_KEY: 'secret' }, { fetch })).rejects.toMatchObject({ retryable: true });
      try { await fetchDataset('firms', query, { FIRMS_MAP_KEY: 'secret' }, { fetch }); } catch (e) { expect(e.message).not.toContain('secret'); }
    }
  });
  it('rejects oversized upstream bodies', async () => {
    await expect(fetchDataset('gpm', query, {}, { fetch: async () => new Response('x'.repeat(2_100_000)) })).rejects.toMatchObject({ code: 'upstream_error' });
  });
  it('rejects invalid input even when called through the generic event handler', async () => {
    const { handleEvent } = await import('../events.js');
    await expect(handleEvent({ type: 'dataset', source: 'gpm', ...query, limit: 100 }, {})).rejects.toMatchObject({ code: 'invalid_request' });
    const r = await handleEvent({ type: 'dataset', source: 'gpm', ...query }, {}, { fetch: cmrFetch });
    expect(r.source).toBe('gpm');
  });
  it('keeps successful sources when another needs credentials', async () => {
    const r = await datasetContext({ ...query, sources: ['firms', 'gpm'] }, {}, { fetch: cmrFetch });
    expect(r.partial).toBe(true);
    expect(r.results.firms).toMatchObject({ ok: false, error: 'not_configured', retryable: false });
    expect(r.results.gpm).toMatchObject({ ok: true, result: { count: 1 } });
  });
});

describe('dataset API', () => {
  const call = (path) => worker.fetch(new Request('https://test'+path), testEnv(), {});
  it('lists sources and validates requests without calling providers', async () => {
    expect((await call('/api/datasets')).status).toBe(200);
    expect((await (await call('/api/datasets')).json()).sources).toHaveLength(7);
    expect((await call('/api/datasets/gpm?bbox=bad')).status).toBe(400);
    expect((await call('/api/datasets/nope?bbox=-119,35,-118,36&start=2026-11-01&end=2026-11-03')).status).toBe(400);
    expect((await call('/api/datasets/firms?bbox=-119,35,-118,36&start=2026-11-01&end=2026-11-03')).status).toBe(503);
  });
  it('serves catalog results and preserves partial failures in the context endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(cmrFetch);
    const params = '?bbox=-119,35,-118,36&start=2026-11-01&end=2026-11-03';
    const res = await call('/api/datasets/gpm'+params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'gpm', kind: 'granule_catalog' });
    const context = await call('/api/datasets/context'+params+'&sources=gpm,firms');
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ partial: true, results: { firms: { ok: false } } });
  });
  it('maps upstream failures to 502 and a missing forecast archive to 404', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('provider details', { status: 503 }));
    const params = '?bbox=-119,35,-118,36&start=2026-11-01&end=2026-11-03';
    const res = await call('/api/datasets/gpm'+params);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error', message: 'Upstream data source is unavailable' });
    spy.mockImplementation(async () => new Response('', { status: 404 }));
    expect((await call('/api/datasets/geos'+params)).status).toBe(404);
  });
});
