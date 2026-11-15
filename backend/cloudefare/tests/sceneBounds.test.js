import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../worker.js';
import { footprintBounds, normalizeFeature, parseSearchResponse } from '../asf.js';
import { listScenesForEvent, upsertScenes } from '../dataManger.js';
import { asfFixture, resetDb, seedEvent, SAMPLE_EVENT, testEnv } from './helpers.js';

beforeEach(resetDb);

const ring = (...pts) => ({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });

describe('footprintBounds', () => {
  it('returns [west, south, east, north] for a slanted footprint', () => {
    const g = ring([-117.9, 38.06], [-118.7, 35.95], [-115.99, 35.26], [-115.13, 37.35]);
    expect(footprintBounds(g)).toEqual([-118.7, 35.26, -115.13, 38.06]);
  });
  it('is null for missing, malformed, out-of-range or antimeridian geometry', () => {
    expect(footprintBounds(null)).toBeNull();
    expect(footprintBounds({ type: 'Polygon', coordinates: null })).toBeNull();
    expect(footprintBounds({ type: 'Point', coordinates: [1, 2] })).toBeNull();
    expect(footprintBounds({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] })).toBeNull();
    expect(footprintBounds(ring([0, 0], ['x', 1], [2, 2]))).toBeNull();
    expect(footprintBounds(ring([0, 0], [200, 1], [2, 2]))).toBeNull();
    expect(footprintBounds(ring([179, 10], [-179, 10], [-179, 12], [179, 12]))).toBeNull();
  });
  it('is kept on normalized scenes from the recorded ASF response', () => {
    const scenes = parseSearchResponse(structuredClone(asfFixture));
    expect(scenes.length).toBeGreaterThan(0);
    for (const s of scenes) expect(s.bounds === null || (s.bounds.length === 4 && s.bounds[0] < s.bounds[2])).toBe(true);
    expect(scenes.some((s) => s.bounds)).toBe(true);
  });
  it('normalizes a feature with no geometry to bounds null', () => {
    const feature = structuredClone(asfFixture.features[0]);
    feature.geometry = null;
    expect(normalizeFeature(feature).bounds).toBeNull();
  });
});

describe('storing bounds', () => {
  const scene = (extra = {}) => ({
    id: 'NISAR_TEST_1', product: 'GCOV', acquiredAt: '2026-10-25T02:40:00Z', polarizations: ['HH'],
    url: 'https://example.test/a.h5', browseUrl: 'https://example.test/a_LATLON.png', ...extra,
  });

  it('stores bounds, and a later discovery fills them in without a null erasing them', async () => {
    await seedEvent();
    await upsertScenes(env.DB, SAMPLE_EVENT.id, null, [scene()]);
    expect((await listScenesForEvent(env.DB, SAMPLE_EVENT.id))[0].bounds).toBeNull();

    await upsertScenes(env.DB, SAMPLE_EVENT.id, null, [scene({ bounds: [-118.7, 35.26, -115.13, 38.06] })]);
    expect((await listScenesForEvent(env.DB, SAMPLE_EVENT.id))[0].bounds).toEqual([-118.7, 35.26, -115.13, 38.06]);

    await upsertScenes(env.DB, SAMPLE_EVENT.id, null, [scene({ bounds: null })]);
    expect((await listScenesForEvent(env.DB, SAMPLE_EVENT.id))[0].bounds).toEqual([-118.7, 35.26, -115.13, 38.06]);
  });

  it('GET /api/events/:id returns scene bounds and browse URLs', async () => {
    await seedEvent();
    await upsertScenes(env.DB, SAMPLE_EVENT.id, null, [scene({ bounds: [-118.7, 35.26, -115.13, 38.06] })]);
    const res = await worker.fetch(new Request(`https://api.test/api/events/${SAMPLE_EVENT.id}`), testEnv(), {});
    const body = await res.json();
    expect(body.scenes[0]).toMatchObject({ id: 'NISAR_TEST_1', browseUrl: 'https://example.test/a_LATLON.png', bounds: [-118.7, 35.26, -115.13, 38.06] });
  });
});
