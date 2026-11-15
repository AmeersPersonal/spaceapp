// explore.js — small helpers for the map's two modes: the Japan showcase shown
// to visitors who are signed out, and click-anywhere exploring for signed-in users.

// A little wider than Japan's islands so the whole chain fits on screen.
export const JAPAN_BBOX = [122.9, 24.0, 146.0, 45.7]

export const contains = (bbox, lng, lat) =>
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
