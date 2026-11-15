import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../worker.js';
import { sessionCookie } from './auth0-helpers.js';
import { buildAnswerMessages, buildEventContext } from '../AI/AIManger.js';
import { buildSummaryMessages, summaryCacheKey } from '../AI/summary.js';
import { AGENTS } from '../AI/agents.js';
import {
  contextWindow, describeContext, ensureEventContext, getStoredContext, promptContext, refreshEventContext,
} from '../eventContext.js';
import { fakeAI, resetDb, SAMPLE_EVENT, seedEvent, seedScenes, testEnv } from './helpers.js';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-11-14T12:00:00Z');
const event = { ...SAMPLE_EVENT, startDate: null, endDate: null };
const granule = (n) => ({
  id: `G${n}-TEST`, title: `granule-${n}`, time_start: '2026-11-10T00:00:00Z', time_end: '2026-11-10T23:59:59Z',
  links: [{ href: `https://data.nasa.gov/scene-${n}.h5`, rel: 'http://esipfed.org/ns/fedsearch/1.1/data#' }],
});
const FIRMS_CSV = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n' +
  '24.1,-112.2,330,0.4,0.4,2026-11-13,0130,N20,VIIRS,high,2.0NRT,290,12.5,N\n';

/** Provider mock: CMR returns two granules (7 hits) per collection, FIRMS one detection; `failFor` 503s matching URLs. */
function providers({ failFor } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (failFor && u.includes(failFor)) return new Response('boom', { status: 503 });
    if (u.includes('firms.modaps')) return new Response(FIRMS_CSV, { headers: { 'content-type': 'text/csv' } });
    return Response.json({ feed: { entry: [granule(1), granule(2)] } }, { headers: { 'CMR-Hits': '7' } });
  });
}
const on = (extra = {}) => testEnv({ EVENT_CONTEXT: 'on', ...extra });

describe('contextWindow', () => {
  it('defaults to the last 30 days ending today', () => {
    expect(contextWindow(event, NOW)).toEqual({ start: '2026-10-16', end: '2026-11-14' });
  });
  it('uses a shorter event span; an ended event stops at its end date; a future start is ignored', () => {
    expect(contextWindow({ startDate: '2026-11-10' }, NOW)).toEqual({ start: '2026-11-10', end: '2026-11-14' });
    expect(contextWindow({ startDate: '2026-05-01', endDate: '2026-06-20' }, NOW)).toEqual({ start: '2026-05-22', end: '2026-06-20' });
    expect(contextWindow({ startDate: '2027-01-01' }, NOW)).toEqual({ start: '2026-10-16', end: '2026-11-14' });
  });
});

describe('refreshEventContext', () => {
  it('queries the area, stores one row per source and skips FIRMS without a key', async () => {
    await seedEvent();
    const fetch = providers();
    const rows = await refreshEventContext(on(), event, { now: NOW, deps: { fetch } });
    expect(rows.map((r) => r.source)).toEqual(['gpm', 'grace', 'hls', 'smap', 'terrain']);
    expect(rows.every((r) => r.ok && r.fetchedAt === '2026-11-14T12:00:00.000Z')).toBe(true);
    expect(rows[0]).toMatchObject({ windowStart: '2026-10-16', windowEnd: '2026-11-14', result: { total: 7, count: 2 } });
    expect(await getStoredContext(env.DB, SAMPLE_EVENT.id)).toHaveLength(5);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('firms'))).toBe(false);
  });

  it('adds FIRMS with a five-day window when a key is configured', async () => {
    await seedEvent();
    const rows = await refreshEventContext(on({ FIRMS_MAP_KEY: 'k' }), event, { now: NOW, deps: { fetch: providers() } });
    expect(rows.find((r) => r.source === 'firms')).toMatchObject({
      ok: true, windowStart: '2026-11-10', windowEnd: '2026-11-14', result: { measurementsRetrieved: true, total: 1 },
    });
  });

  it('stores a failure only when nothing better exists and never replaces good data with one', async () => {
    await seedEvent();
    const first = await refreshEventContext(on(), event, { now: NOW, deps: { fetch: providers({ failFor: 'GPM_3IMERGDE' }) } });
    expect(first.find((r) => r.source === 'gpm')).toMatchObject({ ok: false });
    expect(first.find((r) => r.source === 'gpm').error).toMatch(/upstream_error/);
    expect(first.find((r) => r.source === 'smap').ok).toBe(true);

    await refreshEventContext(on(), event, { now: NOW + 1000, deps: { fetch: providers() } });
    expect((await getStoredContext(env.DB, SAMPLE_EVENT.id)).find((r) => r.source === 'gpm').ok).toBe(true);

    await refreshEventContext(on(), event, { now: NOW + 2000, deps: { fetch: providers({ failFor: 'GPM_3IMERGDE' }) } });
    const kept = (await getStoredContext(env.DB, SAMPLE_EVENT.id)).find((r) => r.source === 'gpm');
    expect(kept).toMatchObject({ ok: true, result: { total: 7 }, fetchedAt: '2026-11-14T12:00:01.000Z' });
  });

  it('does nothing for an event without an area', async () => {
    await seedEvent();
    const fetch = providers();
    expect(await refreshEventContext(on(), { ...event, bbox: null }, { deps: { fetch } })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ensureEventContext', () => {
  it('fetches once, then serves stored rows while fresh', async () => {
    await seedEvent();
    const fetch = providers();
    const e = on();
    expect(await ensureEventContext(e, event, { now: NOW, deps: { fetch } })).toHaveLength(5);
    const calls = fetch.mock.calls.length;
    expect(await ensureEventContext(e, event, { now: NOW + 3_600_000, deps: { fetch } })).toHaveLength(5);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it('refreshes once rows are older than six hours, but not twice inside the throttle window', async () => {
    await seedEvent();
    const e = on();
    await ensureEventContext(e, event, { now: NOW, deps: { fetch: providers() } });
    await e.CACHE.delete(`ctx:attempt:${SAMPLE_EVENT.id}`);
    const later = providers();
    await ensureEventContext(e, event, { now: NOW + 7 * 3_600_000, deps: { fetch: later } });
    expect(later).toHaveBeenCalled();
    const throttled = providers();
    await ensureEventContext(e, event, { now: NOW + 14 * 3_600_000, deps: { fetch: throttled } });
    expect(throttled).not.toHaveBeenCalled();
  });

  it('stays quiet when EVENT_CONTEXT is off or the database is unavailable', async () => {
    await seedEvent();
    const fetch = providers();
    expect(await ensureEventContext(testEnv(), event, { deps: { fetch } })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = on({ DB: { prepare: () => { throw new Error('d1 down'); } } });
    expect(await ensureEventContext(broken, event, { deps: { fetch } })).toEqual([]);
  });
});

describe('prompt and API views', () => {
  const rows = async () => {
    await seedEvent();
    return refreshEventContext(on({ FIRMS_MAP_KEY: 'k' }), event, { now: NOW, deps: { fetch: providers({ failFor: 'TELLUS' }) } });
  };

  it('promptContext is compact: counts, a few examples, no links, failed sources listed', async () => {
    const ctx = promptContext(await rows());
    expect(ctx.sources.gpm).toMatchObject({ matchingRecords: 7, window: ['2026-10-16', '2026-11-14'] });
    expect(ctx.sources.gpm.examples[0]).toEqual({ title: 'granule-1', start: '2026-11-10T00:00:00Z', end: '2026-11-10T23:59:59Z' });
    expect(ctx.sources.firms).toMatchObject({ detections: 1, examples: [{ confidence: 'high', frpMW: 12.5 }] });
    expect(ctx.unavailable).toEqual(['grace']);
    expect(JSON.stringify(ctx)).not.toContain('data.nasa.gov');
    expect(promptContext([])).toBeNull();
    expect(promptContext([{ source: 'gpm', ok: false, error: 'x' }])).toBeNull();
  });

  it('describeContext exposes totals, items and per-source errors', async () => {
    const view = describeContext('baja-test', await rows());
    expect(view.fetchedAt).toBe('2026-11-14T12:00:00.000Z');
    expect(view.sources.find((s) => s.source === 'gpm')).toMatchObject({ ok: true, total: 7, count: 2, measurementsRetrieved: false });
    expect(view.sources.find((s) => s.source === 'grace')).toMatchObject({ ok: false });
  });

  it('puts regionalContext into ask and briefing prompts and into the briefing cache key', async () => {
    const ctx = promptContext(await rows());
    expect(buildEventContext(event, [], [])).not.toHaveProperty('regionalContext');
    const ask = buildAnswerMessages(event, [], [], 'Was it raining?', [], ctx);
    expect(ask.at(-1).content).toContain('"regionalContext"');
    expect(ask[0].content).toMatch(/never present it as a NISAR observation/);
    const summary = buildSummaryMessages(Object.values(AGENTS)[0], event, [], [], {}, ctx);
    expect(summary.at(-1).content).toContain('"matchingRecords":7');
    expect(summaryCacheKey(event, [], [], ctx)).not.toBe(summaryCacheKey(event, [], []));
  });
});

describe('HTTP', () => {
  const call = (path, init, e = on()) => worker.fetch(new Request(`https://api.test${path}`, init), e, {});

  it('GET /api/events/:id/context fetches, stores and returns the datasets', async () => {
    await seedEvent();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(providers());
    const res = await call(`/api/events/${SAMPLE_EVENT.id}/context`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources.map((s) => s.source)).toEqual(['gpm', 'grace', 'hls', 'smap', 'terrain']);
    expect(body.sources[0]).toMatchObject({ ok: true, total: 7 });
    expect(await getStoredContext(env.DB, SAMPLE_EVENT.id)).toHaveLength(5);
    const calls = spy.mock.calls.length;
    await call(`/api/events/${SAMPLE_EVENT.id}/context`);
    expect(spy.mock.calls.length).toBe(calls);
  });

  it('validates the id, 404s unknown events and returns an empty list when providers are off', async () => {
    expect((await call('/api/events/bad%20id/context')).status).toBe(400);
    expect((await call('/api/events/nope/context')).status).toBe(404);
    await seedEvent();
    const res = await call(`/api/events/${SAMPLE_EVENT.id}/context`, {}, testEnv());
    expect(await res.json()).toMatchObject({ sources: [], fetchedAt: null });
  });

  it('gives the AI the stored datasets when answering, and still answers when providers fail', async () => {
    const cookie = await sessionCookie();
    const ask = (question, e) => call('/api/ask', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: SAMPLE_EVENT.id, question }),
    }, e);
    const lastPrompt = (e) => e.AI.calls.at(-1).inputs.messages.at(-1).content;

    await seedEvent();
    await seedScenes();
    vi.spyOn(globalThis, 'fetch').mockImplementation(providers());
    const e1 = on({ AI: fakeAI({ response: 'Rain records exist.' }) });
    expect((await ask('Was there rain nearby?', e1)).status).toBe(200);
    expect(lastPrompt(e1)).toContain('"regionalContext"');
    expect(lastPrompt(e1)).toContain('granule-1');

    await resetDb();
    await seedEvent();
    await seedScenes();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    const e2 = on({ AI: fakeAI({ response: 'No context.' }) });
    expect((await ask('Anything new here?', e2)).status).toBe(200);
    expect(lastPrompt(e2)).not.toContain('"regionalContext"');
  });
});
