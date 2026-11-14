import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';
import {
  AGENTS,
  MAX_CONSULTS,
  agentForEventType,
  agentModel,
  describeAgents,
  getAgent,
  keywordScore,
  routeMessage,
} from '../AI/agents.js';
import { ChatError, historyToMessages, runChat, validateChatRequest } from '../AI/chat.js';
import { AIError } from '../AI/AIGateway.js';
import { buildCoverage, summarizeEvent, summaryCacheKey } from '../AI/summary.js';
import { buildForecast, flattenStats, forecastEvent, linearFit, parseHorizon } from '../AI/forecast.js';
import { setSceneStats, setSceneStatus, listSceneStats, listMessages } from '../dataManger.js';
import { fakeAI, resetDb, SAMPLE_EVENT, seedEvent, seedScenes, testEnv } from './helpers.js';

beforeEach(resetDb);

async function call(path, init = {}, e = testEnv()) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const post = (path, body, e) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, e);

const MISTRAL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

describe('agent registry and routing', () => {
  it('maps event types to specialists, defaulting to the coordinator', () => {
    expect(agentForEventType('earthquake').id).toBe('seismologist');
    expect(agentForEventType('wetland').id).toBe('hydrologist');
    expect(agentForEventType('crop').id).toBe('ecologist');
    expect(agentForEventType('glacier').id).toBe('glaciologist');
    expect(agentForEventType('soil_moisture').id).toBe('soil_scientist');
    expect(agentForEventType('other').id).toBe('coordinator');
    expect(agentForEventType('nonsense').id).toBe('coordinator');
  });

  it('scores keywords on word starts, not substrings', () => {
    expect(keywordScore(AGENTS.hydrologist, 'Is there flooding near the river?')).toBe(2);
    expect(keywordScore(AGENTS.glaciologist, 'What is the service price?')).toBe(0); // "ice" inside words
  });

  it('routes by explicit request, then keywords, then event type', () => {
    expect(routeMessage({ message: 'hello there', eventType: 'flood', requestedAgent: 'ecologist' }).primary.id).toBe('ecologist');
    expect(routeMessage({ message: 'how much forest was burned?', eventType: 'flood' }).primary.id).toBe('ecologist');
    expect(routeMessage({ message: 'what is this?', eventType: 'flood' }).primary.id).toBe('hydrologist');
  });

  it('consults the event specialist and other touched experts, capped', () => {
    const r = routeMessage({ message: 'did the earthquake cause flooding and a landslide in the forest?', eventType: 'earthquake' });
    expect(r.consults.length).toBeLessThanOrEqual(MAX_CONSULTS);
    expect(r.consults.map((a) => a.id)).not.toContain(r.primary.id);
    const flood = routeMessage({ message: 'is the water rising?', eventType: 'earthquake' });
    expect(flood.primary.id).toBe('hydrologist');
    expect(flood.consults.map((a) => a.id)).toEqual(['seismologist']);
  });

  it('only brings in the forecaster when the user asks about the future', () => {
    expect(routeMessage({ message: 'what happened?', eventType: 'flood' }).consults.map((a) => a.id)).not.toContain('forecaster');
    expect(routeMessage({ message: 'what will happen next?', eventType: 'flood' }).consults.map((a) => a.id)).toContain('forecaster');
  });

  it('resolves each agent model with an env override', () => {
    const e = { LLM_MODEL: 'base-model' };
    expect(agentModel(e, AGENTS.seismologist)).toBe('base-model');
    expect(agentModel(e, AGENTS.hydrologist)).toBe(MISTRAL);
    expect(agentModel({ ...e, AGENT_MODEL_HYDROLOGIST: ' custom ' }, AGENTS.hydrologist)).toBe('custom');
    expect(getAgent('toString')).toBeNull();
    expect(describeAgents(e).map((a) => a.id)).toContain('forecaster');
  });
});

describe('validateChatRequest', () => {
  it('accepts a valid body and rejects bad fields', () => {
    expect(validateChatRequest({ eventId: 'e', message: ' hi there ', agent: 'hydrologist' }).value).toMatchObject({ eventId: 'e', message: 'hi there', agent: 'hydrologist' });
    expect(validateChatRequest(null).errors).toBeTruthy();
    expect(validateChatRequest({ eventId: '', message: 'x' }).errors).toHaveLength(2);
    expect(validateChatRequest({ eventId: 'e', message: 'ok ok', agent: 'wizard' }).errors[0]).toMatch(/agent must be one of/);
    expect(validateChatRequest({ eventId: 'e', message: 'ok ok', conversationId: '../x' }).errors).toEqual(['conversationId is invalid']);
    expect(validateChatRequest({ eventId: 'e', message: 'x'.repeat(1001) }).errors[0]).toMatch(/1000/);
  });
});

describe('runChat', () => {
  it('answers with the routed specialist on its own model and stores the shared thread', async () => {
    await seedEvent({ type: 'flood' });
    const scenes = await seedScenes();
    const ai = fakeAI({ response: 'Water extent likely grew.' });
    const e = testEnv({ AI: ai });
    const out = await runChat(e, { event: { ...SAMPLE_EVENT, type: 'flood' }, scenes, message: 'Is the flood water growing?' });
    expect(out.reply).toMatchObject({ agent: 'hydrologist', model: MISTRAL, text: 'Water extent likely grew.' });
    expect(out.conversationId).toMatch(/^conv_/);
    expect(out.aiGenerated).toBe(true);
    const thread = await listMessages(env.DB, out.conversationId);
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(thread[1].agent).toBe('hydrologist');
  });

  it('consults other specialists, each on its own model, and records their notes', async () => {
    await seedEvent({ type: 'earthquake' });
    const scenes = await seedScenes();
    const ai = fakeAI();
    const e = testEnv({ AI: ai });
    const event = { ...SAMPLE_EVENT, type: 'earthquake' };
    const out = await runChat(e, { event, scenes, message: 'Is the flood water spreading after the earthquake?' });
    expect(out.reply.agent).toBe('hydrologist');
    expect(out.consults.map((c) => c.agent)).toEqual(['seismologist']);
    const llmCalls = ai.calls.filter((c) => c.inputs.messages);
    expect(llmCalls.map((c) => c.model)).toEqual([env.LLM_MODEL, MISTRAL]); // consult (seismologist) then primary
    const primaryPrompt = llmCalls.at(-1).inputs.messages.at(-1).content;
    expect(primaryPrompt).toMatch(/Notes from colleagues/);
    const thread = await listMessages(env.DB, out.conversationId);
    expect(thread.map((m) => m.role)).toEqual(['user', 'consult', 'assistant']);
  });

  it('continues a conversation: every agent sees the whole shared thread', async () => {
    await seedEvent({ type: 'flood' });
    const scenes = await seedScenes();
    const event = { ...SAMPLE_EVENT, type: 'flood' };
    const ai = fakeAI();
    const e = testEnv({ AI: ai });
    const first = await runChat(e, { event, scenes, message: 'Where is the flood water?' });
    ai.calls.length = 0;
    const second = await runChat(e, { event, scenes, message: 'And how is the forest doing?', conversationId: first.conversationId });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.reply.agent).toBe('ecologist');
    const sent = ai.calls.filter((c) => c.inputs.messages).at(-1).inputs.messages;
    expect(sent.some((m) => m.role === 'assistant' && m.content.startsWith('[hydrologist] '))).toBe(true);
    expect((await listMessages(env.DB, first.conversationId)).length).toBeGreaterThanOrEqual(4);
  });

  it('skips a failing consultation but still answers', async () => {
    await seedEvent({ type: 'earthquake' });
    const scenes = await seedScenes();
    let n = 0;
    const ai = {
      calls: [],
      async run(model, inputs) {
        if (model === env.EMBEDDING_MODEL) return { data: inputs.text.map(() => [1, 0, 0, 0]) };
        if (n++ === 0) throw new Error('consult down'); // first LLM call = the consult
        return { response: 'Answer without the consult.' };
      },
    };
    const out = await runChat(testEnv({ AI: ai }), { event: { ...SAMPLE_EVENT, type: 'earthquake' }, scenes, message: 'Is the flood water spreading?' });
    expect(out.consultsFailed).toEqual(['seismologist']);
    expect(out.consults).toEqual([]);
    expect(out.reply.text).toBe('Answer without the consult.');
  });

  it('stores nothing when the primary model fails', async () => {
    await seedEvent();
    const scenes = await seedScenes();
    const e = testEnv({ AI: fakeAI({ fail: true }) });
    await expect(runChat(e, { event: SAMPLE_EVENT, scenes, message: 'What changed?' })).rejects.toBeInstanceOf(AIError);
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations').all();
    expect(results[0].n).toBe(0);
  });

  it('rejects unknown conversations and conversations from another event', async () => {
    await seedEvent();
    await seedEvent({ id: 'other-evt' });
    const scenes = await seedScenes();
    const e = testEnv();
    await expect(runChat(e, { event: SAMPLE_EVENT, scenes, message: 'hello', conversationId: 'conv_doesnotexist1' })).rejects.toBeInstanceOf(ChatError);
    const first = await runChat(e, { event: SAMPLE_EVENT, scenes, message: 'hello' });
    await expect(
      runChat(e, { event: { ...SAMPLE_EVENT, id: 'other-evt' }, scenes: [], message: 'hello', conversationId: first.conversationId }),
    ).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
  });

  it('tags specialist turns in the history it replays', () => {
    const msgs = historyToMessages([
      { role: 'user', content: 'q' },
      { role: 'consult', agent: 'seismologist', content: 'note' },
      { role: 'assistant', agent: 'hydrologist', content: 'a' },
    ]);
    expect(msgs).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '[seismologist (consulted)] note' },
      { role: 'assistant', content: '[hydrologist] a' },
    ]);
  });
});

describe('summary', () => {
  it('computes coverage deterministically and summarizes with the event specialist', async () => {
    await seedEvent({ type: 'earthquake' });
    const scenes = await seedScenes();
    const coverage = buildCoverage(scenes, [{ layer: 'b' }, { layer: 'a' }, { layer: 'a' }]);
    expect(coverage).toMatchObject({ sceneCount: scenes.length, layers: ['a', 'b'] });
    expect(coverage.firstDate <= coverage.lastDate).toBe(true);
    const ai = fakeAI({ response: 'Briefing text.' });
    const out = await summarizeEvent(testEnv({ AI: ai }), { event: { ...SAMPLE_EVENT, type: 'earthquake' }, scenes, captions: [], layers: [] });
    expect(out).toMatchObject({ summary: 'Briefing text.', agent: 'seismologist', aiGenerated: true });
    expect(out.credit.data).toMatch(/ASF DAAC/);
  });

  it('changes its cache key when scenes or readiness change', async () => {
    await seedEvent();
    const scenes = await seedScenes();
    const k1 = summaryCacheKey(SAMPLE_EVENT, scenes, []);
    const k2 = summaryCacheKey(SAMPLE_EVENT, scenes.map((s) => ({ ...s, status: 'ready' })), []);
    expect(k1).not.toBe(k2);
  });
});

describe('forecast math', () => {
  it('fits a line and rejects degenerate input', () => {
    const fit = linearFit([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.r2).toBeCloseTo(1);
    expect(linearFit([{ x: 1, y: 1 }])).toBeNull();
    expect(linearFit([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBeNull();
  });

  it('flattens numeric stats one level deep and drops everything else', () => {
    expect(flattenStats({ a: 1, b: 'x', c: { d: 2, e: 'y' }, f: [1], g: NaN })).toEqual({ a: 1, 'c.d': 2 });
    expect(flattenStats(null)).toEqual({});
  });

  it('validates the horizon', () => {
    expect(parseHorizon(undefined).value).toBe(30);
    expect(parseHorizon('45').value).toBe(45);
    for (const bad of ['0', '91', '1.5', 'abc']) expect(parseHorizon(bad).error).toBeTruthy();
  });

  const scene = (date) => ({ acquiredAt: `${date}T00:00:00Z` });
  const stat = (date, v) => ({ product: 'GCOV', acquiredAt: `${date}T00:00:00Z`, stats: { meanChangeDb: v } });

  it('reports insufficient data for fewer than two acquisition dates', () => {
    const f = buildForecast({ scenes: [scene('2026-01-01')], sceneStats: [], horizonDays: 30 });
    expect(f.status).toBe('insufficient_data');
    expect(f.metrics).toEqual([]);
  });

  it('derives cadence and the next acquisition from real dates', () => {
    const f = buildForecast({ scenes: [scene('2026-01-01'), scene('2026-01-13'), scene('2026-01-25')], sceneStats: [], horizonDays: 30 });
    expect(f.status).toBe('ok');
    expect(f.observations).toMatchObject({ cadenceDays: 12, lastDate: '2026-01-25', nextExpectedAcquisition: '2026-02-06' });
    expect(f.metrics).toEqual([]);
  });

  it('projects a linear trend with a band, and skips metrics with too few points', () => {
    const scenes = ['2026-01-01', '2026-01-11', '2026-01-21', '2026-01-31'].map(scene);
    const sceneStats = [stat('2026-01-01', -1), stat('2026-01-11', -2), stat('2026-01-21', -3), stat('2026-01-31', -4), { product: 'GUNW', acquiredAt: '2026-01-01T00:00:00Z', stats: { only: 1 } }];
    const f = buildForecast({ scenes, sceneStats, horizonDays: 10 });
    const m = f.metrics.find((x) => x.key === 'GCOV:meanChangeDb');
    expect(m).toMatchObject({ direction: 'decreasing', n: 4, confidence: 'low' });
    expect(m.slopePerDay).toBeCloseTo(-0.1, 4);
    expect(m.projected.date).toBe('2026-02-10');
    expect(m.projected.value).toBeCloseTo(-5, 3);
    expect(m.projected.low).toBeLessThanOrEqual(m.projected.value);
    expect(f.skipped).toEqual(['GUNW:only']);
  });

  it('never claims more than moderate confidence', () => {
    const dates = Array.from({ length: 8 }, (_, i) => `2026-02-${String(i * 3 + 1).padStart(2, '0')}`);
    const f = buildForecast({ scenes: dates.map(scene), sceneStats: dates.map((d, i) => stat(d, i)), horizonDays: 10 });
    expect(f.metrics[0].confidence).toBe('moderate');
  });

  it('marks output as modeled, skips the model when data is insufficient, and narrates otherwise', async () => {
    const ai = fakeAI({ response: 'Projection: ...' });
    const e = testEnv({ AI: ai });
    const none = await forecastEvent(e, { event: SAMPLE_EVENT, scenes: [], sceneStats: [], captions: [] });
    expect(none).toMatchObject({ status: 'insufficient_data', modeled: true, narrative: null, aiGenerated: false });
    expect(ai.calls).toHaveLength(0);
    const scenes = [scene('2026-01-01'), scene('2026-01-13')];
    const ok = await forecastEvent(e, { event: SAMPLE_EVENT, scenes, sceneStats: [], captions: [] });
    expect(ok).toMatchObject({ status: 'ok', modeled: true, narrative: 'Projection: ...', agent: 'forecaster', aiGenerated: true });
    expect(ok.disclaimer).toMatch(/not an observation/);
  });
});

describe('scene stats storage', () => {
  it('stores object stats on ready scenes only and ignores junk', async () => {
    await seedEvent();
    const [a, b] = await seedScenes();
    expect(await setSceneStats(env.DB, a.id, { meanChangeDb: -2 })).toBe(true);
    expect(await setSceneStats(env.DB, b.id, 'nope')).toBe(false);
    expect(await setSceneStats(env.DB, b.id, [1])).toBe(false);
    expect(await listSceneStats(env.DB, SAMPLE_EVENT.id)).toEqual([]); // not ready yet
    await setSceneStatus(env.DB, a.id, 'ready');
    const rows = await listSceneStats(env.DB, SAMPLE_EVENT.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sceneId: a.id, stats: { meanChangeDb: -2 } });
  });
});

describe('HTTP routes', () => {
  it('GET /api/agents lists the roster with models', async () => {
    const res = await call('/api/agents');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.agents.map((a) => a.id)).toEqual(expect.arrayContaining(['seismologist', 'hydrologist', 'forecaster']));
    expect(new Set(body.agents.map((a) => a.model)).size).toBeGreaterThan(1);
  });

  it('POST /api/chat validates, 404s, and chats; GET returns the thread', async () => {
    await seedEvent({ type: 'flood' });
    await seedScenes();
    expect((await post('/api/chat', { eventId: 'baja-test' })).status).toBe(400);
    expect((await call('/api/chat', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await post('/api/chat', { eventId: 'nope', message: 'hello?' })).status).toBe(404);
    expect((await post('/api/chat', { eventId: 'baja-test', message: 'hello?', conversationId: 'conv_doesnotexist1' })).status).toBe(404);

    const res = await post('/api/chat', { eventId: 'baja-test', message: 'Where is the flood water?' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.agent).toBe('hydrologist');

    const thread = await call(`/api/chat/${body.conversationId}`);
    expect(thread.status).toBe(200);
    expect((await thread.json()).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((await call('/api/chat/conv_unknown123')).status).toBe(404);
    expect((await call('/api/chat/bad%20id')).status).toBe(400);
  });

  it('POST /api/chat returns 502 when the AI is down', async () => {
    await seedEvent();
    const res = await post('/api/chat', { eventId: 'baja-test', message: 'What changed?' }, testEnv({ AI: fakeAI({ fail: true }) }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('ai_unavailable');
  });

  it('GET /api/events/:id/summary summarizes, caches, and handles 404/502', async () => {
    await seedEvent({ type: 'earthquake' });
    await seedScenes();
    const ai = fakeAI({ response: 'A briefing.' });
    const e = testEnv({ AI: ai });
    const res = await call('/api/events/baja-test/summary', {}, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: 'A briefing.', agent: 'seismologist' });
    const callsAfterFirst = ai.calls.length;
    await call('/api/events/baja-test/summary', {}, e);
    expect(ai.calls.length).toBe(callsAfterFirst); // served from KV
    expect((await call('/api/events/missing/summary')).status).toBe(404);
    await resetDb();
    await seedEvent();
    expect((await call('/api/events/baja-test/summary', {}, testEnv({ AI: fakeAI({ fail: true }) }))).status).toBe(502);
  });

  it('GET /api/events/:id/predict validates the horizon and returns a modeled projection', async () => {
    await seedEvent();
    const scenes = await seedScenes();
    expect((await call('/api/events/baja-test/predict?horizonDays=500')).status).toBe(400);
    expect((await call('/api/events/missing/predict')).status).toBe(404);
    for (const [i, s] of scenes.entries()) {
      // The fixture has only two distinct days; give each scene its own and one product, so the trend has 3 points (series are per product).
      await env.DB.prepare("UPDATE scenes SET acquired_at = ?, product = 'GCOV' WHERE id = ?").bind(`2026-0${i + 1}-01T00:00:00Z`, s.id).run();
      await setSceneStatus(env.DB, s.id, 'ready');
      await setSceneStats(env.DB, s.id, { meanChangeDb: -i });
    }
    const res = await call('/api/events/baja-test/predict?horizonDays=14');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ modeled: true, horizonDays: 14, status: 'ok' });
    expect(body.metrics[0].key).toMatch(/:meanChangeDb$/);
    expect(body.disclaimer).toBeTruthy();
    expect((await call('/api/events/baja-test/predict', {}, testEnv({ AI: fakeAI({ fail: true }) }))).status).toBe(502);
  });
});
