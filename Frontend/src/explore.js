// explore.js — small helpers for the map's two modes: the Japan showcase shown
// to visitors who are signed out, and click-anywhere exploring for signed-in users.

// A little wider than Japan's islands so the whole chain fits on screen.
export const JAPAN_BBOX = [122.9, 24.0, 146.0, 45.7]

const STATUS_LABELS = {
  queued: 'Queued',
  processing: 'Processing',
  // The normal state today: the scene is found and catalogued, but no processor has turned it into map tiles yet.
  awaiting_processor: 'Catalogued · not processed into tiles yet',
  ready: 'Ready',
  failed: 'Processing failed',
  // Scenes found by a search and replayed without tracking them.
  preview: 'Preview from ASF · not tracked',
}

export const statusLabel = (status) => STATUS_LABELS[status] ?? String(status).replaceAll('_', ' ')

export const contains =(bbox, lng, lat) =>
  Boolean(bbox) && lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]

// Panning past the date line gives longitudes outside -180..180.
export const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180

/** Square search area [west, south, east, north] centred on a clicked point (default 1 degree across). */
export function areaAround(lng, lat, half = 0.5) {
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
  return [
    clamp(lng - half, -180, 180),
    clamp(lat - half, -85, 85),
    clamp(lng + half, -180, 180),
    clamp(lat + half, -85, 85),
  ].map((v) => Number(v.toFixed(4)))
}

/** The last `days` days, as YYYY-MM-DD strings. */
export function dateWindow(days = 90, now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
  return { start: iso(now - days * 86_400_000), end: iso(now) }
}

export function formatCoords(lng, lat) {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(3)}°${lng >= 0 ? 'E' : 'W'}`
}

// Positive for counter-clockwise rings.
function signedArea(ring) {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return sum / 2
}

/**
 * A world-sized polygon with the country cut out. Filled dark, it dims everything
 * except the country. MapLibre treats rings that wind the opposite way to the first
 * ring as holes, so each country ring is flipped if needed.
 */
export function worldMask(country) {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]] // counter-clockwise
  const polygons = country.features.flatMap((f) =>
    f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates],
  )
  const holes = polygons.map((p) => (signedArea(p[0]) > 0 ? [...p[0]].reverse() : p[0]))
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...holes] } }
}

// ---------- Date ranges ----------

/** NISAR launched on 2025-07-30: nothing earlier can have data. */
export const NISAR_LAUNCH = '2025-07-30'
/** The backend refuses searches that span more than this many days. */
export const MAX_SEARCH_DAYS = 366
export const DEFAULT_RANGE_MONTHS = 6

const DAY_MS = 86_400_000
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const addDays = (iso, days) => isoDay(Date.parse(iso) + days * DAY_MS)
export const spanDays = ({ start, end }) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS)

/** The last `months` months up to today, never starting before NISAR launched. */
export function lastMonths(months = DEFAULT_RANGE_MONTHS, now = Date.now()) {
  const from = new Date(now)
  from.setUTCMonth(from.getUTCMonth() - months)
  return { start: isoDay(from.getTime()) < NISAR_LAUNCH ? NISAR_LAUNCH : isoDay(from.getTime()), end: isoDay(now) }
}

/** Everything since launch (only for lists, since a search cannot span that long). */
export const sinceLaunch = (now = Date.now()) => ({ start: NISAR_LAUNCH, end: isoDay(now) })

/**
 * Change one end of a range. Dates stay between launch and today, the start never passes
 * the end, and with `maxSpan` the other end gives way when the range would get too long.
 */
export function setRangeEnd(range, key, value, { maxSpan, now = Date.now() } = {}) {
  const today = isoDay(now)
  const v = value < NISAR_LAUNCH ? NISAR_LAUNCH : value > today ? today : value
  let { start, end } = range
  if (key === 'start') {
    start = v
    if (start > end) end = start
    if (maxSpan && spanDays({ start, end }) > maxSpan) end = addDays(start, maxSpan) > today ? today : addDays(start, maxSpan)
    if (maxSpan && spanDays({ start, end }) > maxSpan) start = addDays(end, -maxSpan)
  } else {
    end = v
    if (end < start) start = end
    if (maxSpan && spanDays({ start, end }) > maxSpan) start = addDays(end, -maxSpan)
  }
  return { start, end }
}

/** True when the event's own dates (if it has any) touch the range. */
export const overlapsRange = (event, { start, end }) => {
  const from = event.startDate?.slice(0, 10)
  const to = event.endDate?.slice(0, 10)
  return !from || !to || (from <= end && to >= start)
}

/** The quake's date, read from the description the backend writes for earthquake events. */
export const quakeDay = (event) =>
  event?.type === 'earthquake' ? (event.description?.match(/\((\d{4}-\d{2}-\d{2})T/)?.[1] ?? null) : null

/** Signed-out visitors only see events centred in Japan. */
export const centreInJapan = (e) =>
  Boolean(e.bbox) && contains(JAPAN_BBOX, (e.bbox[0] + e.bbox[2]) / 2, (e.bbox[1] + e.bbox[3]) / 2)

// ---------- Processed map layers ----------

// What the processor (backend/cloudefare/processor) draws, in the order to offer it.
export const LAYERS = {
  gunw_unwrapped_phase: {
    label: 'Unwrapped phase',
    style: 'diverging',
    low: 'below the area’s median',
    high: 'above the area’s median',
    note: 'Phase change between two passes, relative to the area’s median. Each full 2π cycle is about half a radar wavelength (roughly 12 cm) of motion along the line of sight.',
  },
  gunw_coherence: {
    label: 'Coherence',
    style: 'coherence',
    low: 'poorly matched (0)',
    high: 'well matched (1)',
    note: 'How well the two passes match. Low coherence means the interferogram there is unreliable.',
  },
  gcov_hh_db: { label: 'HH backscatter', style: 'gray', low: 'weaker return', high: 'stronger return', note: 'Radar return in decibels, scaled to the area.' },
  gcov_vv_db: { label: 'VV backscatter', style: 'gray', low: 'weaker return', high: 'stronger return', note: 'Radar return in decibels, scaled to the area.' },
  gcov_hv_db: { label: 'HV backscatter', style: 'gray', low: 'weaker return', high: 'stronger return', note: 'Cross-polarized return in decibels, scaled to the area.' },
  gcov_vh_db: { label: 'VH backscatter', style: 'gray', low: 'weaker return', high: 'stronger return', note: 'Cross-polarized return in decibels, scaled to the area.' },
}

export const layerLabel = (id) => LAYERS[id]?.label ?? String(id).replaceAll('_', ' ')

/** The layer ids an event has, best first (the order of LAYERS, then anything else alphabetically). */
export function orderLayers(layers) {
  const ids = [...new Set((layers ?? []).map((l) => l.layer))]
  const rank = (id) => (id in LAYERS ? Object.keys(LAYERS).indexOf(id) : 99)
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}
