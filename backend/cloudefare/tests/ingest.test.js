import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createMessageBatch, createScheduledController, env, getQueueResult, introspectWorkflow, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';
import {
  dispatchScene,
  handleQueue,
  parseAoi,
  parseIngestRequest,
  runScheduledPoll,
  startIngest,
  validateManifest,
} from '../workFlowManger.js';
import { getEvent, getIngest, getScene, listLayersForEvent, listScenesForIngest, manifestKey } from '../dataManger.js';
import { fakeAI, fixtureScenes, resetDb, SAMPLE_EVENT, seedEvent, seedScenes, testEnv } from './helpers.js';

beforeEach(resetDb);

describe('parseAoi', () => {
  it('converts a bbox to a closed WKT polygon', () => {
    expect(parseAoi([-114, 23, -111, 25])).toEqual({ bbox: [-114, 23, -111, 25], wkt: 'POLYGON((-114 23,-111 23,-111 25,-114 25,-114 23))' });
  });
  it('accepts GeoJSON polygons and computes their bbox', () => {
    const out = parseAoi({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [1, 1], [0, 0]]] });
    expect(out.bbox).toEqual([0, 0, 2, 1]);
  });
  it('rejects open rings, out-of-range, zero-area and oversized AOIs', () => {
    expect(parseAoi({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [1, 1], [0, 1]]] }).error).toMatch(/closed/);
    expect(parseAoi([-200, 0, 1, 1]).error).toMatch(/range/);
    expect(parseAoi([1, 1, 1, 2]).error).toMatch(/non-zero/);
    expect(parseAoi([0, 0, 10, 1]).error).toMatch(/at most/);
    expect(parseAoi('nope').error).toBeTruthy();
  });
});

describe('parseIngestRequest', () => {
  const today = '2026-11-14';
  const base = { aoi: [0, 0, 1, 1], dateRange: { start: '2026-10-01', end: '2026-11-01' } };

  it('applies defaults and picks products by event type', () => {
    expect(parseIngestRequest(base, { today }).value).toMatchObject({ type: 'other', products: ['GCOV'], watch: false });
    expect(parseIngestRequest({ ...base, type: 'earthquake' }, { today }).value.products).toEqual(['GUNW']);
    expect(parseIngestRequest({ ...base, type: 'glacier' }, { today }).value.products).toEqual(['GOFF']);
    expect(parseIngestRequest({ ...base, type: 'soil_moisture' }, { today }).value.products).toEqual(['SME2']);
  });

  it('validates dates against NISAR launch, ordering, range length and future starts', () => {
    const errs = (dr) => parseIngestRequest({ ...base, dateRange: dr }, { today }).errors?.join(' ') ?? '';
    expect(errs({ start: '2024-01-01', end: '2024-02-01' })).toMatch(/NISAR launch/);
    expect(errs({ start: '2026-11-01', end: '2026-10-01' })).toMatch(/on or before/);
    expect(errs({ start: '2025-08-01', end: '2026-11-01' })).toMatch(/366/);
    expect(errs({ start: '2026-12-01', end: '2026-12-02' })).toMatch(/future/);
    expect(errs({ start: '2026-02-30', end: '2026-03-01' })).toMatch(/YYYY-MM-DD/);
  });

  it('validates products, type, eventId, name and watch', () => {
    const e = parseIngestRequest({ ...base, products: ['RSLC'], type: 'volcano', eventId: 'Bad Id', name: '', watch: 'yes' }, { today }).errors;
    expect(e).toHaveLength(5);
    expect(parseIngestRequest([], { today }).errors).toBeTruthy();
  });
});

describe('IngestWorkflow', () => {
  it('searches ASF, catalogs scenes, enqueues them and marks the ingest dispatched', async () => {
    const event = await seedEvent();
    const scenes = fixtureScenes();
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => m.mockStepResult({ name: 'search-asf' }, scenes));

    const { id } = await startIngest(env, { event, start: '2026-08-01', end: '2026-11-14' });
    const [instance] = await wf.get();
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ ingestId: id, sceneCount: 3 });
    expect(await instance.waitForStepResult({ name: 'enqueue-scenes' })).toBe(3);

    expect(await getIngest(env.DB, id)).toMatchObject({ status: 'dispatched', sceneCount: 3 });
    const stored = await listScenesForIngest(env.DB, id);
    expect(stored.map((s) => s.id).sort()).toEqual(scenes.map((s) => s.id).sort());
    // The local queue consumer may already have picked them up (no PROCESSOR_URL in tests).
    for (const s of stored) expect(['queued', 'awaiting_processor']).toContain(s.status);
    expect(await getEvent(env.DB, event.id)).toMatchObject({ startDate: '2026-08-01', endDate: '2026-11-14' });
  });

  it('marks the ingest failed when the ASF search keeps failing', async () => {
    const event = await seedEvent();
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: 'search-asf' }, new Error('ASF search failed with HTTP 503'));
    });
    const { id } = await startIngest(env, { event, start: '2026-11-01', end: '2026-11-14' });
    const [instance] = await wf.get();
    await instance.waitForStatus('errored');
    expect(await getIngest(env.DB, id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/503/) });
  });

  it('records a failed ingest if the Workflow cannot be created', async () => {
    const event = await seedEvent();
    const e = { ...env, INGEST_WORKFLOW: { create: async () => { throw new Error('quota'); } } };
    await expect(startIngest(e, { event, start: '2026-11-01', end: '2026-11-14' })).rejects.toThrow('quota');
    const { results } = await env.DB.prepare('SELECT status, error FROM ingests').all();
    expect(results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/quota/) });
  });
});

describe('queue consumer', () => {
  const msg = (body, attempts = 1) => ({ id: crypto.randomUUID(), timestamp: Date.now(), attempts, body });
  async function runBatch(queue, messages, e = testEnv(), deps) {
    const batch = createMessageBatch(queue, messages);
    const ctx = createExecutionContext();
    await handleQueue(batch, e, deps);
    return getQueueResult(batch, ctx);
  }

  it('marks scenes awaiting_processor when no processor is configured', async () => {
    await seedEvent();
    const [scene] = await seedScenes();
    const result = await runBatch('earth-replay-ingest', [msg({ type: 'process', eventId: SAMPLE_EVENT.id, sceneId: scene.id })]);
    expect(result.explicitAcks).toHaveLength(1);
    expect((await getScene(env.DB, scene.id)).status).toBe('awaiting_processor');
  });

  it('dispatches jobs to the processor with the manifest key and marks scenes processing', async () => {
    await seedEvent();
    const [scene] = await seedScenes();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const e = testEnv({ PROCESSOR_URL: 'https://processor.test/jobs', PROCESSOR_TOKEN: 'tok' });
    expect(await dispatchScene(e, { sceneId: scene.id }, fetchImpl)).toBe('processing');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://processor.test/jobs');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toMatchObject({ sceneId: scene.id, url: scene.url, output: { manifestKey: manifestKey(SAMPLE_EVENT.id, scene.id) } });
    expect((await getScene(env.DB, scene.id)).status).toBe('processing');
  });

  it('retries with backoff when the processor is down, and fails permanently on 4xx', async () => {
    await seedEvent();
    const [a, b] = await seedScenes();
    const e = testEnv({ PROCESSOR_URL: 'https://processor.test/jobs' });
    // getQueueResult() does not record delaySeconds, so spy on retry() to check the backoff.
    const batch = createMessageBatch('earth-replay-ingest', [msg({ type: 'process', sceneId: a.id }, 2)]);
    const retry = vi.spyOn(batch.messages[0], 'retry');
    await handleQueue(batch, e, { fetch: async () => new Response('', { status: 503 }) });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect((await getScene(env.DB, a.id)).status).toBe('queued');
    const rejected = await runBatch('earth-replay-ingest', [msg({ type: 'process', sceneId: b.id })], e, { fetch: async () => new Response('', { status: 400 }) });
    expect(rejected.explicitAcks).toHaveLength(1);
    expect(await getScene(env.DB, b.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/400/) });
  });

  it('registers layers, marks the scene ready and captions it on an R2 manifest notification', async () => {
    await seedEvent();
    const [scene] = await seedScenes();
    const key = manifestKey(SAMPLE_EVENT.id, scene.id);
    await env.TILES.put(key, JSON.stringify({ layers: [{ layer: 'vv-backscatter', date: '2026-11-14', minZoom: 0, maxZoom: 10, units: 'dB' }], stats: { meanChangeDb: -4 } }));
    const e = testEnv({ AI: fakeAI() });
    const result = await runBatch('earth-replay-ingest', [msg({ account: 'a', bucket: 'earth-replay-tiles', action: 'PutObject', object: { key } })], e);
    expect(result.explicitAcks).toHaveLength(1);
    expect((await getScene(env.DB, scene.id)).status).toBe('ready');
    expect(await listLayersForEvent(env.DB, SAMPLE_EVENT.id)).toMatchObject([{ layer: 'vv-backscatter', maxZoom: 10 }]);
    expect(e.VECTORS.store.size).toBe(1);

    // A duplicate notification does not caption twice.
    await runBatch('earth-replay-ingest', [msg({ action: 'PutObject', object: { key } })], e);
    expect(e.VECTORS.store.size).toBe(1);
  });

  it('retries manifest handling when AI fails, rejects invalid manifests, ignores other keys', async () => {
    await seedEvent();
    const [a, b] = await seedScenes();
    const goodKey = manifestKey(SAMPLE_EVENT.id, a.id);
    const badKey = manifestKey(SAMPLE_EVENT.id, b.id);
    await env.TILES.put(goodKey, JSON.stringify({ layers: [{ layer: 'vv', date: '2026-11-14' }] }));
    await env.TILES.put(badKey, JSON.stringify({ layers: [{ layer: '../x', date: '2026-11-14' }] }));
    const result = await runBatch(
      'earth-replay-ingest',
      [
        msg({ action: 'PutObject', object: { key: goodKey } }),
        msg({ action: 'PutObject', object: { key: badKey } }),
        msg({ action: 'PutObject', object: { key: 'tiles/x/y/z.png' } }),
        msg({ action: 'DeleteObject', object: { key: goodKey } }),
        msg({ hello: 'world' }),
      ],
      testEnv({ AI: fakeAI({ fail: true }) }),
    );
    expect(result.retryMessages).toHaveLength(1);
    expect(result.explicitAcks).toHaveLength(4);
    expect((await getScene(env.DB, b.id)).status).toBe('failed');
  });

  it('retries when the manifest is not yet readable', async () => {
    const result = await runBatch('earth-replay-ingest', [msg({ action: 'PutObject', object: { key: manifestKey('e1', 's1') } })]);
    expect(result.retryMessages).toHaveLength(1);
  });

  it('DLQ consumer marks scenes failed', async () => {
    await seedEvent();
    const [a, b] = await seedScenes();
    const result = await runBatch('earth-replay-ingest-dlq', [
      msg({ type: 'process', sceneId: a.id }),
      msg({ action: 'PutObject', object: { key: manifestKey(SAMPLE_EVENT.id, b.id) } }),
    ]);
    expect(result.explicitAcks).toHaveLength(2);
    expect(await getScene(env.DB, a.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/dispatch/) });
    expect(await getScene(env.DB, b.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/manifest/) });
  });

  it('is wired as the worker queue handler', async () => {
    const batch = createMessageBatch('earth-replay-ingest', [msg({ unknown: true })]);
    const ctx = createExecutionContext();
    await worker.queue(batch, testEnv(), ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toHaveLength(1);
  });

  it('validateManifest checks layer ids, dates and zoom range', () => {
    expect(validateManifest({ layers: [] })).toBeNull();
    expect(validateManifest({})).toMatch(/array/);
    expect(validateManifest({ layers: [{ layer: 'a', date: '2026-01-01', minZoom: 5, maxZoom: 2 }] })).toMatch(/zoom/);
    expect(validateManifest({ layers: [{ layer: 'a', date: 'yesterday' }] })).toMatch(/date/);
  });
});

describe('cron poller', () => {
  it('starts an ingest for each watched event and records the poll time', async () => {
    await seedEvent({ watch: true });
    await seedEvent({ id: 'unwatched', watch: false });
    await using wf = await introspectWorkflow(env.INGEST_WORKFLOW);
    await wf.modifyAll(async (m) => m.mockStepResult({ name: 'search-asf' }, []));

    const now = Date.parse('2026-11-14T06:00:00Z');
    const out = await runScheduledPoll(env, now);
    expect(out.started).toHaveLength(1);
    expect(out.failed).toEqual([]);
    const ingest = await getIngest(env.DB, out.started[0]);
    expect(ingest).toMatchObject({ trigger: 'cron', dateRange: { start: '2026-11-02', end: '2026-11-14' } });
    expect((await getEvent(env.DB, SAMPLE_EVENT.id)).lastPolledAt).toBe('2026-11-14T06:00:00.000Z');
    const [instance] = await wf.get();
    await instance.waitForStatus('complete');
  });

  it('continues past events whose ingest fails to start', async () => {
    await seedEvent({ watch: true });
    const e = { ...env, INGEST_WORKFLOW: { create: async () => { throw new Error('down'); } } };
    const out = await runScheduledPoll(e);
    expect(out).toEqual({ started: [], failed: [SAMPLE_EVENT.id] });
    expect((await getEvent(env.DB, SAMPLE_EVENT.id)).lastPolledAt).toBeNull();
  });

  it('is wired as the worker scheduled handler', async () => {
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '0 */6 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ingests').first()).n).toBe(0);
  });
});
