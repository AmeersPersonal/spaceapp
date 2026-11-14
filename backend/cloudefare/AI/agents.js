// Specialist AI agents. Each agent is an expert on one kind of surface change: it has its own
// system prompt, vocabulary for routing, and (optionally) its own Workers AI model.
//
// Model per agent: env `AGENT_MODEL_<ID>` (e.g. AGENT_MODEL_HYDROLOGIST) overrides the
// agent's default; the default is either the shared `LLM_MODEL` or a literal model id below.

export const PRIMARY_MODEL = 'primary'; // sentinel: use env.LLM_MODEL
const MISTRAL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

const COMMON_RULES =
  'Use only the facts in the provided JSON context and the conversation. Never invent numbers, dates or scene IDs. ' +
  'Phrase physical drivers as hypotheses ("likely", "consistent with"). If the data cannot answer, say so plainly.';

export const AGENTS = Object.freeze({
  seismologist: {
    id: 'seismologist',
    name: 'Seismologist',
    expertise: 'Earthquake and ground deformation from InSAR (GUNW) and pixel offsets (GOFF).',
    eventTypes: ['earthquake'],
    model: PRIMARY_MODEL,
    keywords: ['earthquake', 'quake', 'fault', 'rupture', 'seismic', 'deformation', 'displacement', 'subsidence', 'uplift', 'interferogram', 'unwrapped', 'phase', 'fringe', 'slip', 'aftershock', 'gunw', 'goff', 'landslide'],
    prompt:
      'You are a seismologist and InSAR geodesist. You interpret line-of-sight surface displacement, fringe patterns, coherence loss and pixel offsets around earthquakes, faults, subsidence and landslides.',
  },
  hydrologist: {
    id: 'hydrologist',
    name: 'Hydrologist',
    expertise: 'Flooding, open water extent and wetlands from radar backscatter.',
    eventTypes: ['flood', 'wetland'],
    model: MISTRAL,
    keywords: ['flood', 'water', 'inundation', 'wetland', 'river', 'lake', 'storm', 'rain', 'monsoon', 'surge', 'coast', 'swamp', 'marsh', 'drought', 'reservoir', 'dam'],
    prompt:
      'You are a hydrologist who maps floods and wetlands with SAR. Open water is dark (specular reflection, low backscatter); flooded vegetation and flooded urban areas can brighten through double-bounce. You reason about water extent changes between acquisitions.',
  },
  ecologist: {
    id: 'ecologist',
    name: 'Ecologist',
    expertise: 'Forest disturbance, deforestation, biomass and crop change from polarimetric backscatter.',
    eventTypes: ['forest', 'crop'],
    model: MISTRAL,
    keywords: ['forest', 'tree', 'deforestation', 'logging', 'fire', 'burn', 'crop', 'harvest', 'vegetation', 'biomass', 'canopy', 'agriculture', 'farm', 'planting', 'cross-pol', 'hv'],
    prompt:
      'You are a forest and agricultural ecologist. Cross-polarized (HV) backscatter tracks woody biomass and canopy structure; drops suggest clearing, fire or harvest, and seasonal cycles are normal for crops.',
  },
  glaciologist: {
    id: 'glaciologist',
    name: 'Glaciologist',
    expertise: 'Glacier and ice-sheet motion, calving and melt from pixel offsets and backscatter.',
    eventTypes: ['glacier'],
    model: PRIMARY_MODEL,
    keywords: ['glacier', 'ice', 'icesheet', 'calving', 'melt', 'snow', 'flow', 'velocity', 'surge', 'crevasse', 'polar', 'permafrost', 'goff'],
    prompt:
      'You are a glaciologist. You interpret ice flow velocity from pixel offsets, calving-front retreat, and wet-snow/melt signatures in SAR backscatter.',
  },
  soil_scientist: {
    id: 'soil_scientist',
    name: 'Soil scientist',
    expertise: 'Surface soil moisture (SME2) and its links to drought, irrigation and rainfall.',
    eventTypes: ['soil_moisture'],
    model: MISTRAL,
    keywords: ['soil', 'moisture', 'dry', 'drought', 'irrigation', 'wetness', 'sme2', 'rainfall', 'runoff', 'saturation'],
    prompt:
      'You are a soil scientist. You interpret volumetric surface soil moisture estimates and the effect of vegetation and roughness on them.',
  },
  coordinator: {
    id: 'coordinator',
    name: 'Coordinator',
    expertise: 'General NISAR questions, data coverage, and combining specialist input.',
    eventTypes: ['other'],
    model: PRIMARY_MODEL,
    keywords: [],
    prompt:
      'You are the lead SAR analyst for Earth Replay. You answer general questions about the NISAR mission, products (GCOV, GUNW, GOFF, SME2), data coverage and acquisition dates, and you combine specialist input into one clear answer.',
  },
  forecaster: {
    id: 'forecaster',
    name: 'Forecaster',
    expertise: 'Predictive analysis: trends and outlooks from the observed time series.',
    eventTypes: [],
    model: PRIMARY_MODEL,
    keywords: ['predict', 'forecast', 'future', 'will', 'next', 'trend', 'expect', 'outlook', 'project', 'likely to'],
    prompt:
      'You are a forecaster. You explain statistical trends fitted to NISAR-derived scene statistics, and what they imply for the coming weeks. You never present a projection as an observation.',
  },
});

export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));
export const MAX_CONSULTS = 2;

export function getAgent(id) {
  return Object.hasOwn(AGENTS, id) ? AGENTS[id] : null;
}

/** The model an agent runs on: AGENT_MODEL_<ID> override, else its default, else LLM_MODEL. */
export function agentModel(env, agent) {
  const override = env?.[`AGENT_MODEL_${agent.id.toUpperCase()}`];
  if (typeof override === 'string' && override.trim()) return override.trim();
  return agent.model === PRIMARY_MODEL ? env.LLM_MODEL : agent.model;
}

/** True when AGENT_MODEL_<ID> is set: that explicit choice beats the per-use-case MODEL_<USECASE> routing. */
export function agentPinned(env, agent) {
  const override = env?.[`AGENT_MODEL_${agent.id.toUpperCase()}`];
  return typeof override === 'string' && override.trim() !== '';
}

/** Public description of the roster (for GET /api/agents). */
export function describeAgents(env) {
  return Object.values(AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    expertise: a.expertise,
    eventTypes: a.eventTypes,
    model: agentModel(env, a),
  }));
}

/** The default specialist for an event type. */
export function agentForEventType(type) {
  return Object.values(AGENTS).find((a) => a.eventTypes.includes(type)) ?? AGENTS.coordinator;
}

/** Number of distinct keywords of an agent that occur in the text (word start, any suffix). */
export function keywordScore(agent, text) {
  const t = String(text).toLowerCase();
  return agent.keywords.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)).length;
}

/**
 * Decide who answers and who is consulted.
 * Primary: explicit request > best keyword match > the event type's default specialist.
 * Consulted (max MAX_CONSULTS): the event's own specialist and any other agent whose
 * expertise the message touches. The forecaster only joins when asked about the future.
 */
export function routeMessage({ message, eventType, requestedAgent }) {
  const fallback = agentForEventType(eventType);
  const scored = Object.values(AGENTS)
    .filter((a) => a.id !== 'forecaster')
    .map((a) => ({ agent: a, score: keywordScore(a, message) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const primary = requestedAgent ? getAgent(requestedAgent) : (scored[0]?.agent ?? fallback);
  const candidates = [];
  if (fallback.id !== 'coordinator') candidates.push(fallback);
  for (const s of scored) candidates.push(s.agent);
  if (keywordScore(AGENTS.forecaster, message) > 0) candidates.push(AGENTS.forecaster);

  const seen = new Set([primary.id]);
  const consults = [];
  for (const a of candidates) {
    if (seen.has(a.id) || consults.length >= MAX_CONSULTS) continue;
    seen.add(a.id);
    consults.push(a);
  }
  return { primary, consults };
}

export function systemPromptFor(agent) {
  return `${agent.prompt} ${COMMON_RULES}`;
}
