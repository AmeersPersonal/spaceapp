// explore.js — pure helpers for the LIVE channel: date ranges, areas, the
// live timeline built from an event's scenes or processed layers, and labels.
// No DOM, imports nothing. Ported from Frontend/src/explore.js (not imported).

/** A little wider than Japan's islands. */
export const JAPAN_BBOX = [122.9, 24.0, 146.0, 45.7];

/** NISAR launched on 2025-07-30: nothing earlier can have data. */
export const NISAR_LAUNCH = '2025-07-30';
/** The backend refuses searches that span more than this many days. */
export const MAX_SEARCH_DAYS = 366;

const DAY_MS = 86_400_000;

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const day = (iso) => String(iso || '').slice(0, 10);
const addDays = (iso, days) => isoDay(Date.parse(iso) + days * DAY_MS);
export const spanDays = ({ start, end }) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS);

/** The last `months` months up to today, never starting before NISAR launched. */
export function lastMonths(months = 6, now = Date.now()) {
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - months);
  const start = isoDay(from.getTime());
  return { start: start < NISAR_LAUNCH ? NISAR_LAUNCH : start, end: isoDay(now) };
}

/**
 * Change one end of a range. Dates stay between launch and today, the start
 * never passes the end, and with `maxSpan` the other end gives way.
 */
export function setRangeEnd(range, key, value, { maxSpan, now = Date.now() } = {}) {
  const today = isoDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return range;
  const v = value < NISAR_LAUNCH ? NISAR_LAUNCH : value > today ? today : value;
  let { start, end } = range;
  if (key === 'start') {
    start = v;
    if (start > end) end = start;
    if (maxSpan && spanDays({ start, end }) > maxSpan) end = addDays(start, maxSpan) > today ? today : addDays(start, maxSpan);
    if (maxSpan && spanDays({ start, end }) > maxSpan) start = addDays(end, -maxSpan);
  } else {
    end = v;
    if (end < start) start = end;
    if (maxSpan && spanDays({ start, end }) > maxSpan) start = addDays(end, -maxSpan);
  }
  return { start, end };
}

export const contains = (bbox, lng, lat) =>
  Array.isArray(bbox) && lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

/** Panning past the date line gives longitudes outside -180..180. */
export const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

/** Square search area [w, s, e, n] centred on a point (default 1° across). */
export function areaAround(lng, lat, half = 0.5) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return [
    clamp(lng - half, -180, 180),
    clamp(lat - half, -85, 85),
    clamp(lng + half, -180, 180),
    clamp(lat + half, -85, 85),
  ].map((v) => Number(v.toFixed(4)));
}

/** bbox [w,s,e,n] → { west, south, east, north } */
export const boundsOf = (bbox) => ({ west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] });

/** Union of the event's bbox and every scene footprint, as [w,s,e,n], or null. */
export function unionBounds(event, scenes = []) {
  const boxes = [event && event.bbox, ...scenes.map((s) => s && s.bounds)].filter(
    (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite),
  );
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/**
 * The region an outlook is computed for: the visible map, each side clamped
 * to the backend's 1–60° limits around its centre.
 */
export function outlookBoxFrom({ west, south, east, north }) {
  const fit = (lo, hi, min, max, floor, ceil) => {
    const c = (lo + hi) / 2;
    const half = Math.min(max, Math.max(min, hi - lo)) / 2;
    let a = c - half;
    let b = c + half;
    if (a < floor) { b += floor - a; a = floor; }
    if (b > ceil) { a -= b - ceil; b = ceil; }
    return [Number(a.toFixed(3)), Number(b.toFixed(3))];
  };
  const [w, e] = fit(wrapLng(west), wrapLng(west) + Math.max(0, east - west), 1, 60, -180, 180);
  const [s, n] = fit(south, north, 1, 60, -85, 85);
  return [w, s, e, n];
}

const STATUS_LABELS = {
  queued: 'Queued',
  processing: 'Processing',
  awaiting_processor: 'Catalogued · not processed into tiles yet',
  ready: 'Ready',
  failed: 'Processing failed',
  preview: 'Preview from ASF · not tracked',
};
export const statusLabel = (status) => STATUS_LABELS[status] || String(status || '').replaceAll('_', ' ');

/** What the processor draws, best first. */
export const LAYERS = {
  gunw_unwrapped_phase: { label: 'Unwrapped phase', note: 'Phase change between two passes, relative to the area median.' },
  gunw_coherence: { label: 'Coherence', note: 'How well the two passes match. Low coherence = unreliable interferogram.' },
  gcov_hh_db: { label: 'HH backscatter', note: 'Radar return in decibels, scaled to the area.' },
  gcov_vv_db: { label: 'VV backscatter', note: 'Radar return in decibels, scaled to the area.' },
  gcov_hv_db: { label: 'HV backscatter', note: 'Cross-polarized return in decibels, scaled to the area.' },
  gcov_vh_db: { label: 'VH backscatter', note: 'Cross-polarized return in decibels, scaled to the area.' },
};
export const layerLabel = (id) => (LAYERS[id] ? LAYERS[id].label : String(id).replaceAll('_', ' '));

/** Layer ids an event has, best first. */
export function orderLayers(layers) {
  const ids = [...new Set((layers || []).map((l) => l.layer))];
  const keys = Object.keys(LAYERS);
  const rank = (id) => (keys.includes(id) ? keys.indexOf(id) : 99);
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The live timeline for an event detail (or a replay shaped like one).
 * mode 'tiles'   — processed layer chosen and it has entries: one step per tile date
 * mode 'preview' — ASF browse images: one step per acquisition day that has a preview
 * mode 'area'    — nothing drawable: no steps
 * Every step is an observation (kind 'observed'): the live timeline never
 * carries forecast dates. Projections are shown separately, labelled modelled.
 */
export function liveTimeline(detail, layer) {
  if (!detail) return { mode: 'area', steps: [], layers: [] };
  const layers = orderLayers(detail.layers);
  const scenes = Array.isArray(detail.scenes) ? detail.scenes : [];
  const chosen = layer && layer !== 'preview' && layers.includes(layer) ? layer : null;
  if (chosen) {
    const entries = detail.layers.filter((l) => l.layer === chosen).sort((a, b) => (a.date < b.date ? -1 : 1));
    const steps = entries.map((t, i) => ({ date: day(t.date), kind: 'observed', index: i, tile: t, scenes: scenes.filter((s) => day(s.acquiredAt) === day(t.date)) }));
    if (steps.length) return { mode: 'tiles', steps, layers };
  }
  const preview = scenes.filter((s) => s && s.browseUrl && Array.isArray(s.bounds));
  const dates = [...new Set(preview.map((s) => day(s.acquiredAt)))].filter(Boolean).sort();
  const steps = dates.map((d, i) => ({ date: d, kind: 'observed', index: i, tile: null, scenes: preview.filter((s) => day(s.acquiredAt) === d) }));
  return { mode: steps.length ? 'preview' : 'area', steps, layers };
}

/** Never "0%" or "100%": a model cannot be that sure. */
export const percent = (p) => {
  const v = Number(p);
  if (!Number.isFinite(v)) return '—';
  return v < 0.01 ? '<1%' : v > 0.99 ? '>99%' : `${Math.round(v * 100)}%`;
};

/** '2026-10-01T…' → '01 OCT 2026' (UTC) */
export function formatDay(iso) {
  const d = day(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return '—';
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function formatLngLat(lng, lat) {
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(3)}° ${lng >= 0 ? 'E' : 'W'}`;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
