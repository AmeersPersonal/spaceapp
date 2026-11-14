import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { AIError, embed, gatewayOptions, generateText, runModel } from '../AI/AIGateway.js';
import { answerQuestion, buildCaptionMessages, captionScene, hashQuestion, searchCaptions, validateAskRequest } from '../AI/AIManger.js';
import { getCaptionsByIds } from '../dataManger.js';
import { fakeAI, resetDb, SAMPLE_EVENT, seedEvent, seedScenes, testEnv } from './helpers.js';

beforeEach(resetDb);

describe('AIGateway', () => {
  it('routes through AI Gateway when AI_GATEWAY_ID is set', async () => {
    expect(gatewayOptions({})).toEqual({});
    expect(gatewayOptions({ AI_GATEWAY_ID: 'g' }, { cacheTtl: 60 })).toEqual({ gateway: { id: 'g', cacheTtl: 60 } });
    const ai = fakeAI();
    await runModel({ AI: ai, AI_GATEWAY_ID: 'g' }, 'm', { x: 1 });
    expect(ai.calls[0].options).toEqual({ gateway: { id: 'g' } });
  });

  it('wraps upstream failures and empty responses in AIError', async () => {
    await expect(runModel({ AI: fakeAI({ fail: true }) }, 'm', {})).rejects.toBeInstanceOf(AIError);
    await expect(runModel({}, 'm', {})).rejects.toThrow(/not configured/);
    await expect(generateText({ ...env, AI: fakeAI({ response: '  ' }) }, [])).rejects.toThrow(/empty/);
  });

  it('validates embedding output shape', async () => {
    const vectors = await embed({ ...env, AI: fakeAI() }, ['a', 'bb']);
    expect(vectors).toHaveLength(2);
    const bad = { run: async () => ({ data: [] }) };
    await expect(embed({ ...env, AI: bad }, ['a'])).rejects.toThrow(/unexpected shape/);
  });
});

describe('AIManger', () => {
  it('validates ask payloads', () => {
    expect(validateAskRequest({ eventId: 'e', question: 'Why did it change?' }).value).toEqual({ eventId: 'e', question: 'Why did it change?' });
    expect(validateAskRequest(null).errors).toBeTruthy();
    expect(validateAskRequest({ eventId: '', question: 'hi' }).errors).toHaveLength(2);
    expect(validateAskRequest({ eventId: 'e', question: 'x'.repeat(501) }).errors[0]).toMatch(/500/);
  });

  it('caption prompt only carries supplied facts and asks for hypotheses', () => {
    const msgs = buildCaptionMessages(SAMPLE_EVENT, { product: 'GCOV', acquiredAt: 't', polarizations: ['HH'] }, { stats: { meanChangeDb: -3.1 } });
    expect(msgs[0].content).toMatch(/hypotheses/);
    expect(JSON.parse(msgs[1].content)).toMatchObject({ product: 'GCOV', changeStatistics: { meanChangeDb: -3.1 } });
  });

  it('captions a scene: stores it in D1 and indexes it in Vectorize', async () => {
    await seedEvent();
    const [scene] = await seedScenes();
    const e = testEnv();
    const caption = await captionScene(e, { event: SAMPLE_EVENT, scene, manifest: { layers: [], stats: {} } });
    expect(caption.aiGenerated).toBe(true);
    expect((await getCaptionsByIds(env.DB, [caption.id]))[0].text).toMatch(/flooding/);
    expect(e.VECTORS.store.get(caption.id).metadata).toMatchObject({ eventId: SAMPLE_EVENT.id, sceneId: scene.id });
  });

  it('does not store a caption when the model fails', async () => {
    await seedEvent();
    const [scene] = await seedScenes();
    const e = testEnv({ AI: fakeAI({ fail: true }) });
    await expect(captionScene(e, { event: SAMPLE_EVENT, scene, manifest: null })).rejects.toBeInstanceOf(AIError);
    expect(e.VECTORS.store.size).toBe(0);
  });

  it('semantic search filters by event and joins captions from D1', async () => {
    await seedEvent();
    await seedEvent({ id: 'other-evt' });
    const [scene] = await seedScenes();
    const e = testEnv();
    const c1 = await captionScene(e, { event: SAMPLE_EVENT, scene, manifest: null });
    await e.VECTORS.upsert([{ id: 'cap_other', values: [1], metadata: { eventId: 'other-evt' } }]);
    const hits = await searchCaptions(e, SAMPLE_EVENT.id, 'flood');
    expect(hits.map((h) => h.id)).toEqual([c1.id]);
    expect(hits[0].score).toBeCloseTo(0.9);
  });

  it('answers with sources, disclaimer and data credit', async () => {
    await seedEvent();
    const scenes = await seedScenes();
    const e = testEnv({ AI: fakeAI({ response: 'Likely flooding near scene X.' }) });
    await captionScene(e, { event: SAMPLE_EVENT, scene: scenes[0], manifest: null });
    const out = await answerQuestion(e, { event: SAMPLE_EVENT, scenes, question: 'What changed?' });
    expect(out.answer).toBe('Likely flooding near scene X.');
    expect(out.sources).toHaveLength(1);
    expect(out.aiGenerated).toBe(true);
    expect(out.credit.data).toMatch(/ASF DAAC/);
  });

  it('hashes questions case/whitespace-insensitively', async () => {
    expect(await hashQuestion('What  changed?')).toBe(await hashQuestion('what changed?'));
  });
});
