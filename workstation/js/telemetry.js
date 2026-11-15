// telemetry.js — TelemetryService: timelines, procedural rasters, external PNG
// loading, pixel sampling and change images. No DOM except offscreen canvases,
// and nothing touches `document` at import time. Every raster produced here is
// SYNTHETIC: pixel values are display intensities, not calibrated units.

import { CONFIG, HAZARD_REGISTRY, COAST, getHazard, timelineOf, forecastsOf, mulberry32, seedFrom, pointInRing } from './config.js';

export const RASTER_SIZE = 512;
export const SPECKLE_SEED = 0x5eed4a11;
export const CHANGE_THRESHOLD = 18;

export const ERROR_COPY = Object.freeze({
  assetSuffix: '. The raster is hidden; no synthetic image has been substituted.',
  backend: (msg) => `Live backend unavailable (${msg}). No data shown; mock data is not substituted.`,
});

const N = RASTER_SIZE * RASTER_SIZE;
const KM_PER_DEG_LAT = 110.57;
const TAU = Math.PI * 2;
const toRad = (deg) => (deg * Math.PI) / 180;
const kmPerDegLon = (lat) => 111.32 * Math.cos(toRad(lat));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* Shared tools: speckle, value noise, fbm                              */
/* ------------------------------------------------------------------ */

// The speckle field is generated ONCE per page and reused for every pass of
// every hazard, so that change images compare terrain, not grain.
const speckleCache = new Map();

/** ~4-look gamma multiplier, mean 1, from mulberry32(SPECKLE_SEED). */
function speckleField() {
  let S = speckleCache.get(SPECKLE_SEED);
  if (S) return S;
  const rng = mulberry32(SPECKLE_SEED);
  S = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Sum of 4 exponentials / 4 → Gamma(4, 1/4): mean 1, sd 0.5.
    let s = 0;
    for (let k = 0; k < 4; k++) s -= Math.log(1 - rng());
    S[i] = s * 0.25;
  }
  speckleCache.set(SPECKLE_SEED, S);
  return S;
}

/**
 * Seeded 2D value noise with smoothstep interpolation, plus fbm.
 * Lattice values and the permutation come from mulberry32(seed).
 */
function makeNoise(seed) {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rng();

  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const X = xi & 255;
    const Y = yi & 255;
    const r0 = perm[Y];
    const r1 = perm[Y + 1];
    const a = vals[perm[X + r0]];
    const b = vals[perm[X + 1 + r0]];
    const c = vals[perm[X + r1]];
    const d = vals[perm[X + 1 + r1]];
    const top = a + (b - a) * sx;
    const bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  }

  function fbm(x, y, octaves) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * f + o * 17.17, y * f + o * 31.31);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  return { noise, fbm };
}

/* ------------------------------------------------------------------ */
/* Projection helpers for a hazard's bounds box                         */
/* ------------------------------------------------------------------ */

function frameOf(bounds) {
  const midLat = (bounds.north + bounds.south) / 2;
  const kmLon = kmPerDegLon(midLat);
  const kmW = (bounds.east - bounds.west) * kmLon;
  const kmH = (bounds.north - bounds.south) * KM_PER_DEG_LAT;
  const W = RASTER_SIZE;
  return {
    bounds,
    W,
    kmLon,
    kmW,
    kmH,
    pxPerKmX: W / kmW,
    pxPerKmY: W / kmH,
    lngToX: (lng) => ((lng - bounds.west) / (bounds.east - bounds.west)) * W,
    latToY: (lat) => ((bounds.north - lat) / (bounds.north - bounds.south)) * W,
    xToLng: (x) => bounds.west + ((x + 0.5) / W) * (bounds.east - bounds.west),
    yToLat: (y) => bounds.north - ((y + 0.5) / W) * (bounds.north - bounds.south),
    // km east/north of the SW corner
    lngToKmX: (lng) => (lng - bounds.west) * kmLon,
    latToKmY: (lat) => (lat - bounds.south) * KM_PER_DEG_LAT,
  };
}

/** Distance (km) from (px, py) to a polyline given in km-space, plus the side (±1). */
function distanceToPolyline(px, py, line) {
  let best = Infinity;
  let side = 1;
  for (let i = 0; i + 1 < line.length; i++) {
    const ax = line[i][0];
    const ay = line[i][1];
    const bx = line[i + 1][0];
    const by = line[i + 1][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = clamp01(((px - ax) * dx + (py - ay) * dy) / len2);
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) {
      best = d;
      side = dx * (py - ay) - dy * (px - ax) >= 0 ? 1 : -1;
    }
  }
  return { d: best, side };
}

/* ------------------------------------------------------------------ */
/* Static fields, built once per hazard and cached                      */
/* ------------------------------------------------------------------ */

const staticCache = new Map();

function buildSarStatic(hazard) {
  const f = frameOf(hazard.bounds);
  const { W } = f;
  const g = hazard.geometry;
  const nz = makeNoise(seedFrom(`sar|${hazard.id}`));

  const terrain = new Float32Array(N);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) terrain[y * W + x] = nz.fbm(x / 48, y / 48, 5);
  }

  const base = new Float32Array(N); // 0..255 static intensity
  const fromVent = new Float32Array(N); // km
  const lobe = new Float32Array(N);
  const wobble = new Float32Array(N);

  const vx = f.lngToX(hazard.coords[0]);
  const vy = f.latToY(hazard.coords[1]);
  // A live simulation may omit the caldera (rimKm null) and the cones.
  const hasRim = Boolean(g.rimKm && g.calderaCentre);
  const cx = hasRim ? f.lngToX(g.calderaCentre[0]) : 0;
  const cy = hasRim ? f.latToY(g.calderaCentre[1]) : 0;
  const CAL_A = hasRim ? g.rimKm.a * f.pxPerKmX : 1;
  const CAL_B = hasRim ? g.rimKm.b * f.pxPerKmY : 1;
  const cones = (g.cones || []).map(([dLng, dLat, amp, sxKm, syKm]) => ({
    x: f.lngToX(hazard.coords[0] + dLng),
    y: f.latToY(hazard.coords[1] + dLat),
    amp,
    sx: sxKm * f.pxPerKmX,
    sy: syKm * f.pxPerKmY,
  }));
  const ashBearing = toRad(g.ashBearingDeg);

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = terrain[i];
      // West-looking sensor: ground rising toward the east faces the sensor → bright.
      const gx = terrain[i + (x < W - 1 ? 1 : 0)] - terrain[i - (x > 0 ? 1 : 0)];
      const shade = clamp(gx * 22, -0.6, 0.6);
      let v = (70 + 60 * t) * (1 + 0.5 * shade);

      if (hasRim) {
        // Somma rim: steep wall, bright, with asymmetric look-direction shading.
        const ex = (x - cx) / CAL_A;
        const ey = (y - cy) / CAL_B;
        const rim = Math.hypot(ex, ey);
        const bump = Math.exp(-((rim - 1) * (rim - 1)) / 0.006);
        const facing = rim > 1e-3 ? (-(rim - 1) * ex) / rim : 0; // > 0 faces west (sensor)
        v += 85 * bump * (1 + 0.6 * clamp(facing * 4, -1, 1));
        // Dark, smooth caldera floor.
        v -= 26 * Math.exp(-(rim * rim) / 0.35);
      }

      // Nakadake cone cluster, west flanks facing the sensor are brighter.
      for (let c = 0; c < cones.length; c++) {
        const k = cones[c];
        const dx = (x - k.x) / k.sx;
        const dy = (y - k.y) / k.sy;
        const e = Math.exp(-(dx * dx + dy * dy) / 0.6);
        v += k.amp * e * (1 - 0.45 * clamp(dx, -1, 1));
      }
      base[i] = v;

      const dxk = (x - vx) / f.pxPerKmX;
      const dyk = (y - vy) / f.pxPerKmY;
      fromVent[i] = Math.hypot(dxk, dyk);
      const bearing = Math.atan2(-(y - vy), x - vx); // screen y runs downward
      lobe[i] = 1 + 0.55 * Math.cos(bearing - ashBearing);
      wobble[i] = 0.65 + 0.7 * nz.fbm(x / 64 + 100, y / 64 + 100, 3);
    }
  }
  return { type: 'sar', base, fromVent, lobe, wobble, speckleStrength: 1 };
}

function buildInterferogramStatic(hazard) {
  const f = frameOf(hazard.bounds);
  const { W } = f;
  const g = hazard.geometry;
  const nz = makeNoise(seedFrom(`ifg|${hazard.id}`));
  // `land: null` (live simulation) treats the whole box as land.
  const land = g.land === undefined ? COAST.land : g.land;

  const terrain = new Float32Array(N);
  const coh = new Float32Array(N);
  const dist = new Float32Array(N); // km from fault
  const side = new Int8Array(N);
  const faultKm = g.fault.map(([lng, lat]) => [f.lngToKmX(lng), f.latToKmY(lat)]);

  for (let y = 0; y < W; y++) {
    const lat = f.yToLat(y);
    const kmy = (W - y - 0.5) * (f.kmH / W);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lng = f.xToLng(x);
      const kmx = (x + 0.5) * (f.kmW / W);
      terrain[i] = nz.fbm(x / 56, y / 56, 5);
      const onLand = !land || land.some((r) => pointInRing(lng, lat, r));
      coh[i] = onLand ? smoothstep(0.36, 0.64, nz.fbm(x / 40 + 7, y / 40 + 7, 4)) : 0;
      const r = distanceToPolyline(kmx, kmy, faultKm);
      dist[i] = r.d;
      side[i] = r.side;
    }
  }
  return { type: 'interferogram', terrain, coh, dist, side, speckleStrength: 0.55 };
}

function buildSshaStatic(hazard) {
  const f = frameOf(hazard.bounds);
  const { W } = f;
  const g = hazard.geometry;
  const nz = makeNoise(seedFrom(`ssha|${hazard.id}`));

  const land = new Uint8Array(N);
  const tex = new Float32Array(N); // land texture or ocean background, 0..255
  const dist = new Float32Array(N); // km to the Kyushu coast
  const coastKm = g.coast.map(([lng, lat]) => [f.lngToKmX(lng), f.latToKmY(lat)]);

  for (let y = 0; y < W; y++) {
    const lat = f.yToLat(y);
    const kmy = (W - y - 0.5) * (f.kmH / W);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lng = f.xToLng(x);
      const kmx = (x + 0.5) * (f.kmW / W);
      const onLand = g.land.some((r) => pointInRing(lng, lat, r));
      land[i] = onLand ? 1 : 0;
      if (onLand) {
        tex[i] = 28 + 36 * nz.fbm(x / 36, y / 36, 4);
        dist[i] = 0;
      } else {
        tex[i] = 118 + 14 * (nz.fbm(x / 90 + 3, y / 90 + 3, 3) - 0.5);
        dist[i] = distanceToPolyline(kmx, kmy, coastKm).d;
      }
    }
  }
  return { type: 'ssha', land, tex, dist, speckleStrength: 0.3 };
}

const STATIC_BUILDERS = {
  sar: buildSarStatic,
  interferogram: buildInterferogramStatic,
  ssha: buildSshaStatic,
};

function staticFor(hazard) {
  let st = staticCache.get(hazard.id);
  if (!st) {
    const build = STATIC_BUILDERS[hazard.raster];
    if (!build) throw new Error(`Unknown raster generator "${hazard.raster}" for ${hazard.id}`);
    st = build(hazard);
    staticCache.set(hazard.id, st);
  }
  return st;
}

/* ------------------------------------------------------------------ */
/* Per-pass generators: write clamp(static ⊕ change) × S into RGBA      */
/* ------------------------------------------------------------------ */

function ashRadiusKm(hazard, idx, count) {
  const g = hazard.geometry || {};
  const table = g.ashKm;
  if (table && count === table.length) return table[idx];
  const span = Math.max(1, count - 1);
  const [from, to] = Array.isArray(g.spreadKm) ? g.spreadKm : [0.8, 3.8];
  return from + (to - from) * (idx / span);
}

function renderSar(hazard, st, idx, count, out, S) {
  const g = hazard.geometry || {};
  const r = ashRadiusKm(hazard, idx, count);
  const rough = idx >= 3 ? (idx - 2) * 0.08 : 0;
  // Length scales default to the Aso demo; a live simulation scales them to its box.
  const edgeKm = g.edgeKm || 1.2;
  const ringKm = g.ringKm || 0.6;
  const ringW2 = g.ringWidthKm ? g.ringWidthKm * g.ringWidthKm : 0.03;
  const { base, fromVent, lobe, wobble } = st;
  for (let i = 0; i < N; i++) {
    let v = base[i];
    // Fresh ash smooths the ground, so less signal returns and it goes dark.
    const edge = clamp01((r * lobe[i] * wobble[i] - fromVent[i]) / edgeKm);
    v *= 1 - 0.78 * edge;
    if (rough > 0) {
      const d = fromVent[i] - ringKm;
      v += 160 * rough * Math.exp(-(d * d) / ringW2);
    }
    v = clamp(v, 0, 255) * S[i];
    const q = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    const o = i * 4;
    out[o] = q;
    out[o + 1] = q;
    out[o + 2] = q;
    out[o + 3] = 255;
  }
}

function renderInterferogram(hazard, st, idx, count, out, S) {
  const mainshock = (hazard.geometry && hazard.geometry.mainshockIndex) ?? 3;
  // Fringe count: interseismic creep, then a coseismic step, then slow creep.
  const fringes = idx < mainshock ? 0.35 + 0.1 * idx : 5 + 0.45 * (idx - mainshock);
  const kEast = TAU * fringes;
  const kWest = TAU * fringes * 0.72;
  const [decayE, decayW] = Array.isArray(hazard.geometry && hazard.geometry.decayKm) ? hazard.geometry.decayKm : [40, 28];
  const { terrain, coh, dist, side } = st;
  for (let i = 0; i < N; i++) {
    const d = dist[i];
    const c = coh[i];
    // Modelled LOS displacement decays away from the trace; wrapped phase of it.
    const disp = side[i] > 0 ? Math.exp(-d / decayE) : Math.exp(-d / decayW);
    const phase = (side[i] > 0 ? kEast : kWest) * disp;
    const fringe = 0.5 + 0.5 * Math.cos(phase);
    let v = (35 + 70 * terrain[i]) * (1 - 0.65 * c) + c * 200 * fringe;
    v = clamp(v, 0, 255) * S[i];
    const q = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    const o = i * 4;
    out[o] = q;
    out[o + 1] = q;
    out[o + 2] = q;
    out[o + 3] = 255;
  }
}

function renderSsha(hazard, st, idx, count, out, S) {
  const span = Math.max(1, count - 1);
  const t = idx / span;
  const k = (hazard.geometry && hazard.geometry.kmScale) || 1; // 1 = the Kyushu demo box
  const front = (100 - 75 * t) * k; // km from the coast; the crest advances shoreward
  const amp = 64 * (1 + 0.45 * t); // shoaling
  const envW2 = 22 * 22 * k * k;
  const { land, tex, dist } = st;
  for (let i = 0; i < N; i++) {
    let v = tex[i];
    if (!land[i]) {
      const d = dist[i];
      const lambda = (14 + 0.1 * d / k) * k;
      const env = Math.exp(-((d - front) * (d - front)) / envW2);
      v += amp * env * Math.sin((TAU * (d - front)) / lambda);
    }
    v = clamp(v, 0, 255) * S[i];
    const q = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    const o = i * 4;
    out[o] = q;
    out[o + 1] = q;
    out[o + 2] = q;
    out[o + 3] = 255;
  }
}

const RENDERERS = { sar: renderSar, interferogram: renderInterferogram, ssha: renderSsha };

/** Speckle scaled per raster type (altimetry carries far less grain than SAR). */
const scaledSpeckleCache = new Map();
function speckleFor(strength) {
  const S = speckleField();
  if (strength === 1) return S;
  let out = scaledSpeckleCache.get(strength);
  if (!out) {
    out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = 1 + (S[i] - 1) * strength;
    scaledSpeckleCache.set(strength, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                       */
/* ------------------------------------------------------------------ */

function createCanvas(width, height) {
  if (typeof document === 'undefined') throw new Error('Canvas unavailable: no document in this environment');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Separable 3×3 box blur of the red channel → Float32Array. */
function boxBlur3(imageData) {
  const w = imageData.width;
  const h = imageData.height;
  const src = imageData.data;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : x;
      const xr = x < w - 1 ? x + 1 : x;
      tmp[row + x] = (src[(row + xl) * 4] + src[(row + x) * 4] + src[(row + xr) * 4]) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : y;
    const yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = (tmp[yu * w + x] + tmp[y * w + x] + tmp[yd * w + x]) / 3;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

export class TelemetryService {
  /**
   * @param {object} config   usually CONFIG
   * @param {object} registry usually HAZARD_REGISTRY
   */
  constructor(config = CONFIG, registry = HAZARD_REGISTRY) {
    this.config = config;
    this.registry = registry;
    this.rasterCache = new Map(); // `${hazard}|${date}` → Promise<raster>
    this.timelines = new Map(); // hazardId → last timeline handed out
  }

  hazard(hazardId) {
    const hazard = (this.registry && this.registry[hazardId]) || getHazard(hazardId);
    if (!hazard) throw new Error(`Unknown hazard "${hazardId}"`);
    return hazard;
  }

  /** Observed steps for a hazard: from the live timeline if one was fetched, else the registry. */
  observedSteps(hazardId) {
    const tl = this.timelines.get(hazardId);
    if (tl) return tl.filter((s) => s.kind === 'observed');
    return this.hazard(hazardId).observed.map((o, i) => ({ ...o, kind: 'observed', index: i }));
  }

  /**
   * Registry timeline, or a fetched one when useLiveBackend is on.
   * Throws (with the spec error copy) on any backend failure. Never falls back.
   */
  async getTimeline(hazardId) {
    const hazard = this.hazard(hazardId);
    let timeline;
    if (this.config.useLiveBackend) {
      const url = String(this.config.backendUrl).replace('{id}', encodeURIComponent(hazardId));
      let payload;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        payload = await res.json();
      } catch (err) {
        throw new Error(ERROR_COPY.backend(err && err.message ? err.message : 'request failed'));
      }
      timeline = normaliseTimeline(payload, hazard);
      if (!timeline) throw new Error(ERROR_COPY.backend('malformed timeline payload'));
    } else {
      timeline = timelineOf(hazard);
    }
    this.timelines.set(hazardId, timeline);
    return timeline;
  }

  /**
   * → { canvas, imageData, url, source:'procedural'|'external' }, cached by
   * `${hazard}|${date}`. Only observed passes have rasters; forecast indices throw.
   */
  getRaster(hazardId, dateIndex) {
    const hazard = this.hazard(hazardId);
    const observed = this.observedSteps(hazardId);
    const step = observed[dateIndex];
    if (!step) {
      return Promise.reject(new Error(`No satellite pass at index ${dateIndex} for ${hazardId}`));
    }
    const key = `${hazardId}|${step.date}`;
    const cached = this.rasterCache.get(key);
    if (cached) return cached;
    const job = this.config.useExternalImages
      ? loadExternal(this.config, hazard, step.date)
      : Promise.resolve().then(() => procedural(hazard, dateIndex, observed.length));
    job.catch(() => this.rasterCache.delete(key));
    this.rasterCache.set(key, job);
    return job;
  }

  /** Red-channel intensity 0..1 at lng/lat, or null when outside the bounds. */
  sample(imageData, bounds, lng, lat) {
    if (!imageData || !bounds) return null;
    if (!(lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north)) return null;
    const w = imageData.width;
    const h = imageData.height;
    const x = Math.floor(((lng - bounds.west) / (bounds.east - bounds.west)) * w);
    const y = Math.floor(((bounds.north - lat) / (bounds.north - bounds.south)) * h);
    const cx = Math.min(w - 1, Math.max(0, x));
    const cy = Math.min(h - 1, Math.max(0, y));
    return imageData.data[(cy * w + cx) * 4] / 255;
  }

  /**
   * Change image (data URL): blue where the current pass is darker than the
   * baseline, orange where brighter, transparent where |d| < 18. Full resolution.
   */
  changeImage(baseData, currentData, isSame) {
    const w = (baseData && baseData.width) || (currentData && currentData.width) || RASTER_SIZE;
    const h = (baseData && baseData.height) || (currentData && currentData.height) || RASTER_SIZE;
    const canvas = createCanvas(w, h);
    if (isSame || !baseData || !currentData) return canvas.toDataURL('image/png'); // fresh canvas = transparent
    if (baseData.width !== currentData.width || baseData.height !== currentData.height) {
      throw new Error('Change image inputs differ in size');
    }
    const ctx = canvas.getContext('2d');
    const a = boxBlur3(baseData);
    const b = boxBlur3(currentData);
    const out = ctx.createImageData(w, h);
    const d = out.data;
    for (let i = 0; i < a.length; i++) {
      const diff = b[i] - a[i];
      const mag = diff < 0 ? -diff : diff;
      if (mag < CHANGE_THRESHOLD) continue;
      const o = i * 4;
      if (diff < 0) {
        d[o] = 43;
        d[o + 1] = 131;
        d[o + 2] = 255;
      } else {
        d[o] = 255;
        d[o + 1] = 140;
        d[o + 2] = 40;
      }
      d[o + 3] = Math.min(255, 70 + mag * 2.2);
    }
    ctx.putImageData(out, 0, 0);
    return canvas.toDataURL('image/png');
  }
}

/* ------------------------------------------------------------------ */
/* Raster producers                                                     */
/* ------------------------------------------------------------------ */

/** Exported for js/simulate.js (the live channel's labelled simulated illustration). */
export function procedural(hazard, dateIndex, count) {
  const st = staticFor(hazard);
  const render = RENDERERS[st.type];
  const S = speckleFor(st.speckleStrength);
  const canvas = createCanvas(RASTER_SIZE, RASTER_SIZE);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(RASTER_SIZE, RASTER_SIZE);
  render(hazard, st, dateIndex, count, imageData.data, S);
  ctx.putImageData(imageData, 0, 0);
  return { canvas, imageData, url: canvas.toDataURL('image/png'), source: 'procedural' };
}

function loadExternal(config, hazard, date) {
  const url = String(config.externalImagePath).replace('{date}', date).replace('{hazard}', hazard.id);
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error(`Could not load ${url}`));
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('empty image');
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        resolve({ canvas, imageData, url, source: 'external' });
      } catch (err) {
        reject(new Error(`Could not load ${url}`));
      }
    };
    img.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* Backend payload normalisation                                        */
/* ------------------------------------------------------------------ */

function normaliseTimeline(payload, hazard) {
  if (!payload || typeof payload !== 'object') return null;
  let observed;
  let forecast;
  if (Array.isArray(payload)) {
    observed = payload.filter((s) => s && s.kind !== 'forecast');
    forecast = payload.filter((s) => s && s.kind === 'forecast');
  } else {
    observed = Array.isArray(payload.observed) ? payload.observed : null;
    forecast = Array.isArray(payload.forecast) ? payload.forecast : [];
  }
  if (!observed || !observed.length) return null;
  const obs = observed.map((o, i) => {
    if (!o || typeof o.date !== 'string') return null;
    return { date: o.date, risk: Number(o.risk), kind: 'observed', index: i };
  });
  if (obs.some((o) => o === null)) return null;
  // CONFIG.forecasts as an array overrides the backend's forecast list too.
  const fcSource = Array.isArray(CONFIG.forecasts) ? forecastsOf(hazard) : forecast;
  const fc = fcSource.map((f, i) => {
    if (!f || typeof f.date !== 'string') return null;
    return {
      date: f.date,
      probability: Number(f.probability),
      driver: typeof f.driver === 'string' ? f.driver : 'Simulated driver: none supplied by the backend.',
      kind: 'forecast',
      index: obs.length + i,
    };
  });
  if (fc.some((f) => f === null)) return null;
  return [...obs, ...fc];
}
