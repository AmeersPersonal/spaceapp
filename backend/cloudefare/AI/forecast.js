// Predictive analysis. The numbers are computed here, deterministically, from real NISAR-derived
// scene statistics (manifest.stats): an ordinary-least-squares trend per metric plus the observed
// acquisition cadence. The forecaster agent only narrates those numbers. Output is always labeled
// `modeled: true` so it is never mistaken for an observation.

import { AGENTS, agentModel, agentPinned, systemPromptFor } from './agents.js';
import { generateTextDetailed } from './AIGateway.js';
import { DATA_CREDIT } from '../dataManger.js';

export const PREDICTION_DISCLAIMER =
  'Modeled projection: a straight-line trend fitted to a small number of NISAR-derived scene statistics. It is not an observation and not a verified forecast.';
export const MIN_POINTS = 3;
export const MAX_HORIZON_DAYS = 90;
export const DEFAULT_HORIZON_DAYS = 30;
const DAY_MS = 86_400_000;

const dayNumber = (iso) => Math.floor(Date.parse(iso) / DAY_MS);
const isoDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export function parseHorizon(value) {
  if (value === undefined || value === null || value === '') return { value: DEFAULT_HORIZON_DAYS };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HORIZON_DAYS) return { error: `horizonDays must be an integer 1-${MAX_HORIZON_DAYS}` };
  return { value: n };
}

/** Finite numeric entries of a stats object: top level plus one nested level as "a.b". */
export function flattenStats(stats) {
  const out = {};
  for (const [k, v] of Object.entries(stats ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'number' && Number.isFinite(v2)) out[`${k}.${k2}`] = v2;
    }
  }
  return out;
}

/** Ordinary least squares on [{x, y}]. Needs at least 2 points with distinct x. */
export function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const slope = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  const intercept = my - slope * mx;
  const ssRes = points.reduce((a, p) => a + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const ssTot = points.reduce((a, p) => a + (p.y - my) ** 2, 0);
  return {
    slope,
    intercept,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    residualStd: n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0,
    n,
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function direction(fit, firstX, lastX) {
  const span = Math.abs(fit.slope) * (lastX - firstX);
  if (fit.r2 < 0.1 || span < 1e-9) return 'flat';
  return fit.slope > 0 ? 'increasing' : 'decreasing';
}

/** Pure forecast numbers. `sceneStats` is [{product, acquiredAt, stats}], `scenes` the catalog. */
export function buildForecast({ scenes, sceneStats, horizonDays }) {
  const days = [...new Set(scenes.map((s) => dayNumber(s.acquiredAt)))].sort((a, b) => a - b);
  const observations = {
    count: days.length,
    firstDate: days.length ? isoDay(days[0]) : null,
    lastDate: days.length ? isoDay(days.at(-1)) : null,
    cadenceDays: null,
    nextExpectedAcquisition: null,
  };
  if (days.length < 2) {
    return { status: 'insufficient_data', reason: 'At least 2 acquisition dates are needed.', observations, metrics: [], skipped: [] };
  }

  const cadence = median(days.slice(1).map((d, i) => d - days[i]));
  observations.cadenceDays = cadence;
  observations.nextExpectedAcquisition = isoDay(days.at(-1) + Math.max(1, Math.round(cadence)));

  const series = new Map();
  for (const s of sceneStats) {
    const x = dayNumber(s.acquiredAt);
    for (const [metric, y] of Object.entries(flattenStats(s.stats))) {
      const key = `${s.product}:${metric}`;
      if (!series.has(key)) series.set(key, { product: s.product, metric, points: new Map() });
      series.get(key).points.set(x, y); // one value per day
    }
  }

  const metrics = [];
  const skipped = [];
  const targetDay = days.at(-1) + horizonDays;
  for (const [key, { product, metric, points }] of series) {
    const pts = [...points].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);
    const fit = pts.length >= MIN_POINTS ? linearFit(pts) : null;
    if (!fit) {
      skipped.push(key);
      continue;
    }
    const projected = fit.intercept + fit.slope * targetDay;
    const band = 1.96 * fit.residualStd;
    metrics.push({
      key,
      product,
      metric,
      n: fit.n,
      slopePerDay: round(fit.slope, 6),
      r2: round(fit.r2, 3),
      latest: { date: isoDay(pts.at(-1).x), value: round(pts.at(-1).y) },
      projected: { date: isoDay(targetDay), value: round(projected), low: round(projected - band), high: round(projected + band) },
      direction: direction(fit, pts[0].x, pts.at(-1).x),
      // Never "high": a straight line through a handful of scenes is weak evidence.
      confidence: fit.n >= 6 && fit.r2 >= 0.7 ? 'moderate' : 'low',
    });
  }
  return { status: 'ok', observations, metrics, skipped };
}

export function buildForecastMessages(agent, event, forecast, captions, horizonDays) {
  const facts = {
    event: { id: event.id, name: event.name, type: event.type },
    horizonDays,
    observations: forecast.observations,
    trends: forecast.metrics,
    metricsWithTooFewPoints: forecast.skipped,
    sceneCaptions: captions.slice(0, 5).map((c) => c.text),
  };
  return [
    {
      role: 'system',
      content:
        `${systemPromptFor(agent)} Write a 3-5 sentence outlook. State the expected next NISAR acquisition date and describe each trend using only the given numbers, ` +
        'including its confidence and uncertainty band. If there are no trends, say the data cannot support a quantitative projection. Call it a projection, never an observation.',
    },
    { role: 'user', content: JSON.stringify(facts) },
  ];
}

export async function forecastEvent(env, { event, scenes, sceneStats, captions, horizonDays = DEFAULT_HORIZON_DAYS }) {
  const forecast = buildForecast({ scenes, sceneStats, horizonDays });
  const base = {
    eventId: event.id,
    modeled: true,
    horizonDays,
    method: 'Ordinary least squares per NISAR-derived scene statistic; cadence = median revisit interval.',
    ...forecast,
    disclaimer: PREDICTION_DISCLAIMER,
    credit: DATA_CREDIT,
  };
  if (forecast.status !== 'ok') return { ...base, narrative: null, aiGenerated: false };
  const agent = AGENTS.forecaster;
  const { text: narrative, model } = await generateTextDetailed(env, buildForecastMessages(agent, event, forecast, captions, horizonDays), {
    model: agentModel(env, agent),
    pinned: agentPinned(env, agent),
    useCase: 'forecast',
    maxTokens: 300,
  });
  return { ...base, narrative, agent: agent.id, model, aiGenerated: true };
}
