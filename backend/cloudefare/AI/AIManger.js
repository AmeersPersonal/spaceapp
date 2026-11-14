// AI features: scene captions that hypothesize the physical driver of observed change,
// Vectorize-backed semantic search over captions, and grounded answers for POST /api/ask.

import { AIError, embed, generateText } from './AIGateway.js';
import { DATA_CREDIT, getCaptionsByIds, insertCaption, listCaptionsForEvent } from '../dataManger.js';

export const AI_DISCLAIMER =
  'AI-generated hypothesis based on NISAR-derived statistics and catalog metadata. Not a verified interpretation.';

const PRODUCT_NOTES = {
  GCOV: 'L2 geocoded polarimetric backscatter (GCOV): sensitive to surface roughness, vegetation structure, soil moisture and open water.',
  GUNW: 'L2 geocoded unwrapped interferogram (GUNW): line-of-sight surface displacement between two acquisitions.',
  GOFF: 'L2 geocoded pixel offsets (GOFF): large horizontal/vertical motion such as glacier flow or large earthquake slip.',
  SME2: 'L3 soil moisture (SME2): volumetric surface soil moisture estimates.',
};

export function validateAskRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { errors: ['body must be a JSON object'] };
  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!eventId) errors.push('eventId is required');
  if (question.length < 3) errors.push('question must be at least 3 characters');
  if (question.length > 500) errors.push('question must be at most 500 characters');
  return errors.length ? { errors } : { value: { eventId, question } };
}

/** Prompt for a scene caption. Exported for tests. */
export function buildCaptionMessages(event, scene, manifest) {
  const facts = {
    eventName: event.name,
    eventType: event.type,
    bbox: event.bbox,
    product: scene.product,
    productNote: PRODUCT_NOTES[scene.product] ?? null,
    acquiredAt: scene.acquiredAt,
    flightDirection: scene.flightDirection,
    polarizations: scene.polarizations,
    layers: (manifest?.layers ?? []).map((l) => ({ layer: l.layer, date: l.date, units: l.units })),
    changeStatistics: manifest?.stats ?? null,
    supplementaryContext: manifest?.context ?? null,
  };
  return [
    {
      role: 'system',
      content:
        'You are a SAR remote-sensing analyst. Write 2-3 sentences describing the surface change suggested by the provided NISAR statistics and the most likely physical driver. ' +
        'Only use the facts given. If statistics are missing, say the change cannot yet be quantified. Phrase drivers as hypotheses ("likely", "consistent with"). Do not invent numbers.',
    },
    { role: 'user', content: JSON.stringify(facts) },
  ];
}

/**
 * Generate a caption for a processed scene, store it in D1 and index it in Vectorize.
 * Returns the stored caption.
 */
export async function captionScene(env, { event, scene, manifest }) {
  const text = await generateText(env, buildCaptionMessages(event, scene, manifest), { maxTokens: 220 });
  const caption = { id: `cap_${crypto.randomUUID()}`, eventId: event.id, sceneId: scene.id, text, model: env.LLM_MODEL };
  const [vector] = await embed(env, [text]);
  await insertCaption(env.DB, caption);
  await env.VECTORS.upsert([
    { id: caption.id, values: vector, metadata: { eventId: event.id, sceneId: scene.id, product: scene.product } },
  ]);
  return { ...caption, aiGenerated: true };
}

/** Semantic search over captions for one event. */
export async function searchCaptions(env, eventId, query, topK = 5) {
  const [vector] = await embed(env, [query]);
  const res = await env.VECTORS.query(vector, { topK, filter: { eventId }, returnMetadata: 'none' });
  const matches = res?.matches ?? [];
  if (!matches.length) return [];
  const captions = await getCaptionsByIds(env.DB, matches.map((m) => m.id));
  const byId = new Map(captions.map((c) => [c.id, c]));
  return matches.filter((m) => byId.has(m.id)).map((m) => ({ ...byId.get(m.id), score: m.score }));
}

/** Grounding facts shared by ask, chat, summary and forecast prompts. */
export function buildEventContext(event, scenes, captions) {
  return {
    event: { id: event.id, name: event.name, type: event.type, bbox: event.bbox, startDate: event.startDate, endDate: event.endDate },
    scenes: scenes.slice(0, 30).map((s) => ({
      id: s.id,
      product: s.product,
      acquiredAt: s.acquiredAt,
      polarizations: s.polarizations,
      flightDirection: s.flightDirection,
      status: s.status,
    })),
    sceneCaptions: captions.map((c) => ({ sceneId: c.sceneId, caption: c.text })),
    productNotes: PRODUCT_NOTES,
  };
}

/** Captions most relevant to a query (Vectorize), falling back to the latest ones. */
export async function retrieveCaptions(env, eventId, query, topK = 5) {
  let captions = [];
  try {
    captions = await searchCaptions(env, eventId, query, topK);
  } catch (err) {
    if (!(err instanceof AIError)) throw err; // search is best-effort: fall back to recency
  }
  return captions.length ? captions : listCaptionsForEvent(env.DB, eventId, topK);
}

export function buildAnswerMessages(event, scenes, captions, question) {
  const context = buildEventContext(event, scenes, captions);
  return [
    {
      role: 'system',
      content:
        'You answer questions about surface change observed by the NASA-ISRO NISAR radar mission. Use only the JSON context. ' +
        'Cite scene IDs you rely on. If the context does not contain the answer, say so plainly. Mark interpretations as hypotheses. Keep answers under 150 words.',
    },
    { role: 'user', content: `Context:\n${JSON.stringify(context)}\n\nQuestion: ${question}` },
  ];
}

/** Answer a question about an event, grounded in its scenes and the most relevant captions. */
export async function answerQuestion(env, { event, scenes, question }) {
  const captions = await retrieveCaptions(env, event.id, question);
  const answer = await generateText(env, buildAnswerMessages(event, scenes, captions, question), { maxTokens: 350, cacheTtl: 3600 });
  return {
    eventId: event.id,
    question,
    answer,
    sources: captions.map((c) => ({ captionId: c.id, sceneId: c.sceneId, score: c.score ?? null })),
    sceneCount: scenes.length,
    model: env.LLM_MODEL,
    aiGenerated: true,
    disclaimer: AI_DISCLAIMER,
    credit: DATA_CREDIT,
  };
}

export async function hashQuestion(question) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(question.toLowerCase().replace(/\s+/g, ' ')));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
