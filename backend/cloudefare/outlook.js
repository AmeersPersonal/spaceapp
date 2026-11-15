// Seismic outlook: where earthquakes have been frequent in the past year, and what that rate implies
// for the coming weeks. The numbers are computed here, deterministically, from the USGS catalog:
// a Poisson rate per grid cell. An AI model only writes the wording of the scenarios. Everything
// returned is labeled `modeled: true`: it is a statistical outlook, never a prediction of a
// specific earthquake and never an observation.

import { AGENTS, agentModel, agentPinned, systemPromptFor } from './AI/agents.js';
import { generateTextDetailed } from './AI/AIGateway.js';
import { EventError, SUPPLEMENTARY_CREDIT, buildUsgsUrl, fetchJson, normalizeQuake } from './events.js';

export const OUTLOOK_DISCLAIMER =
  'Modeled outlook: the chance of at least one earthquake is estimated from how often they happened in each cell during the past year (a Poisson rate). ' +
  'It does not predict any specific earthquake, its time, place or size, and it is not a warning. Scenario text is AI-generated from these numbers.';
export const LOOKBACK_DAYS = 365;
export const MIN_MAGNITUDE = 4.5;
export const MAX_HORIZON_DAYS = 90;
export const DEFAULT_HORIZON_DAYS = 30;
export const MIN_SIDE_DEGREES = 1;
export const MAX_SIDE_DEGREES = 60;
export const MAX_CELLS_PER_SIDE = 8;
export const MAX_SCENARIOS = 3;
const USGS_LIMIT = 2000;
const DAY_MS = 86_400_000;

const round = (v, d = 4) => Number(v.toFixed(d));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function parseOutlookQuery(params) {
  const errors = [];
  const parts = (params.get('bbox') ?? '').split(',').map(Number);
  let bbox = null;
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    errors.push('bbox must be "west,south,east,north"');
  } else {
    const [w, s, e, n] = parts;
    if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) errors.push('bbox must be within the globe with west < east and south < north');
    else if (e - w < MIN_SIDE_DEGREES || n - s < MIN_SIDE_DEGREES) errors.push(`bbox sides must be at least ${MIN_SIDE_DEGREES} degree`);
    else if (e - w > MAX_SIDE_DEGREES || n - s > MAX_SIDE_DEGREES) errors.push(`bbox sides must be at most ${MAX_SIDE_DEGREES} degrees`);
    else bbox = parts.map((v) => round(v, 2));
  }
  let horizonDays = DEFAULT_HORIZON_DAYS;
  const raw = params.get('horizonDays');
  if (raw !== null && raw !== '') {
    horizonDays = Number(raw);
    if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > MAX_HORIZON_DAYS) errors.push(`horizonDays must be an integer 1-${MAX_HORIZON_DAYS}`);
  }
  return errors.length ? { errors } : { value: { bbox, horizonDays } };
}

/** Whole-degree cell size that keeps the grid at most MAX_CELLS_PER_SIDE cells along its longer side. */
export const cellSizeFor = ([w, s, e, n]) => Math.max(1, Math.ceil(Math.max(e - w, n - s) / MAX_CELLS_PER_SIDE));

/** "30 km WSW of Lata, Solomon Islands" -> "Lata, Solomon Islands". */
export const placeName = (place) => (typeof place === 'string' && place.trim() ? place.replace(/^.*?\bof\s+/i, '').trim() : null);

/** Chance of at least one event in `days` at a constant `ratePerDay` (Poisson). */
export const chanceOfAtLeastOne = (ratePerDay, days) => 1 - Math.exp(-ratePerDay * days);

export const likelihoodLabel = (p) => (p >= 0.5 ? 'elevated' : p >= 0.15 ? 'moderate' : 'low');

/**
 * Pure outlook numbers. `quakes` are normalized USGS earthquakes inside `bbox` from the last `lookbackDays`.
 * M6+ uses the Gutenberg-Richter relation with b = 1: ten times fewer events per magnitude unit.
 */
export function buildOutlook({ bbox, quakes, horizonDays = DEFAULT_HORIZON_DAYS, lookbackDays = LOOKBACK_DAYS, now = Date.now() }) {
  const [w, s] = bbox;
  const size = cellSizeFor(bbox);
  const cells = new Map();
  for (const q of quakes) {
    if (q.longitude < bbox[0] || q.longitude > bbox[2] || q.latitude < bbox[1] || q.latitude > bbox[3]) continue;
    const col = Math.floor((q.longitude - w) / size);
    const row = Math.floor((q.latitude - s) / size);
    const id = `${col}_${row}`;
    if (!cells.has(id)) cells.set(id, { id, col, row, count: 0, maxMagnitude: 0, strongest: null, latest: null });
    const cell = cells.get(id);
    cell.count += 1;
    if (q.magnitude > cell.maxMagnitude) {
      cell.maxMagnitude = q.magnitude;
      cell.strongest = q;
    }
    if (!cell.latest || q.time > cell.latest.time) cell.latest = q;
  }
  const m6Factor = 10 ** -(6 - MIN_MAGNITUDE);
  const out = [...cells.values()].map((c) => {
    const west = w + c.col * size;
    const south = s + c.row * size;
    const box = [west, south, Math.min(west + size, bbox[2]), Math.min(south + size, bbox[3])].map((v) => round(v, 2));
    const ratePerDay = c.count / lookbackDays;
    const probability = chanceOfAtLeastOne(ratePerDay, horizonDays);
    return {
      id: c.id,
      bbox: box,
      center: [round((box[0] + box[2]) / 2, 3), round((box[1] + box[3]) / 2, 3)],
      label: placeName(c.strongest?.place) ?? `${round(c.strongest.latitude, 1)}, ${round(c.strongest.longitude, 1)}`,
      count: c.count,
      maxMagnitude: c.maxMagnitude,
      latest: { time: c.latest.time, magnitude: c.latest.magnitude, title: c.latest.title },
      ratePerDay: round(ratePerDay, 5),
      probability: round(probability),
      probabilityM6: round(chanceOfAtLeastOne(ratePerDay * m6Factor, horizonDays)),
      likelihood: likelihoodLabel(probability),
    };
  });
  out.sort((a, b) => b.probability - a.probability || b.maxMagnitude - a.maxMagnitude);
  return {
    horizonDays,
    window: { start: isoDay(now), end: isoDay(now + horizonDays * DAY_MS) },
    basis: { source: 'USGS ANSS ComCat', lookbackDays, minMagnitude: MIN_MAGNITUDE, count: out.reduce((a, c) => a + c.count, 0), cellSizeDegrees: size },
    cells: out,
  };
}

/** One scenario per top cell. The numbers and a plain sentence are fixed here; AI may reword title and summary. */
export function baseScenarios(outlook) {
  return outlook.cells.slice(0, MAX_SCENARIOS).map((c) => ({
    id: `scenario-${c.id}`,
    cellId: c.id,
    type: 'earthquake',
    title: `Possible M${MIN_MAGNITUDE}+ earthquake near ${c.label}`,
    likelihood: c.likelihood,
    probability: c.probability,
    window: outlook.window,
    basis: `${c.count} M${MIN_MAGNITUDE}+ earthquake${c.count === 1 ? '' : 's'} in this cell in the past ${outlook.basis.lookbackDays} days, the largest M${c.maxMagnitude.toFixed(1)}.`,
    summary: `At the past year's rate there is about a ${Math.round(c.probability * 100)}% chance of at least one M${MIN_MAGNITUDE}+ earthquake here by ${outlook.window.end}, and about ${Math.max(1, Math.round(c.probabilityM6 * 100))}% or less for M6+.`,
    aiGenerated: false,
  }));
}

export function buildScenarioMessages(agent, outlook, scenarios) {
  const cells = scenarios.map((sc) => {
    const c = outlook.cells.find((x) => x.id === sc.cellId);
    return { cell: c.id, place: c.label, quakesPastYear: c.count, largestMagnitude: c.maxMagnitude, latest: c.latest, chanceM45: c.probability, chanceM6: c.probabilityM6, likelihood: c.likelihood };
  });
  return [
    {
      role: 'system',
      content:
        `${systemPromptFor(agent)} You are given a statistical earthquake outlook: per map cell, how many M4.5+ earthquakes happened in the past year and the resulting chance of at least one in the coming window. ` +
        'For each cell write one hypothetical future scenario: a short title (at most 9 words) and a 2-sentence summary of what could plausibly happen and what NISAR radar could then measure (ground deformation, landslides). ' +
        'Use only the given numbers. Say "could" or "may", never "will". Do not give a date, a time or an exact magnitude. ' +
        'Answer with only a JSON array, one object per cell: [{"cell":"<cell id>","title":"...","summary":"..."}].',
    },
    { role: 'user', content: JSON.stringify({ window: outlook.window, cells }) },
  ];
}

/** Pull [{cell,title,summary}] out of a model reply; anything malformed is dropped. */
export function parseScenarioReply(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const list = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return list.filter((x) => x && typeof x.cell === 'string' && typeof x.title === 'string' && typeof x.summary === 'string' && x.title.trim() && x.summary.trim());
  } catch {
    return [];
  }
}

async function fetchPastYear(bbox, now, deps) {
  const url = buildUsgsUrl({ minMagnitude: MIN_MAGNITUDE, days: LOOKBACK_DAYS, bbox, now, limit: USGS_LIMIT });
  const body = await fetchJson(url, { fetchImpl: deps.fetch, label: 'USGS' });
  if (!body || !Array.isArray(body.features)) throw new EventError('USGS response missing features array', { retryable: true, code: 'upstream_error' });
  return body.features.map(normalizeQuake).filter(Boolean);
}

/** The outlook for a region. An AI failure never fails the request: the plain scenarios are returned instead. */
export async function seismicOutlook(env, { bbox, horizonDays }, deps = {}) {
  const now = deps.now ?? Date.now();
  const quakes = await fetchPastYear(bbox, now, deps);
  const outlook = buildOutlook({ bbox, quakes, horizonDays, now });
  let scenarios = baseScenarios(outlook);
  let model = null;
  if (scenarios.length) {
    try {
      const agent = AGENTS.forecaster;
      const reply = await generateTextDetailed(env, buildScenarioMessages(agent, outlook, scenarios), {
        model: agentModel(env, agent),
        pinned: agentPinned(env, agent),
        useCase: 'forecast',
        maxTokens: 500,
      });
      const written = new Map(parseScenarioReply(reply.text).map((x) => [x.cell, x]));
      scenarios = scenarios.map((sc) => {
        const ai = written.get(sc.cellId);
        return ai ? { ...sc, title: ai.title.trim().slice(0, 120), summary: ai.summary.trim().slice(0, 600), aiGenerated: true } : sc;
      });
      if (scenarios.some((sc) => sc.aiGenerated)) model = reply.model;
    } catch (err) {
      console.error('outlook scenarios failed', err.message);
    }
  }
  return {
    modeled: true,
    bbox,
    method: `Poisson rate per ${outlook.basis.cellSizeDegrees}-degree cell from M${MIN_MAGNITUDE}+ earthquakes in the past ${LOOKBACK_DAYS} days; M6+ scaled by Gutenberg-Richter with b = 1.`,
    ...outlook,
    scenarios,
    aiGenerated: scenarios.some((sc) => sc.aiGenerated),
    model,
    disclaimer: OUTLOOK_DISCLAIMER,
    credit: { supplementary: SUPPLEMENTARY_CREDIT.usgs },
  };
}
