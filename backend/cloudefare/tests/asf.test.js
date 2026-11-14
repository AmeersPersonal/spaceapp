import { describe, expect, it, vi } from 'vitest';
import { AsfError, buildSearchUrl, normalizeFeature, parseSearchResponse, searchNisar } from '../asf.js';
import { asfFixture } from './helpers.js';

const params = { wkt: 'POLYGON((0 0,1 0,1 1,0 1,0 0))', start: '2026-11-01', end: '2026-11-14', products: ['GCOV', 'GUNW'], maxResults: 10 };

describe('buildSearchUrl', () => {
  it('builds a NISAR geojson query with full-day bounds', () => {
    const url = new URL(buildSearchUrl({ baseUrl: 'https://asf.test/s', ...params }));
    expect(url.searchParams.get('dataset')).toBe('NISAR');
    expect(url.searchParams.get('processingLevel')).toBe('GCOV,GUNW');
    expect(url.searchParams.get('start')).toBe('2026-11-01T00:00:00Z');
    expect(url.searchParams.get('end')).toBe('2026-11-14T23:59:59Z');
    expect(url.searchParams.get('output')).toBe('geojson');
    expect(url.searchParams.get('maxResults')).toBe('10');
  });
});

describe('parseSearchResponse (recorded ASF fixture)', () => {
  it('normalizes real NISAR features, reading polarization from main/side band fields', () => {
    const scenes = parseSearchResponse(structuredClone(asfFixture));
    expect(scenes).toHaveLength(3);
    const gcov = scenes.find((s) => s.id.startsWith('NISAR_L2_UR_GCOV_035_128_D_076_0005'));
    expect(gcov.product).toBe('GCOV');
    expect(gcov.polarizations).toEqual(['VH', 'VV']);
    expect(gcov.productionConfig).toBe('UR');
    expect(gcov.browseUrl).toMatch(/_LATLON\.png$/);
    // sorted by acquisition time
    expect(scenes.map((s) => s.acquiredAt)).toEqual([...scenes.map((s) => s.acquiredAt)].sort());
  });

  it('tolerates null geometry and drops non-science or incomplete features', () => {
    expect(normalizeFeature({ geometry: { coordinates: null }, properties: { ...asfFixture.features[1].properties } })).not.toBeNull();
    expect(normalizeFeature({ properties: { ...asfFixture.features[0].properties, processingLevel: 'LRCLK_UTC' } })).toBeNull();
    expect(normalizeFeature({ properties: { sceneName: 'x' } })).toBeNull();
  });

  it('dedupes repeated scenes', () => {
    const doubled = { features: [...asfFixture.features, ...asfFixture.features] };
    expect(parseSearchResponse(structuredClone(doubled))).toHaveLength(3);
  });

  it('rejects malformed bodies as non-retryable', () => {
    expect(() => parseSearchResponse({})).toThrow(AsfError);
    try {
      parseSearchResponse({});
    } catch (e) {
      expect(e.retryable).toBe(false);
    }
  });
});

describe('searchNisar', () => {
  it('calls ASF with the configured base URL and returns scenes', async () => {
    const fetchImpl = vi.fn(async () => Response.json(asfFixture));
    const scenes = await searchNisar({ ASF_SEARCH_URL: 'https://asf.test/s' }, params, fetchImpl);
    expect(scenes).toHaveLength(3);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/asf\.test\/s\?dataset=NISAR/);
  });

  it('sends the Earthdata bearer token when configured', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ features: [] }));
    await searchNisar({ EARTHDATA_TOKEN: 'abc' }, params, fetchImpl);
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer abc');
  });

  it('marks 5xx/429 as retryable and 4xx as permanent', async () => {
    await expect(searchNisar({}, params, async () => new Response('', { status: 503 }))).rejects.toMatchObject({ retryable: true, status: 503 });
    await expect(searchNisar({}, params, async () => new Response('', { status: 429 }))).rejects.toMatchObject({ retryable: true });
    await expect(searchNisar({}, params, async () => new Response('', { status: 400 }))).rejects.toMatchObject({ retryable: false });
  });

  it('wraps network errors and invalid JSON', async () => {
    await expect(searchNisar({}, params, async () => { throw new Error('boom'); })).rejects.toThrow(/network error/);
    await expect(searchNisar({}, params, async () => new Response('<html>'))).rejects.toThrow(/invalid JSON/);
  });
});
