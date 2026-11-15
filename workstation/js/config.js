// config.js — CONFIG + HAZARD_REGISTRY (pure data plus tiny pure helpers).
// No DOM. Imports nothing. Everything in here is SYNTHETIC DEMONSTRATION
// MATERIAL: dates are design specimens, risk values and probabilities are
// placeholders, and every extent is schematic. Nothing here is a hazard map.

const DEFAULTS = {
  useExternalImages: false,          // true → load PNGs from externalImagePath; failures show #asset-error, no fallback
  useLiveBackend: false,             // true → fetch timelines from backendUrl; failures show #map-error, no fallback
  backendUrl: '/api/v1/hazards/{id}/timeline',
  externalImagePath: './data/aso/{date}.png',
  basemapStyle: 'https://tiles.openfreemap.org/styles/liberty',
  bounds: { west: 130.98, south: 32.79, east: 131.23, north: 32.97 }, // APPROXIMATE demo box for volcano
  forecasts: undefined,              // undefined → use registry; [] → no forecast dates for every hazard
  defaultHazard: 'volcano',
  playIntervalMs: 1000,
  forecastOpacity: 0.35,             // locked; documented here so it is visible, never user-adjustable
  levelThresholds: { medium: 0.35, high: 0.6 }, // DEMONSTRATION ONLY, not official categories
};

const OVERRIDES =
  typeof window !== 'undefined' && window.SPACEAPP_CONFIG && typeof window.SPACEAPP_CONFIG === 'object'
    ? window.SPACEAPP_CONFIG
    : {};

// forecastOpacity is re-pinned after the merge: the UI copy ("LOCKED: 35%",
// the legend) states this value, so an override would make it a false claim.
export const CONFIG = { ...DEFAULTS, ...OVERRIDES, forecastOpacity: DEFAULTS.forecastOpacity };

/* ------------------------------------------------------------------ */
/* Dates (design specimens, 12 days apart, not the system clock)        */
/* ------------------------------------------------------------------ */

const OBSERVED_DATES = ['2026-04-21', '2026-05-03', '2026-05-15', '2026-05-27', '2026-06-08', '2026-06-20'];
const FORECAST_DATES = ['2026-07-02', '2026-07-14', '2026-07-26', '2026-08-07'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseIso(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { y: Number(m[1]), m: month, d: Number(m[3]) };
}

/** '2026-06-20' → '20 JUN 2026' */
export function formatDate(iso) {
  const p = parseIso(iso);
  if (!p) return String(iso ?? '').toUpperCase();
  return `${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** '2026-06-20' → '20 JUN' */
export function formatShort(iso) {
  const p = parseIso(iso);
  if (!p) return String(iso ?? '').toUpperCase();
  return `${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1]}`;
}

/** '2026-06-20' → '20 Jun 2026' (sentence case, for live-region announcements) */
export function formatSpoken(iso) {
  const p = parseIso(iso);
  if (!p) return String(iso ?? '');
  const mon = MONTHS[p.m - 1];
  return `${p.d} ${mon[0]}${mon.slice(1).toLowerCase()} ${p.y}`;
}

export const DATES = Object.freeze({
  observed: OBSERVED_DATES.slice(),
  forecast: FORECAST_DATES.slice(),
  stepDays: 12,
  now: OBSERVED_DATES[OBSERVED_DATES.length - 1],
  formatDate,
  formatShort,
  formatSpoken,
});

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                             */
/* ------------------------------------------------------------------ */

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string, for turning 'hazard|date' into a seed. */
export function seedFrom(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Approximate standard normal from three uniforms (sd ≈ 1). */
function gauss(rng) {
  return (rng() + rng() + rng() - 1.5) * 2;
}

/* ------------------------------------------------------------------ */
/* Geodesy helpers (flat-earth, fine for a demo box)                     */
/* ------------------------------------------------------------------ */

const KM_PER_DEG_LAT = 110.57;
const toRad = (deg) => (deg * Math.PI) / 180;
const kmPerDegLon = (lat) => 111.32 * Math.cos(toRad(lat));

/** Width × height of a bounds box in km using 111.32·cos(lat) and 110.57. */
export function footprintKm(bounds) {
  const midLat = (bounds.north + bounds.south) / 2;
  const widthKm = (bounds.east - bounds.west) * kmPerDegLon(midLat);
  const heightKm = (bounds.north - bounds.south) * KM_PER_DEG_LAT;
  return {
    widthKm,
    heightKm,
    label: `${Math.round(widthKm)} × ${Math.round(heightKm)} KM`,
  };
}

/** [lng, lat] displaced by dx km east and dy km north. */
function offsetKm(center, dxKm, dyKm) {
  return [center[0] + dxKm / kmPerDegLon(center[1]), center[1] + dyKm / KM_PER_DEG_LAT];
}

/** Keep a coordinate inside the bounds, inset by a small margin. */
function clampToBounds(coord, bounds, marginDeg = 0.002) {
  return [
    Math.min(bounds.east - marginDeg, Math.max(bounds.west + marginDeg, coord[0])),
    Math.min(bounds.north - marginDeg, Math.max(bounds.south + marginDeg, coord[1])),
  ];
}

function insideBounds(coord, bounds) {
  return coord[0] >= bounds.west && coord[0] <= bounds.east && coord[1] >= bounds.south && coord[1] <= bounds.north;
}

/** Ray-cast point-in-polygon (ring = [[lng, lat], ...]). */
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function round5(v) {
  return Math.round(v * 1e5) / 1e5;
}

/**
 * A smooth, wrap-around multiplier array with mean ≈ 1, so rings read as
 * something derived from data rather than a drawn circle.
 */
function smoothBumps(rng, n, wobble) {
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = 1 + wobble * gauss(rng);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += raw[(i + k + n) % n];
    out[i] = s / 9;
  }
  return out;
}

/** An irregular ring polygon around a centre at radiusKm. */
function ringPolygon(center, radiusKm, rng, bounds, n = 72, wobble = 0.2) {
  const bumps = smoothBumps(rng, n, wobble);
  const coords = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radiusKm * bumps[i];
    const c = clampToBounds(offsetKm(center, r * Math.cos(a), r * Math.sin(a)), bounds);
    coords.push([round5(c[0]), round5(c[1])]);
  }
  coords.push(coords[0]);
  return [coords];
}

/** An irregular ellipse (semi-axes in km) rotated by strikeDeg from east. */
function ellipsePolygon(center, aKm, bKm, strikeDeg, rng, bounds, n = 72, wobble = 0.1) {
  const bumps = smoothBumps(rng, n, wobble);
  const cs = Math.cos(toRad(strikeDeg));
  const sn = Math.sin(toRad(strikeDeg));
  const coords = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ex = aKm * Math.cos(t) * bumps[i];
    const ey = bKm * Math.sin(t) * bumps[i];
    const dx = ex * cs - ey * sn;
    const dy = ex * sn + ey * cs;
    const c = clampToBounds(offsetKm(center, dx, dy), bounds);
    coords.push([round5(c[0]), round5(c[1])]);
  }
  coords.push(coords[0]);
  return [coords];
}

function feature(geometry, properties) {
  return { type: 'Feature', properties, geometry };
}

/* ------------------------------------------------------------------ */
/* Shared approximate coastlines (lng/lat). APPROXIMATE, hand-placed.    */
/* Used by the tsunami extents, the tsunami land mask and the seismic   */
/* coherence mask. Not a cartographic product.                          */
/* ------------------------------------------------------------------ */

const KYUSHU_COAST = [
  [131.38, 31.45], [131.36, 31.6], [131.4, 31.75], [131.47, 31.9], [131.5, 32.05],
  [131.56, 32.2], [131.62, 32.33], [131.67, 32.45], [131.71, 32.6], [131.78, 32.72],
  [131.86, 32.85], [131.92, 32.97], [131.9, 33.08], [131.84, 33.16], [131.75, 33.22],
  [131.62, 33.3], [131.5, 33.34],
];

const KYUSHU_LAND = [[130.0, 31.3], ...KYUSHU_COAST, [130.0, 33.5], [130.0, 31.3]];

const SHIKOKU_LAND = [
  [133.0, 33.5], [132.62, 33.18], [132.52, 33.05], [132.5, 32.95], [132.6, 32.88],
  [132.72, 32.82], [133.0, 32.7], [133.0, 33.5],
];

export const COAST = Object.freeze({
  kyushu: KYUSHU_COAST,
  land: [KYUSHU_LAND, SHIKOKU_LAND],
});

/* ------------------------------------------------------------------ */
/* Level + timeline helpers                                             */
/* ------------------------------------------------------------------ */

/** Demonstration-only categorisation of a probability. */
export function levelFor(p) {
  const t = CONFIG.levelThresholds || DEFAULTS.levelThresholds;
  const v = Number(p);
  if (!Number.isFinite(v)) return 'low';
  if (v >= t.high) return 'high';
  if (v >= t.medium) return 'medium';
  return 'low';
}

/** The forecast list a hazard should use, honouring CONFIG.forecasts. */
export function forecastsOf(hazard) {
  if (Array.isArray(CONFIG.forecasts)) return CONFIG.forecasts;
  return hazard ? hazard.forecast : [];
}

/**
 * [...observed (kind:'observed'), ...forecast (kind:'forecast')].
 * CONFIG.forecasts: undefined → the registry list; an array → that array for
 * every hazard (so [] disables forecasting everywhere).
 */
export function timelineOf(hazard) {
  if (!hazard) return [];
  const observed = hazard.observed.map((o, i) => ({ ...o, kind: 'observed', index: i }));
  const forecast = forecastsOf(hazard).map((f, i) => ({
    ...f,
    kind: 'forecast',
    index: observed.length + i,
  }));
  return [...observed, ...forecast];
}

/* ------------------------------------------------------------------ */
/* Risk extents (schematic, deterministic, never a hazard map)          */
/* ------------------------------------------------------------------ */

/** Resolve (kind, idx) to the step that drives an extent's size. */
function stepFor(hazard, kind, idx) {
  const obs = hazard.observed;
  const fc = forecastsOf(hazard);
  const i = Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : obs.length - 1;
  if (kind === 'forecast' && fc.length) {
    const fi = Math.min(fc.length - 1, Math.max(0, i - obs.length));
    const f = fc[fi];
    return { kind: 'forecast', fi, date: f.date, p: Number(f.probability) || 0, oi: obs.length - 1 };
  }
  const oi = Math.min(obs.length - 1, i);
  const o = obs[oi];
  return { kind: 'observed', oi, date: o.date, p: Number(o.risk) || 0, fi: -1 };
}

function rngFor(hazard, date, salt = '') {
  return mulberry32(seedFrom(`${hazard.id}|${date}|${salt}`));
}

/** Volcano: two irregular rings around the vent. */
function volcanoExtents(hazard, kind, idx) {
  const s = stepFor(hazard, kind, idx);
  const span = Math.max(1, hazard.observed.length - 1);
  let highKm;
  let mediumKm;
  if (s.kind === 'observed') {
    const t = s.oi / span; // 0 → 1 over the observed passes
    highKm = 1.4 + 0.6 * t;
    mediumKm = 3.8 + 1.2 * t;
  } else {
    highKm = 1.2 + 2.8 * s.p;
    mediumKm = 3.2 + 5.5 * s.p;
  }
  const rng = rngFor(hazard, s.date, 'rings');
  const center = hazard.coords;
  const props = (risk) => ({ risk, schematic: true, kind: 'extent', date: s.date });
  return {
    type: 'FeatureCollection',
    features: [
      feature({ type: 'Polygon', coordinates: ringPolygon(center, mediumKm, rng, hazard.bounds) }, props('medium')),
      feature({ type: 'Polygon', coordinates: ringPolygon(center, highKm, rng, hazard.bounds) }, props('high')),
    ],
  };
}

/** Earthquake: two concentric MMI contours around the epicentre plus a fault trace. */
function earthquakeExtents(hazard, kind, idx) {
  const s = stepFor(hazard, kind, idx);
  const g = hazard.geometry;
  const mainshockAt = g.mainshockIndex;
  let high;
  let medium;
  if (s.kind === 'observed') {
    if (s.oi < mainshockAt) {
      // Pre-event: background seismicity only.
      high = { a: 9 + s.oi * 0.5, b: 5 + s.oi * 0.3 };
      medium = { a: 20 + s.oi, b: 12 + s.oi * 0.5 };
    } else {
      const k = s.oi - mainshockAt; // creeps after the coseismic step
      high = { a: 40 + 2 * k, b: 22 + k };
      medium = { a: 62 + 2 * k, b: 38 + k };
    }
  } else {
    high = { a: 18 + 32 * s.p, b: 10 + 18 * s.p };
    medium = { a: 30 + 46 * s.p, b: 18 + 28 * s.p };
  }
  const rng = rngFor(hazard, s.date, 'mmi');
  const center = hazard.coords;
  const props = (risk) => ({ risk, schematic: true, kind: 'extent', date: s.date });
  return {
    type: 'FeatureCollection',
    features: [
      feature(
        { type: 'Polygon', coordinates: ellipsePolygon(center, medium.a, medium.b, g.strikeDeg, rng, hazard.bounds) },
        props('medium'),
      ),
      feature(
        { type: 'Polygon', coordinates: ellipsePolygon(center, high.a, high.b, g.strikeDeg, rng, hazard.bounds) },
        props('high'),
      ),
      feature(
        { type: 'LineString', coordinates: g.fault.map((c) => clampToBounds(c, hazard.bounds)) },
        { kind: 'fault', schematic: true, date: s.date },
      ),
    ],
  };
}

/**
 * A band along a run of coast vertices: seaward edge offset by `seaKm`,
 * landward edge offset inland by `inlandKm × bump`.
 */
function coastBand(coast, from, to, inlandKm, seaKm, rng, bounds) {
  const pts = coast.slice(from, to + 1);
  const bumps = smoothBumps(rng, pts.length, 0.25);
  const normals = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const tx = (next[0] - prev[0]) * kmPerDegLon(p[1]);
    const ty = (next[1] - prev[1]) * KM_PER_DEG_LAT;
    const len = Math.hypot(tx, ty) || 1;
    let nx = ty / len;
    let ny = -tx / len;
    if (nx > 0) {
      nx = -nx;
      ny = -ny;
    } // inland is west of this coast
    return [nx, ny];
  });
  const sea = pts.map((p, i) => clampToBounds(offsetKm(p, -normals[i][0] * seaKm, -normals[i][1] * seaKm), bounds));
  const land = pts.map((p, i) => {
    const w = inlandKm * bumps[i];
    return clampToBounds(offsetKm(p, normals[i][0] * w, normals[i][1] * w), bounds);
  });
  const ring = [...sea, ...land.reverse()].map((c) => [round5(c[0]), round5(c[1])]);
  ring.push(ring[0]);
  return [ring];
}

/** Circular arc segments around a source, clipped to the sea inside the bounds. */
function arrivalArc(source, radiusKm, bounds, landRings, fromDeg = 95, toDeg = 265, n = 40) {
  const parts = [];
  let cur = [];
  for (let i = 0; i <= n; i++) {
    const a = toRad(fromDeg + ((toDeg - fromDeg) * i) / n);
    const c = offsetKm(source, radiusKm * Math.cos(a), radiusKm * Math.sin(a));
    const ok = insideBounds(c, bounds) && !landRings.some((r) => pointInRing(c[0], c[1], r));
    if (ok) {
      cur.push([round5(c[0]), round5(c[1])]);
    } else if (cur.length) {
      if (cur.length > 1) parts.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

/** Tsunami: coastal run-up bands plus wave-arrival arcs. */
function tsunamiExtents(hazard, kind, idx) {
  const s = stepFor(hazard, kind, idx);
  const g = hazard.geometry;
  const span = Math.max(1, hazard.observed.length - 1);
  let highKm;
  let mediumKm;
  let arcBase;
  if (s.kind === 'observed') {
    const t = s.oi / span;
    highKm = 1.5 + 1.5 * t;
    mediumKm = 3 + 3 * t;
    arcBase = 14 + 54 * t;
  } else {
    highKm = 2 + 6 * s.p;
    mediumKm = 4 + 10 * s.p;
    arcBase = 72 + 10 * s.fi;
  }
  const rng = rngFor(hazard, s.date, 'runup');
  const coast = g.coast;
  const props = (risk) => ({ risk, schematic: true, kind: 'extent', date: s.date });
  const features = [
    feature({ type: 'Polygon', coordinates: coastBand(coast, g.mediumRange[0], g.mediumRange[1], mediumKm, 1.5, rng, hazard.bounds) }, props('medium')),
    feature({ type: 'Polygon', coordinates: coastBand(coast, g.highRange[0], g.highRange[1], highKm, 1.5, rng, hazard.bounds) }, props('high')),
  ];
  for (let k = 0; k < 3; k++) {
    const r = arcBase - k * 9;
    if (r < 5) continue;
    const parts = arrivalArc(g.source, r, hazard.bounds, g.land);
    if (!parts.length) continue;
    features.push(
      feature(
        { type: 'MultiLineString', coordinates: parts },
        { kind: 'arrival', risk: 'medium', schematic: true, date: s.date, order: k },
      ),
    );
  }
  return { type: 'FeatureCollection', features };
}

const EXTENT_BUILDERS = { volcano: volcanoExtents, earthquake: earthquakeExtents, tsunami: tsunamiExtents };

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

function defineHazard(def) {
  const hazard = { ...def };
  const build = EXTENT_BUILDERS[def.id];
  hazard.riskExtents = (kind, idx) => build(hazard, kind, idx);
  return Object.freeze(hazard);
}

const obs = (risks) => OBSERVED_DATES.map((date, i) => ({ date, risk: risks[i] }));
const fc = (probs, drivers) => FORECAST_DATES.map((date, i) => ({ date, probability: probs[i], driver: drivers[i] }));

export const HAZARD_REGISTRY = Object.freeze({
  volcano: defineHazard({
    id: 'volcano',
    code: 'NISAR-L // VOLCANIC SAR',
    channelLabel: '01 // VOLCANIC SAR',
    targetName: 'ASO CALDERA, KUMAMOTO, JP',
    coords: [131.104, 32.884],
    zoom: 11.4,
    bounds: { ...CONFIG.bounds },
    primaryMetricLabel: 'Eruption / Unrest Probability',
    pointSeriesLabel: 'Brightness at a point',
    pointUnit: 'display intensity (synthetic, uncalibrated)',
    pointNoun: 'pixel brightness',
    changeLabels: { darker: 'darker than baseline', brighter: 'brighter than baseline' },
    riskLabels: { high: 'high hazard extent', medium: 'medium hazard extent' },
    raster: 'sar',
    observed: obs([0.12, 0.16, 0.22, 0.29, 0.37, 0.44]),
    forecast: fc(
      [0.48, 0.62, 0.81, 0.57],
      [
        'Simulated driver: continued caldera-floor darkening near Nakadake.',
        'Simulated driver: the ash lobe spreads beyond the central cone cluster.',
        'Simulated driver: modelled peak as deformation crosses the fitted threshold.',
        'Simulated driver: the source re-pressurises and the extent pulls back.',
      ],
    ),
    geometry: {
      // Caldera centre sits slightly west and north of the vent, so the cone
      // cluster reads "just east of centre". Somma rim ≈ 18 × 25 km.
      calderaCentre: [131.088, 32.896],
      rimKm: { a: 9, b: 12.5 },
      // Cone cluster as [dLng, dLat, amplitude, sxKm, syKm] around the vent.
      cones: [
        [0, 0, 72, 1.3, 0.9],
        [0.012, 0.006, 60, 1.0, 0.8],
        [-0.026, 0.012, 48, 0.9, 0.7],
        [-0.03, -0.012, 44, 0.8, 0.7],
        [0.072, 0.004, 52, 1.1, 0.8],
      ],
      ashBearingDeg: 55,
      ashKm: [0.8, 1.2, 1.7, 2.3, 3.0, 3.8],
    },
  }),

  earthquake: defineHazard({
    id: 'earthquake',
    code: 'ALOS-4 / USGS-SIM // SEISMIC INSAR',
    channelLabel: '02 // SEISMIC FAULT',
    targetName: 'HYUGANADA SUBDUCTION ZONE, JP',
    coords: [131.85, 32.15],
    zoom: 8.5,
    bounds: { west: 130.9, south: 31.5, east: 132.8, north: 32.8 },
    primaryMetricLabel: 'M6.0+ Aftershock Probability',
    pointSeriesLabel: 'Line-of-Sight (LOS) Ground Displacement',
    pointUnit: 'cm (synthetic, illustrative)',
    pointNoun: 'displacement',
    changeLabels: { darker: 'subsidence', brighter: 'uplift' },
    riskLabels: { high: 'MMI VII+', medium: 'MMI V–VI' },
    raster: 'interferogram',
    // Quiet, quiet, quiet, mainshock at pass 3, then Omori-style decay K/(c+t).
    observed: obs([0.05, 0.06, 0.07, 0.74, 0.56, 0.44]),
    forecast: fc(
      [0.37, 0.32, 0.28, 0.25],
      [
        'Simulated driver: Omori-style aftershock decay two passes after the modelled mainshock.',
        'Simulated driver: decay continues; modelled stress transfer stays on the northern segment.',
        'Simulated driver: aftershock rate approaches the pre-event background.',
        'Simulated driver: residual probability from the modelled slip patch.',
      ],
    ),
    geometry: {
      fault: [
        [131.55, 31.7], [131.74, 31.98], [131.88, 32.2], [132.02, 32.42], [132.15, 32.6],
      ],
      strikeDeg: 60.4,
      mainshockIndex: 3,
      coherenceSeed: 'coh',
    },
  }),

  tsunami: defineHazard({
    id: 'tsunami',
    code: 'SWOT / DART-SIM // TSUNAMI ALTIMETRY',
    channelLabel: '03 // TSUNAMI PROPAGATION',
    targetName: 'BUNGO CHANNEL & MIYAZAKI COAST, JP',
    coords: [132.1, 32.6],
    zoom: 8.2,
    bounds: { west: 131.4, south: 31.9, east: 132.8, north: 33.3 },
    primaryMetricLabel: 'Coastal Inundation Exceedance (>1m)',
    pointSeriesLabel: 'Sea-Surface Height Anomaly',
    pointUnit: 'cm (synthetic, illustrative)',
    pointNoun: 'sea-surface height',
    changeLabels: { darker: 'drawdown', brighter: 'crest elevation' },
    riskLabels: { high: 'run-up high', medium: 'run-up moderate' },
    raster: 'ssha',
    // Rising as the modelled wave train approaches; the forecast peaks then decays.
    observed: obs([0.04, 0.07, 0.11, 0.18, 0.27, 0.39]),
    forecast: fc(
      [0.58, 0.71, 0.46, 0.24],
      [
        'Simulated driver: leading crest reaches the Hyuga shelf in the propagation model.',
        'Simulated driver: modelled peak run-up along the Nobeoka–Saiki coast.',
        'Simulated driver: trailing wave train decays; channel resonance subsides.',
        'Simulated driver: residual anomaly below the exceedance threshold.',
      ],
    ),
    geometry: {
      coast: KYUSHU_COAST,
      land: COAST.land,
      // Index ranges into `coast` for the two run-up bands (inclusive).
      highRange: [6, 11],
      mediumRange: [3, 14],
      // Modelled offshore source for the arrival arcs.
      source: [132.35, 32.25],
    },
  }),
});

export const HAZARD_IDS = Object.freeze(Object.keys(HAZARD_REGISTRY));

/** Registry lookup; unknown ids return undefined. */
export function getHazard(id) {
  return HAZARD_REGISTRY[id];
}

/** The hazard CONFIG.defaultHazard names, or the volcano if it names nothing valid. */
export function defaultHazard() {
  return getHazard(CONFIG.defaultHazard) || HAZARD_REGISTRY.volcano;
}
