import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, env, introspectWorkflow, waitOnExecutionContext } from 'cloudflare:test';
import worker, { parseTileCoords } from '../worker.js';
import { tileKey, upsertLayers } from '../dataManger.js';
import { fakeAI, resetDb, SAMPLE_EVENT, seedEvent, seedScenes, testEnv } from './helpers.js';

beforeEach(resetDb);

async function call(path, init = {}, e = testEnv()) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const post = (path, body, e, headers = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, e);

describe('GET /api/events', () => {
  it('lists events with scene counts and data credit', async () => {
    await seedEvent();
    await seedScenes();
    const res = await call('/api/events');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ id: SAMPLE_EVENT.id, sceneCount: 3, bbox: SAMPLE_EVENT.bbox });
    expect(body.credit.data).toMatch(/NASA\/JPL/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns an empty list when the catalog is empty', async () => {
    expect((await (await call('/api/events')).json()).events).toEqual([]);
  });
});

describe('GET /api/events/:id', () => {
  it('returns scenes, distinct dates, polarizations, layers and captions', async () => {
    await seedEvent();
    const scenes = await seedScenes();
    await upsertLayers(env.DB, SAMPLE_EVENT.id, scenes[0].id, [{ layer: 'vv-backscatter', date: '2026-11-14', units: 'dB' }]);
    const body = await (await call(`/api/events/${SAMPLE_EVENT.id}`)).json();
    expect(body.scenes).toHaveLength(3);
    expect(body.dates).toEqual(['2026-08-13', '2026-11-14']);
    expect(body.polarizations).toEqual(expect.arrayContaining(['VH', 'VV']));
    expect(body.layers[0].tiles).toBe(`/tiles/${SAMPLE_EVENT.id}/vv-backscatter/2026-11-14/{z}/{x}/{y}.png`);
    expect(body.captions).toEqual([]);
  });

  it('404s for unknown events and 400s for malformed ids', async () => {
    expect((await call('/api/events/nope')).status).toBe(404);
    expect((await call('/api/events/bad%20id')).status).toBe(400);
  });
});

describe('GET /tiles/...', () => {
  const path = `/tiles/${SAMPLE_EVENT.id}/vv-backscatter/2026-11-14/3/2/5.png`;

  it('serves PNG tiles from R2 with caching headers and supports If-None-Match', async () => {
    await env.TILES.put(tileKey(SAMPLE_EVENT.id, 'vv-backscatter', '2026-11-14', 3, 2, 5), new Uint8Array([137, 80, 78, 71]));
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-data-credit')).toMatch(/NISAR/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    const again = await call(path, { headers: { 'if-none-match': res.headers.get('etag') } });
    expect(again.status).toBe(304);
  });

  it('404s for missing tiles and 400s for out-of-range coordinates', async () => {
    expect((await call(path)).status).toBe(404);
    expect((await call(`/tiles/${SAMPLE_EVENT.id}/vv-backscatter/2026-11-14/3/8/5.png`)).status).toBe(400);
    expect((await call(`/tiles/${SAMPLE_EVENT.id}/vv-backscatter/2026-11-14/3/2/5.jpg`)).status).toBe(400);
    expect((await call(`/tiles/${SAMPLE_EVENT.id}/VV/2026-11-14/3/2/5.png`)).status).toBe(400);
  });

  it('parseTileCoords enforces z <= 22 and x,y < 2^z', () => {
    expect(parseTileCoords('0', '0', '0.png')).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTileCoords('0', '1', '0.png')).toBeNull();
    expect(parseTileCoords('23', '0', '0.png')).toBeNull();
    expect(parseTileCoords('a', '0', '0.png')).toBeNull();
  });
});

describe('POST /api/ingest + GET /api/ingest/:id', () => {
  const body = { aoi: [-114, 23, -111, 25], dateRange: { start: '2026-11-01', end: '2026-11-14' }, name: 'Baja demo', type: 'flood' };

  it('creates an event, starts a Workflow and reports status', async () => {
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.mockStepResult({ name: 'search-asf' }, []);
    });
    const res = await post('/api/ingest', body);
    expect(res.status).toBe(202);
    const out = await res.json();
    expect(out).toMatchObject({ status: 'queued', dateRange: body.dateRange, statusUrl: `/api/ingest/${out.id}` });
    expect(out.eventId).toMatch(/^baja-demo-/);

    const [instance] = await wf.get();
    await instance.waitForStatus('complete');

    const status = await (await call(`/api/ingest/${out.id}`)).json();
    expect(status).toMatchObject({ id: out.id, status: 'complete', sceneCount: 0, workflow: { status: 'complete' } });
    const event = await (await call(`/api/events/${out.eventId}`)).json();
    expect(event.event).toMatchObject({ name: 'Baja demo', type: 'flood', products: ['GCOV'] });
  });

  it('reuses an existing event when eventId is given', async () => {
    await seedEvent();
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => m.mockStepResult({ name: 'search-asf' }, []));
    const out = await (await post('/api/ingest', { ...body, eventId: SAMPLE_EVENT.id })).json();
    expect(out.eventId).toBe(SAMPLE_EVENT.id);
    expect((await (await call('/api/events')).json()).events).toHaveLength(1);
    const [instance] = await wf.get();
    await instance.waitForStatus('complete');
  });

  it('rejects invalid payloads with details', async () => {
    const res = await post('/api/ingest', { aoi: [0, 0, 0, 0], dateRange: { start: '2026-13-01', end: '2026-11-01' } });
    expect(res.status).toBe(400);
    const { details } = await res.json();
    expect(details.join(' ')).toMatch(/non-zero area/);
    expect(details.join(' ')).toMatch(/YYYY-MM-DD/);
    expect((await post('/api/ingest', '{not json')).status).toBe(400);
  });

  it('requires the ingest key when INGEST_API_KEY is configured', async () => {
    const e = testEnv({ INGEST_API_KEY: 'secret' });
    expect((await post('/api/ingest', body, e)).status).toBe(401);
  });

  it('404s for unknown ingests', async () => {
    expect((await call('/api/ingest/ing_missing')).status).toBe(404);
  });
});

describe('POST /api/ask', () => {
  it('answers questions about an event and caches the answer in KV', async () => {
    await seedEvent();
    await seedScenes();
    const e = testEnv({ AI: fakeAI({ response: 'Consistent with flooding.' }) });
    const res = await post('/api/ask', { eventId: SAMPLE_EVENT.id, question: 'What happened here?' }, e);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ eventId: SAMPLE_EVENT.id, answer: 'Consistent with flooding.', aiGenerated: true, sceneCount: 3 });
    const calls = e.AI.calls.length;
    await post('/api/ask', { eventId: SAMPLE_EVENT.id, question: 'what happened  here?' }, e);
    expect(e.AI.calls.length).toBe(calls); // served from cache
  });

  it('returns 400 for bad input, 404 for unknown events and 502 when AI fails', async () => {
    expect((await post('/api/ask', { question: 'x' })).status).toBe(400);
    expect((await post('/api/ask', { eventId: 'nope', question: 'What happened?' })).status).toBe(404);
    await seedEvent();
    const res = await post('/api/ask', { eventId: SAMPLE_EVENT.id, question: 'What happened?' }, testEnv({ AI: fakeAI({ fail: true }) }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('ai_unavailable');
  });
});

describe('misc', () => {
  it('lists the API contract at / and returns JSON 404s', async () => {
    const root = await (await call('/')).json();
    expect(root.routes).toContain('WS /api/room/:code');
    expect((await call('/nope')).status).toBe(404);
  });
});
