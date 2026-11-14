// Per-event summary written by the specialist that matches the event type.

import { agentForEventType, agentModel, systemPromptFor } from './agents.js';
import { generateText } from './AIGateway.js';
import { AI_DISCLAIMER, buildEventContext } from './AIManger.js';
import { DATA_CREDIT } from '../dataManger.js';

const countBy = (items, key) => items.reduce((acc, i) => ({ ...acc, [i[key]]: (acc[i[key]] ?? 0) + 1 }), {});

/** Deterministic coverage numbers, computed from the catalog (never by the model). */
export function buildCoverage(scenes, layers) {
  const dates = scenes.map((s) => s.acquiredAt.slice(0, 10)).sort();
  return {
    sceneCount: scenes.length,
    byStatus: countBy(scenes, 'status'),
    byProduct: countBy(scenes, 'product'),
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    layers: [...new Set(layers.map((l) => l.layer))].sort(),
  };
}

/** Cache key that changes whenever scenes, readiness or captions change. */
export function summaryCacheKey(event, scenes, captions) {
  const ready = scenes.filter((s) => s.status === 'ready').length;
  return `summary:${event.id}:${scenes.length}:${ready}:${captions[0]?.id ?? 'none'}`;
}

export function buildSummaryMessages(agent, event, scenes, captions, coverage) {
  const context = { ...buildEventContext(event, scenes, captions), coverage, description: event.description ?? null };
  return [
    {
      role: 'system',
      content:
        `${systemPromptFor(agent)} Write a briefing for a general audience in under 200 words with these labeled parts: ` +
        '"What happened", "What NISAR sees", "Likely drivers (hypotheses)", "Data coverage", "Caveats". ' +
        'If no scene is processed yet, say the change cannot be assessed and describe only the coverage.',
    },
    { role: 'user', content: `Context:\n${JSON.stringify(context)}` },
  ];
}

export async function summarizeEvent(env, { event, scenes, captions, layers }) {
  const agent = agentForEventType(event.type);
  const model = agentModel(env, agent);
  const coverage = buildCoverage(scenes, layers);
  const summary = await generateText(env, buildSummaryMessages(agent, event, scenes, captions, coverage), { model, maxTokens: 450 });
  return {
    eventId: event.id,
    summary,
    agent: agent.id,
    name: agent.name,
    model,
    coverage,
    captionCount: captions.length,
    aiGenerated: true,
    disclaimer: AI_DISCLAIMER,
    credit: DATA_CREDIT,
  };
}
