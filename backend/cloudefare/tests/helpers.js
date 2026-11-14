// Shared test helpers: fake Workers AI / Vectorize bindings (never call the real services),
// database reset and seed data.
import { env } from 'cloudflare:test';
import { authEnv } from './auth0-helpers.js';
import { insertEvent, upsertScenes } from '../dataManger.js';
import fixture from './fixtures/asf-search-nisar.json';
import { parseSearchResponse } from '../asf.js';

export const asfFixture = fixture;
export const fixtureScenes = () => parseSearchResponse(structuredClone(fixture));

export async function resetDb() {
  await env.DB.batch(['chat_messages', 'chats', 'messages', 'conversations', 'captions', 'layers', 'scenes', 'ingests', 'events'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const listed = await env.CACHE.list();
  await Promise.all(listed.keys.map((k) => env.CACHE.delete(k.name)));
  const objects = await env.TILES.list();
  if (objects.objects.length) await env.TILES.delete(objects.objects.map((o) => o.key));
}

export function fakeAI({ fail = false, response = 'Backscatter decreased, consistent with likely surface flooding.' } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, inputs, options) {
      calls.push({ model, inputs, options });
      if (fail) throw new Error('upstream 503');
      if (model === env.EMBEDDING_MODEL) return { shape: [inputs.text.length, 4], data: inputs.text.map((t) => [t.length % 7, 1, 0.5, 0.25]) };
      return { response };
    },
  };
}

export function fakeVectors() {
  const store = new Map();
  return {
    store,
    async upsert(vectors) {
      for (const v of vectors) store.set(v.id, v);
      return { mutationId: 'm1' };
    },
    async query(_vector, { topK, filter }) {
      const matches = [...store.values()]
        .filter((v) => !filter?.eventId || v.metadata?.eventId === filter.eventId)
        .slice(0, topK)
        .map((v, i) => ({ id: v.id, score: 0.9 - i * 0.1 }));
      return { count: matches.length, matches };
    },
  };
}

export const testEnv = (overrides = {}) => ({ ...env, ...authEnv, AI: fakeAI(), VECTORS: fakeVectors(), ...overrides });

export const SAMPLE_EVENT = {
  id: 'baja-test',
  name: 'Baja California test AOI',
  type: 'flood',
  aoiWkt: 'POLYGON((-114 23,-111 23,-111 25,-114 25,-114 23))',
  bbox: [-114, 23, -111, 25],
  products: ['GCOV', 'GUNW'],
};

export async function seedEvent(overrides = {}) {
  return insertEvent(env.DB, { ...SAMPLE_EVENT, ...overrides });
}

export async function seedScenes(eventId = SAMPLE_EVENT.id, ingestId = null) {
  const scenes = fixtureScenes();
  await upsertScenes(env.DB, eventId, ingestId, scenes);
  return scenes;
}
