import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';
import { PROCESSOR_INSTANCES, instanceOrder, pickInstance } from '../processor.js';
import { dispatchScene, validateManifest } from '../workFlowManger.js';
import { createMessageBatch } from 'cloudflare:test';
import { getScene, insertEvent, listLayersForEvent, setSceneStatus, upsertScenes } from '../dataManger.js';
import { fakeAI, resetDb, seedEvent, testEnv } from './helpers.js';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const TOKEN = 'proc-token';
const SCENE = {
  id: 'NISAR_L2_PR_GCOV_001_002_A_003_4005_SHNA_A_20261002T071128_20261002T071157_P05007_N_F_J_001',
  product: 'GCOV',
  acquiredAt: '2026-10-02T07:11:28.000Z',
  polarizations: ['HH'],
  url: 'https://asf.test/scene.h5',
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
const MANIFEST = { layers: [{ layer: 'gcov_hh_db', date: '2026-10-02', minZoom: 6, maxZoom: 9, bounds: [-117.3, 35.4, -117.1, 35.6], units: 'dB' }], stats: { hh_db: { mean: -8.5 } } };

async function seed() {
  await seedEvent();
  await upsertScenes(env.DB, 'baja-test', null, [{ ...SCENE, acquiredEnd: null, flightDirection: null, pathNumber: null, frameNumber: null, productionConfig: null, browseUrl: null, bounds: null }]);
}

/** A stand-in for the PROCESSOR Durable Object namespace: records the job and answers like the container would. */
function fakeContainer(answer) {
  const calls = [];
  return {
    calls,
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (request) => {
        calls.push({ name, url: request.url, auth: request.headers.get('authorization'), job: request.method === 'POST' ? await request.json() : null });
        return answer(name);
      },
    }),
  };
}

const withContainer = (answer, extra = {}) => testEnv({ PROCESSOR: fakeContainer(answer), PROCESSOR_TOKEN: TOKEN, EARTHDATA_TOKEN: 'edl-token', APP_BASE_URL: 'https://api.test', PROCESSOR_URL: '', ...extra });

describe('dispatching a scene to the Cloudflare container', () => {
  it('sends the job with the callback address, token and acquisition date, and leaves a ready scene alone', async () => {
    await seed();
    const e = withContainer(() => Response.json({ status: 'ready', layers: ['gcov_hh_db'], tiles: 12 }));
    expect(await dispatchScene(e, { sceneId: SCENE.id })).toBe('ready');
    const [call] = e.PROCESSOR.calls;
    expect(call.url).toBe('http://processor/process');
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(call.job).toMatchObject({
      eventId: 'baja-test', sceneId: SCENE.id, product: 'GCOV', url: SCENE.url, acquiredAt: SCENE.acquiredAt,
      bbox: [-114, 23, -111, 25], callbackBase: 'https://api.test',
    });
    expect(call.job.earthdataToken).toBe('edl-token'); // goes with the job, so replacing the secret needs no restart
    expect(call.name).toBe(pickInstance(SCENE.id));
    expect((await getScene(env.DB, SCENE.id)).status).toBe('processing'); // the container's manifest call is what marks it ready
  });

  it('keeps a scene on the same instance and spreads scenes across instances', () => {
    expect(pickInstance('a')).toBe(pickInstance('a'));
    const names = new Set(Array.from({ length: 40 }, (_, i) => pickInstance(`scene-${i}`)));
    expect(names.size).toBe(PROCESSOR_INSTANCES);
    expect([...names].every((n) => /^p[01]$/.test(n))).toBe(true);
  });

  it('tries the other instance when the first is busy, and reports busy only when all are', async () => {
    await seed();
    const first = pickInstance(SCENE.id);
    const e = withContainer((name) => (name === first ? Response.json({ error: 'busy' }, { status: 429 }) : Response.json({ status: 'ready' })));
    expect(await dispatchScene(e, { sceneId: SCENE.id })).toBe('ready');
    expect(e.PROCESSOR.calls.map((c) => c.name)).toEqual(instanceOrder(SCENE.id));
    const busy = withContainer(() => Response.json({ error: 'busy' }, { status: 429 }));
    await expect(dispatchScene(busy, { sceneId: SCENE.id })).rejects.toThrow(/processor unavailable: HTTP 429/);
    expect(busy.PROCESSOR.calls).toHaveLength(PROCESSOR_INSTANCES);
  });

  it('draws a ready scene again only when forced', async () => {
    await seed();
    await setSceneStatus(env.DB, SCENE.id, 'ready');
    const e = withContainer(() => Response.json({ status: 'ready' }));
    expect(await dispatchScene(e, { sceneId: SCENE.id, force: true })).toBe('ready');
    expect(e.PROCESSOR.calls).toHaveLength(1);
    expect(e.PROCESSOR.calls[0].job.sceneId).toBe(SCENE.id);
  });

  it('does nothing for a scene that is already ready', async () => {
    await seed();
    await setSceneStatus(env.DB, SCENE.id, 'ready');
    const e = withContainer(() => Response.json({ status: 'ready' }));
    expect(await dispatchScene(e, { sceneId: SCENE.id })).toBe('already-ready');
    expect(e.PROCESSOR.calls).toHaveLength(0);
  });

  it('keeps the scene waiting, with the reason, when Earthdata rejects the token', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = withContainer(() => Response.json({ error: 'earthdata_auth' }, { status: 424 }));
    expect(await dispatchScene(e, { sceneId: SCENE.id })).toBe('awaiting_processor');
    expect(await getScene(env.DB, SCENE.id)).toMatchObject({ status: 'awaiting_processor', error: 'Earthdata Login rejected the token' });
  });

  it('keeps products it cannot draw as catalogued, with the reason', async () => {
    await seed();
    const e = withContainer(() => Response.json({ status: 'skipped', reason: 'GOFF scenes are not drawn yet' }));
    expect(await dispatchScene(e, { sceneId: SCENE.id })).toBe('skipped');
    expect(await getScene(env.DB, SCENE.id)).toMatchObject({ status: 'awaiting_processor', error: 'GOFF scenes are not drawn yet' });
  });

  it('retries when the container is busy or failing, and gives up on a rejected job', async () => {
    await seed();
    for (const status of [429, 502, 500, 503]) {
      await expect(dispatchScene(withContainer(() => Response.json({ error: 'x' }, { status })), { sceneId: SCENE.id })).rejects.toThrow(/processor unavailable/);
    }
    await expect(dispatchScene(withContainer(() => Response.json({ error: 'invalid_job' }, { status: 422 })), { sceneId: SCENE.id })).rejects.toThrow(/rejected job/);
    await expect(dispatchScene(withContainer(() => new Response('<html>', { status: 502 })), { sceneId: SCENE.id })).rejects.toThrow(/unavailable/);
  });

  it('falls back to waiting when the container is bound but the Worker has no public address to report to', async () => {
    await seed();
    const e = withContainer(() => Response.json({ status: 'ready' }), { APP_BASE_URL: '' });
    expect(await dispatchScene(e, { sceneId: SCENE.id })).toBe('awaiting_processor');
    expect(e.PROCESSOR.calls).toHaveLength(0);
  });

  it('does not send the Earthdata token to an external processor URL', async () => {
    await seed();
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    await dispatchScene(withContainer(() => Response.json({}), { PROCESSOR_URL: 'https://external.test/process' }), { sceneId: SCENE.id }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('earthdataToken');
  });

  it('prefers an external PROCESSOR_URL when one is configured', async () => {
    await seed();
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const e = withContainer(() => Response.json({ status: 'ready' }), { PROCESSOR_URL: 'https://external.test/process' });
    expect(await dispatchScene(e, { sceneId: SCENE.id }, fetchImpl)).toBe('processing');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(e.PROCESSOR.calls).toHaveLength(0);
  });
});

describe('routes the container reports to', () => {
  async function call(path, init = {}, e = testEnv({ PROCESSOR_TOKEN: TOKEN })) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://api.test${path}`, init), e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const auth = { authorization: `Bearer ${TOKEN}` };
  const tilePath = (over = '') => `/internal/processor/baja-test/${SCENE.id}/tiles/gcov_hh_db/2026-10-02/9/90/200${over}`;
  const putTile = (body = PNG, headers = auth, path = tilePath()) => call(path, { method: 'PUT', headers, body });
  const putManifest = (manifest = MANIFEST, headers = { ...auth, 'content-type': 'application/json' }) =>
    call(`/internal/processor/baja-test/${SCENE.id}/manifest`, { method: 'PUT', headers, body: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) });

  it('reports on the container through the health route, for token holders only', async () => {
    const processor = fakeContainer(() => Response.json({ ok: true, busy: false, earthdataToken: true }));
    const e = testEnv({ PROCESSOR_TOKEN: TOKEN, PROCESSOR: processor });
    expect((await call('/internal/processor/health', {}, e)).status).toBe(401);
    const res = await call('/internal/processor/health', { headers: auth }, e);
    expect(await res.json()).toEqual({ processor: { ok: true, busy: false, earthdataToken: true }, status: 200, earthdataTokenSet: false });
    expect((await call('/internal/processor/health', { headers: auth }, testEnv({ PROCESSOR_TOKEN: TOKEN, PROCESSOR: undefined }))).status).toBe(503);
    const down = fakeContainer(() => { throw new Error('container failed to start'); });
    const failed = await call('/internal/processor/health', { headers: auth }, testEnv({ PROCESSOR_TOKEN: TOKEN, PROCESSOR: down }));
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe('processor_unavailable');
  });

  it('queues scenes for processing again: one scene, or everything of an event that is not ready', async () => {
    await seed();
    const sent = [];
    const INGEST_QUEUE = { sendBatch: async (messages) => sent.push(...messages.map((m) => m.body)) };
    const e = testEnv({ PROCESSOR_TOKEN: TOKEN, INGEST_QUEUE });
    const post = (body, headers = { ...auth, 'content-type': 'application/json' }) =>
      call('/internal/processor/dispatch', { method: 'POST', headers, body: JSON.stringify(body) }, e);

    expect((await post({ sceneId: SCENE.id }, {})).status).toBe(401);
    expect(sent).toEqual([]);

    const one = await post({ sceneId: SCENE.id });
    expect(one.status).toBe(202);
    expect(await one.json()).toEqual({ queued: 1, sceneIds: [SCENE.id] });
    expect(sent).toEqual([{ type: 'process', ingestId: null, eventId: 'baja-test', sceneId: SCENE.id }]);
    sent.length = 0;
    await post({ sceneId: SCENE.id, force: true });
    expect(sent).toEqual([{ type: 'process', ingestId: null, eventId: 'baja-test', sceneId: SCENE.id, force: true }]);

    sent.length = 0;
    expect((await (await post({ eventId: 'baja-test' })).json()).queued).toBe(1);
    await setSceneStatus(env.DB, SCENE.id, 'ready');
    sent.length = 0;
    expect((await post({ eventId: 'baja-test' })).status).toBe(404); // everything is ready: nothing to send
    expect(sent).toEqual([]);
    const forced = await post({ eventId: 'baja-test', force: true }); // ...unless drawing them again is asked for
    expect((await forced.json()).queued).toBe(1);
    expect(sent[0].force).toBe(true);

    expect((await post({ sceneId: 'NO_SUCH_SCENE' })).status).toBe(404);
    expect((await post({ eventId: 'no-such-event' })).status).toBe(404);
    expect((await post({})).status).toBe(400);
    expect((await post({ sceneId: '../x' })).status).toBe(400);
  });

  it('a queued scene reaches the processor through the queue consumer', async () => {
    await seed();
    const e = withContainer(() => Response.json({ status: 'ready' }));
    const batch = createMessageBatch('earth-replay-ingest', [{ id: 'm1', timestamp: Date.now(), attempts: 1, body: { type: 'process', ingestId: null, eventId: 'baja-test', sceneId: SCENE.id } }]);
    const { handleQueue } = await import('../workFlowManger.js');
    await handleQueue(batch, e);
    expect(e.PROCESSOR.calls).toHaveLength(1);
    expect(e.PROCESSOR.calls[0].job.sceneId).toBe(SCENE.id);
  });

  it('asks the container what a scene really contains, for token holders only', async () => {
    await seed();
    const processor = fakeContainer(() => Response.json({ product: 'GCOV', grids: {} }));
    const e = testEnv({ PROCESSOR_TOKEN: TOKEN, PROCESSOR: processor, EARTHDATA_TOKEN: 'edl-token' });
    const post = (body, headers = { ...auth, 'content-type': 'application/json' }, env2 = e) =>
      call('/internal/processor/inspect', { method: 'POST', headers, body: JSON.stringify(body) }, env2);
    expect((await post({ sceneId: SCENE.id }, {})).status).toBe(401);
    expect((await post({})).status).toBe(400);
    expect((await post({ sceneId: 'NO_SUCH_SCENE' })).status).toBe(404);
    const ok = await post({ sceneId: SCENE.id });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ product: 'GCOV', grids: {} });
    expect(processor.calls[0]).toMatchObject({ url: 'http://processor/inspect', auth: `Bearer ${TOKEN}`, job: { url: SCENE.url, product: 'GCOV', earthdataToken: 'edl-token' } });
    const refused = fakeContainer(() => Response.json({ error: 'earthdata_auth' }, { status: 424 }));
    expect((await post({ sceneId: SCENE.id }, undefined, testEnv({ PROCESSOR_TOKEN: TOKEN, PROCESSOR: refused }))).status).toBe(424);
    expect((await post({ sceneId: SCENE.id }, undefined, testEnv({ PROCESSOR_TOKEN: TOKEN, PROCESSOR: undefined }))).status).toBe(503);
  });

  it('refuses callers without the shared token, and everyone when it is not configured', async () => {
    expect((await putTile(PNG, {})).status).toBe(401);
    expect((await putTile(PNG, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await putManifest(MANIFEST, {})).status).toBe(401);
    const none = testEnv({ PROCESSOR_TOKEN: '' });
    expect((await call(tilePath(), { method: 'PUT', headers: auth, body: PNG }, none)).status).toBe(503);
    expect(await env.TILES.get(`tiles/baja-test/gcov_hh_db/2026-10-02/9/90/200.png`)).toBeNull();
  });

  it('stores a tile where the tile route serves it from', async () => {
    const res = await putTile();
    expect(res.status).toBe(200);
    const served = await call('/tiles/baja-test/gcov_hh_db/2026-10-02/9/90/200.png');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it('validates tile paths and bodies', async () => {
    const base = `/internal/processor/baja-test/${SCENE.id}/tiles`;
    for (const bad of [`${base}/Bad_Layer/2026-10-02/9/90/200`, `${base}/gcov_hh_db/yesterday/9/90/200`, `${base}/gcov_hh_db/2026-10-02/9/9999/200`, `${base}/gcov_hh_db/2026-10-02/30/1/1`, `${base}/gcov_hh_db/2026-10-02/9/90/200.png`]) {
      expect((await putTile(PNG, auth, bad)).status, bad).toBe(400);
    }
    expect((await putTile(new Uint8Array())).status).toBe(400);
    expect((await putTile(new Uint8Array([1, 2, 3, 4, 5]))).status).toBe(415);
    expect((await putTile(new Uint8Array(1_000_001).fill(0x89))).status).toBe(413);
    expect((await call('/internal/processor/bad%20id/x/tiles/a/2026-10-02/1/0/0', { method: 'PUT', headers: auth, body: PNG })).status).toBe(400); // unsafe event id
  });

  it('registers the layers and marks the scene ready when the manifest arrives', async () => {
    await seed();
    await setSceneStatus(env.DB, SCENE.id, 'processing');
    const res = await putManifest();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
    expect((await getScene(env.DB, SCENE.id)).status).toBe('ready');
    expect(await listLayersForEvent(env.DB, 'baja-test')).toEqual([
      expect.objectContaining({ layer: 'gcov_hh_db', date: '2026-10-02', sceneId: SCENE.id, minZoom: 6, maxZoom: 9, units: 'dB', tiles: `/tiles/baja-test/gcov_hh_db/2026-10-02/{z}/{x}/{y}.png` }),
    ]);
    const stored = await env.TILES.get(`manifests/baja-test/${SCENE.id}.json`);
    expect(await stored.json()).toMatchObject({ stats: { hh_db: { mean: -8.5 } } });
    const detail = await (await call('/api/events/baja-test')).json();
    expect(detail.layers).toHaveLength(1);
  });

  it('replaces the caption when a ready scene is drawn again', async () => {
    await seed();
    const e = testEnv({ PROCESSOR_TOKEN: TOKEN, AI: fakeAI({ response: 'first caption' }) });
    const put = (e2) => call(`/internal/processor/baja-test/${SCENE.id}/manifest`, { method: 'PUT', headers: auth, body: JSON.stringify(MANIFEST) }, e2);
    expect((await put(e)).status).toBe(200);
    const captions = async () => (await env.DB.prepare('SELECT text FROM captions WHERE scene_id = ?').bind(SCENE.id).all()).results.map((r) => r.text);
    expect(await captions()).toEqual(['first caption']);
    expect((await put(testEnv({ PROCESSOR_TOKEN: TOKEN, AI: fakeAI({ response: 'second caption' }) }))).status).toBe(200);
    expect(await captions()).toEqual(['second caption']); // one caption, describing the latest numbers
    expect((await getScene(env.DB, SCENE.id)).status).toBe('ready');
  });

  it('still reports success when only the AI caption fails (the tiles are already live)', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = testEnv({ PROCESSOR_TOKEN: TOKEN, AI: fakeAI({ fail: true }), MODEL_CAPTION: '', LLM_MODEL: '@cf/test/model' });
    const res = await call(`/internal/processor/baja-test/${SCENE.id}/manifest`, { method: 'PUT', headers: auth, body: JSON.stringify(MANIFEST) }, e);
    expect(res.status).toBe(200);
    expect((await getScene(env.DB, SCENE.id)).status).toBe('ready');
  });

  it('rejects bad manifests and manifests for unknown scenes', async () => {
    await seed();
    expect((await putManifest('not json')).status).toBe(400);
    expect((await putManifest({ layers: [{ layer: 'Bad Layer', date: '2026-10-02' }] })).status).toBe(422);
    expect((await putManifest({ layers: [{ layer: 'ok', date: 'someday' }] })).status).toBe(422);
    expect((await putManifest({ nothing: true })).status).toBe(422);
    expect((await putManifest('x'.repeat(300_000))).status).toBe(413);
    const unknown = await call(`/internal/processor/baja-test/NO_SUCH_SCENE/manifest`, { method: 'PUT', headers: auth, body: JSON.stringify(MANIFEST) });
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error).toBe('manifest_rejected');
    expect((await getScene(env.DB, SCENE.id)).status).not.toBe('ready');
  });

  it('is not part of the public API surface or the CORS-open routes', async () => {
    const res = await call(tilePath(), { method: 'PUT', headers: { ...auth, origin: 'https://evil.test' }, body: PNG });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(validateManifest(MANIFEST)).toBeNull();
  });
});
