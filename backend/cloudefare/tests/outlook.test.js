import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';
import {
  baseScenarios,
  buildOutlook,
  cellSizeFor,
  chanceOfAtLeastOne,
  likelihoodLabel,
  parseOutlookQuery,
  parseScenarioReply,
  placeName,
  seismicOutlook,
} from '../outlook.js';
import { eventMedia, mediaLinks, parseNasaSearch, photoQuery, quakeImages, usgsIdOf } from '../media.js';
import { fakeAI, resetDb, seedEvent, testEnv } from './helpers.js';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-11-14T12:00:00Z');
const quake = (id, lng, lat, mag, time = '2026-10-01T00:00:00.000Z', place = '30 km WSW of Lata, Solomon Islands') => ({
  sourceId: id, longitude: lng, latitude: lat, magnitude: mag, time, place, title: `M ${mag} - ${place}`,
});
const usgsFeature = (id, lng, lat, mag, time = '2026-10-01T00:00:00Z') => ({
  type: 'Feature',
  id,
  properties: { type: 'earthquake', mag, time: Date.parse(time), place: '30 km WSW of Lata, Solomon Islands', title: `M ${mag} - 30 km WSW of Lata, Solomon Islands` },
  geometry: { type: 'Point', coordinates: [lng, lat, 10] },
});

async function call(path, e = testEnv()) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function mockFetch(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = routes[url.hostname];
    if (!handler) throw new Error(`unexpected fetch to ${url.hostname}`);
    return handler(url);
  });
}

describe('seismic outlook numbers', () => {
  it('validates the query', () => {
    expect(parseOutlookQuery(new URLSearchParams('bbox=122.9,24,146,45.7')).value).toEqual({ bbox: [122.9, 24, 146, 45.7], horizonDays: 30 });
    expect(parseOutlookQuery(new URLSearchParams('bbox=0,0,10,10&horizonDays=7')).value.horizonDays).toBe(7);
    for (const bad of ['', 'bbox=1,2,3', 'bbox=10,0,0,10', 'bbox=0,0,0.5,10', 'bbox=0,0,90,10', 'bbox=0,0,10,10&horizonDays=0', 'bbox=0,0,10,10&horizonDays=365', 'bbox=0,0,10,200']) {
      expect(parseOutlookQuery(new URLSearchParams(bad)).errors, bad).toHaveLength(1);
    }
  });

  it('sizes cells, names places and labels likelihood', () => {
    expect(cellSizeFor([0, 0, 5, 5])).toBe(1);
    expect(cellSizeFor([122.9, 24, 146, 45.7])).toBe(3);
    expect(placeName('30 km WSW of Lata, Solomon Islands')).toBe('Lata, Solomon Islands');
    expect(placeName('Solomon Islands')).toBe('Solomon Islands');
    expect(placeName(null)).toBeNull();
    expect(chanceOfAtLeastOne(0, 30)).toBe(0);
    expect(chanceOfAtLeastOne(1 / 30, 30)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect([0.05, 0.15, 0.5].map(likelihoodLabel)).toEqual(['low', 'moderate', 'elevated']);
  });

  it('counts quakes per cell and turns the rate into a chance', () => {
    const quakes = [
      quake('a', 0.5, 0.5, 5.0), quake('b', 0.6, 0.4, 6.1, '2026-11-01T00:00:00.000Z'), quake('c', 0.7, 0.9, 4.6),
      quake('d', 3.5, 3.5, 4.8),
      quake('outside', 50, 50, 7),
    ];
    const out = buildOutlook({ bbox: [0, 0, 5, 5], quakes, horizonDays: 30, lookbackDays: 365, now: NOW });
    expect(out.window).toEqual({ start: '2026-11-14', end: '2026-12-14' });
    expect(out.basis).toMatchObject({ count: 4, cellSizeDegrees: 1, lookbackDays: 365, minMagnitude: 4.5 });
    expect(out.cells.map((c) => c.id)).toEqual(['0_0', '3_3']); // busiest first
    const [busy, quiet] = out.cells;
    expect(busy).toMatchObject({ bbox: [0, 0, 1, 1], center: [0.5, 0.5], count: 3, maxMagnitude: 6.1, label: 'Lata, Solomon Islands' });
    expect(busy.latest.time).toBe('2026-11-01T00:00:00.000Z');
    expect(busy.probability).toBeCloseTo(1 - Math.exp(-(3 / 365) * 30), 4);
    expect(busy.probabilityM6).toBeLessThan(busy.probability / 10);
    expect(quiet.probability).toBeCloseTo(1 - Math.exp(-(1 / 365) * 30), 4);
    expect(quiet.likelihood).toBe('low');
    expect(buildOutlook({ bbox: [0, 0, 5, 5], quakes: [], now: NOW }).cells).toEqual([]);
  });

  it('writes plain scenarios for the top cells and reads only well-formed AI replies', () => {
    const quakes = Array.from({ length: 5 }, (_, i) => quake(`q${i}`, i + 0.5, 0.5, 5));
    const out = buildOutlook({ bbox: [0, 0, 5, 5], quakes, now: NOW });
    const scenarios = baseScenarios(out);
    expect(scenarios).toHaveLength(3);
    expect(scenarios[0]).toMatchObject({ type: 'earthquake', aiGenerated: false, window: out.window, cellId: out.cells[0].id });
    expect(scenarios[0].summary).toMatch(/chance/);
    expect(parseScenarioReply('Here you go: [{"cell":"0_0","title":"T","summary":"S"},{"cell":"x"},7]')).toEqual([{ cell: '0_0', title: 'T', summary: 'S' }]);
    expect(parseScenarioReply('no json here')).toEqual([]);
    expect(parseScenarioReply('[broken')).toEqual([]);
    expect(parseScenarioReply('{"cell":"0_0"}')).toEqual([]);
  });
});

describe('seismic outlook with AI wording', () => {
  const features = [usgsFeature('a', 165.5, -10.9, 6.4), usgsFeature('b', 165.6, -10.8, 4.8), usgsFeature('old', 165.5, -10.9, 5, '2024-01-01T00:00:00Z')];
  const deps = { now: NOW, fetch: async () => Response.json({ features }) };

  it('uses the AI title and summary, keeping the computed numbers', async () => {
    const AI = fakeAI({ response: '[{"cell":"0_0","title":"Aftershocks could continue near Lata","summary":"More shaking may follow. NISAR could map the deformation."}]' });
    const out = await seismicOutlook(testEnv({ AI }), { bbox: [165, -11.5, 166.5, -10], horizonDays: 30 }, deps);
    expect(out).toMatchObject({ modeled: true, aiGenerated: true, horizonDays: 30 });
    expect(out.basis.count).toBe(3); // quakes from before NISAR launch still count towards the rate
    expect(out.scenarios[0]).toMatchObject({ aiGenerated: true, title: 'Aftershocks could continue near Lata', cellId: '0_0', likelihood: out.cells[0].likelihood });
    expect(out.disclaimer).toMatch(/does not predict any specific earthquake/);
    expect(AI.calls).toHaveLength(1);
    expect(JSON.stringify(AI.calls[0].inputs.messages)).toMatch(/never \\"will\\"/);
  });

  it('falls back to the plain scenarios when the model fails or answers with prose', async () => {
    for (const AI of [fakeAI({ fail: true }), fakeAI({ response: 'I cannot answer in JSON.' })]) {
      const out = await seismicOutlook(testEnv({ AI }), { bbox: [165, -11.5, 166.5, -10], horizonDays: 30 }, deps);
      expect(out.aiGenerated).toBe(false);
      expect(out.model).toBeNull();
      expect(out.scenarios[0]).toMatchObject({ aiGenerated: false });
      expect(out.scenarios[0].title).toMatch(/Possible M4\.5\+ earthquake near Lata/);
    }
  });

  it('skips the model when the region had no earthquakes', async () => {
    const AI = fakeAI();
    const out = await seismicOutlook(testEnv({ AI }), { bbox: [0, 0, 5, 5], horizonDays: 30 }, { now: NOW, fetch: async () => Response.json({ features: [] }) });
    expect(out).toMatchObject({ cells: [], scenarios: [], aiGenerated: false });
    expect(AI.calls).toHaveLength(0);
  });

  it('GET /api/outlook validates, answers, caches and hides upstream failures', async () => {
    expect((await call('/api/outlook')).status).toBe(400);
    expect((await call('/api/outlook?bbox=0,0,90,10')).status).toBe(400);
    const spy = mockFetch({ 'earthquake.usgs.gov': () => Response.json({ features }) });
    const res = await call('/api/outlook?bbox=165,-11.5,166.5,-10&horizonDays=30');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ modeled: true, bbox: [165, -11.5, 166.5, -10] });
    expect(body.cells[0].count).toBe(3);
    const usgsUrl = new URL(spy.mock.calls[0][0]);
    expect(usgsUrl.searchParams.get('limit')).toBe('2000');
    expect(usgsUrl.searchParams.get('minmagnitude')).toBe('4.5');
    await call('/api/outlook?bbox=165,-11.5,166.5,-10&horizonDays=30');
    expect(spy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    mockFetch({ 'earthquake.usgs.gov': () => Response.json({}, { status: 500 }) });
    const failed = await call('/api/outlook?bbox=10,10,20,20');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'upstream_error', message: 'Upstream data source is unavailable' });
  });
});

describe('event pictures', () => {
  const quakeEvent = { id: 'usgs-us7000tx16', type: 'earthquake', name: 'M 6.4 - 30 km WSW of Lata, Solomon Islands' };
  const detail = {
    type: 'Feature',
    properties: {
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16',
      products: {
        shakemap: [{ contents: { 'download/intensity.jpg': { url: 'https://earthquake.usgs.gov/p/intensity.jpg' }, 'download/pga.jpg': { url: 'https://earthquake.usgs.gov/p/pga.jpg' } } }],
        losspager: [{ contents: { 'exposure.png': { url: 'https://earthquake.usgs.gov/p/exposure.png' } } }],
        dyfi: [{ contents: { 'us7000tx16_ciim.jpg': { url: 'http://insecure.example/ciim.jpg' } } }],
      },
    },
  };
  const nasa = {
    collection: {
      items: [
        { data: [{ nasa_id: 'PIA1', title: 'Radar Measures Earthquake', date_created: '2011-03-12T00:00:00Z', center: 'JPL' }], links: [{ href: 'https://images-assets.nasa.gov/image/PIA1/PIA1~thumb.jpg', render: 'image' }] },
        { data: [{ nasa_id: 'no-link', title: 'No picture' }] },
        { data: [{ title: 'No id' }], links: [{ href: 'https://images-assets.nasa.gov/x.jpg', render: 'image' }] },
      ],
    },
  };

  it('recognises earthquake events and builds a photo search', () => {
    expect(usgsIdOf(quakeEvent)).toBe('us7000tx16');
    expect(usgsIdOf({ id: 'usgs-us7000tx16', type: 'flood' })).toBeNull();
    expect(usgsIdOf({ id: 'baja-test', type: 'earthquake' })).toBeNull();
    expect(photoQuery(quakeEvent)).toBe('Solomon Islands earthquake');
    expect(photoQuery({ type: 'flood', name: 'Baja California' })).toBe('Baja California flood');
    expect(photoQuery({ type: 'other', name: 'Area near 20.345°N, 9.552°W' })).toBeNull();
  });

  it('picks USGS impact maps and NASA photos, dropping anything unusable', () => {
    const images = quakeImages(detail);
    expect(images.map((i) => i.url)).toEqual(['https://earthquake.usgs.gov/p/intensity.jpg', 'https://earthquake.usgs.gov/p/exposure.png']); // the http:// one is left out
    expect(images[0]).toMatchObject({ kind: 'map', credit: 'USGS', page: detail.properties.url });
    expect(quakeImages(null)).toEqual([]);
    expect(parseNasaSearch(nasa)).toEqual([
      { kind: 'photo', title: 'Radar Measures Earthquake', url: 'https://images-assets.nasa.gov/image/PIA1/PIA1~thumb.jpg', page: 'https://images.nasa.gov/details/PIA1', date: '2011-03-12', credit: 'NASA/JPL' },
    ]);
    expect(parseNasaSearch({})).toEqual([]);
    expect(mediaLinks(quakeEvent, 'Solomon Islands earthquake').map((l) => l.url)[0]).toBe('https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16');
    expect(mediaLinks({ id: 'x', type: 'other' }, null)).toEqual([]);
  });

  it('keeps going when one source is down, and asks nothing for an unnamed area', async () => {
    const fetchImpl = async (url) => (String(url).includes('usgs.gov') ? Response.json({}, { status: 500 }) : Response.json(nasa));
    const out = await eventMedia(quakeEvent, { fetch: fetchImpl });
    expect(out.images).toEqual([]);
    expect(out.photos).toHaveLength(1);
    expect(out.links).toHaveLength(4);
    const none = vi.fn();
    const area = await eventMedia({ id: 'area-1', type: 'other', name: 'Area near 20.345°N, 9.552°W' }, { fetch: none });
    expect(area).toMatchObject({ images: [], photos: [], links: [], photoQuery: null });
    expect(none).not.toHaveBeenCalled();
  });

  it('GET /api/events/:id/media returns maps, photos and links, and caches', async () => {
    expect((await call('/api/events/nope/media')).status).toBe(404);
    expect((await call('/api/events/bad%20id/media')).status).toBe(400);
    await seedEvent({ ...quakeEvent, aoiWkt: 'POLYGON((165 -11,166 -11,166 -10,165 -10,165 -11))', bbox: [165, -11, 166, -10], products: ['GUNW'] });
    const spy = mockFetch({ 'earthquake.usgs.gov': () => Response.json(detail), 'images-api.nasa.gov': () => Response.json(nasa) });
    const res = await call('/api/events/usgs-us7000tx16/media');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ eventId: 'usgs-us7000tx16', photoQuery: 'Solomon Islands earthquake' });
    expect(body.images).toHaveLength(2);
    expect(body.photos).toHaveLength(1);
    expect(body.credit).toMatch(/U\.S\. Geological Survey/);
    await call('/api/events/usgs-us7000tx16/media');
    expect(spy).toHaveBeenCalledTimes(2); // one USGS and one NASA request in total
  });
});
