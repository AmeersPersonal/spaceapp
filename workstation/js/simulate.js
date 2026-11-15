// simulate.js — the LIVE channel's "Simulated illustration": runs the demo
// channels' procedural generators on a live event's area, one frame per real
// NISAR pass date. EVERYTHING this module produces is FABRICATED: the terrain,
// the spreading lobe, the fringes, the wave train and the extents are invented
// for that box, not derived from the event's data. main.js only shows it behind
// the #live-sim toggle with the SIMULATED badge and #provenance-sim strip.
//
// Generator per event (backend EVENT_TYPES, plus name keywords):
//   volcano  'sar'           name mentions volcano/eruption: caldera + ash lobe
//   flood    'sar'           flood, wetland, forest, crop, soil_moisture: a dark
//                            spreading lobe (smooth water / changed surface reads
//                            dark in SAR), no caldera
//   quake    'interferogram' earthquake, glacier, other: fault + wrapped fringes
//   tsunami  'ssha'          name mentions tsunami/surge/coast: offshore wave train
//
// Imports config.js and telemetry.js only. No DOM except telemetry's canvases.

import { GEO, mulberry32, seedFrom } from './config.js';
import { procedural } from './telemetry.js';

const { offsetKm, clampToBounds, ringPolygon, ellipsePolygon, coastBand, arrivalArc, feature, kmPerDegLon, KM_PER_DEG_LAT } = GEO;

export const SIM_MODELS = Object.freeze({
  volcano: { raster: 'sar', label: 'VOLCANIC SAR MODEL', changeLabels: { darker: 'darker (simulated)', brighter: 'brighter (simulated)' } },
  flood: { raster: 'sar', label: 'SURFACE-CHANGE SAR MODEL', changeLabels: { darker: 'darker (simulated)', brighter: 'brighter (simulated)' } },
  quake: { raster: 'interferogram', label: 'SEISMIC INSAR MODEL', changeLabels: { darker: 'subsidence (simulated)', brighter: 'uplift (simulated)' } },
  tsunami: { raster: 'ssha', label: 'TSUNAMI ALTIMETRY MODEL', changeLabels: { darker: 'drawdown (simulated)', brighter: 'crest (simulated)' } },
});

/** Which demo model to run for an event. */
export function simModelFor(event) {
  const name = String((event && event.name) || '').toLowerCase();
  const about = `${name} ${String((event && event.description) || '').toLowerCase()}`;
  const type = String((event && event.type) || 'other').toLowerCase();
  if (/volcan|erupt|caldera|lava/.test(about)) return 'volcano';
  if (/tsunami|surge|coast|cyclone|hurricane|typhoon/.test(name)) return 'tsunami';
  if (['flood', 'wetland', 'forest', 'crop', 'soil_moisture'].includes(type) || /flood|fire|burn|drought|rain/.test(name)) return 'flood';
  return 'quake';
}

const boundsOf = (bb) => ({ west: bb[0], south: bb[1], east: bb[2], north: bb[3] });

function boxKm(b) {
  const midLat = (b.north + b.south) / 2;
  return { w: (b.east - b.west) * kmPerDegLon(midLat), h: (b.north - b.south) * KM_PER_DEG_LAT };
}

/** Linear lng/lat at fractions (fx east, fy north) of the box. */
const at = (b, fx, fy) => [b.west + (b.east - b.west) * fx, b.south + (b.north - b.south) * fy];

function geometryFor(model, b, rng, count, eventIdx) {
  const { w, h } = boxKm(b);
  const m = Math.min(w, h);
  const centre = at(b, 0.5 + (rng() - 0.5) * 0.12, 0.5 + (rng() - 0.5) * 0.12);
  if (model === 'volcano' || model === 'flood') {
    const volcano = model === 'volcano';
    const s = m / 20; // the Aso demo box is ≈ 20 km on its short side
    return {
      coords: centre,
      geometry: {
        calderaCentre: volcano ? offsetKm(centre, -1.5 * s, 1.3 * s) : null,
        rimKm: volcano ? { a: 0.42 * m, b: 0.55 * m } : null,
        cones: volcano
          ? [[0, 0, 72, 1.3 * s, 0.9 * s], [0.06 * (b.east - b.west), 0.03 * (b.north - b.south), 56, 1.0 * s, 0.8 * s], [-0.1 * (b.east - b.west), 0.05 * (b.north - b.south), 46, 0.9 * s, 0.7 * s]]
          : [],
        ashBearingDeg: Math.round(rng() * 360),
        spreadKm: volcano ? [0.04 * m, 0.19 * m] : [0.06 * m, 0.3 * m],
        edgeKm: 0.06 * m,
        ringKm: 0.03 * m,
        ringWidthKm: 0.009 * m,
      },
      strikeDeg: 0,
    };
  }
  if (model === 'quake') {
    const strike = 25 + rng() * 50; // degrees from east
    const half = 0.42 * Math.hypot(w, h);
    const ux = Math.cos((strike * Math.PI) / 180);
    const uy = Math.sin((strike * Math.PI) / 180);
    const fault = [];
    for (let i = 0; i <= 4; i++) {
      const t = -1 + i / 2;
      const kink = (rng() - 0.5) * 0.06 * m;
      fault.push(clampToBounds(offsetKm(centre, ux * half * t - uy * kink, uy * half * t + ux * kink), b));
    }
    const s = m / 144; // the Hyuganada demo box is ≈ 144 km on its short side
    const mainshock = Number.isInteger(eventIdx) ? eventIdx : Math.min(count - 1, Math.max(1, Math.floor(count / 2)));
    return {
      coords: centre,
      geometry: { fault, strikeDeg: strike, mainshockIndex: mainshock, decayKm: [40 * s, 28 * s], land: null },
      strikeDeg: strike,
    };
  }
  // tsunami: an invented coast running north–south, land to the west.
  const coast = [];
  const n = 17;
  const x0 = 0.32 + rng() * 0.06;
  for (let i = 0; i < n; i++) {
    const fy = -0.05 + (1.1 * i) / (n - 1);
    const fx = x0 + 0.06 * Math.sin(i * 0.9 + rng() * 0.6) + 0.04 * (fy - 0.5);
    coast.push(at(b, fx, fy));
  }
  const landRing = [[b.west - 1, coast[0][1]], ...coast, [b.west - 1, coast[n - 1][1]], [b.west - 1, coast[0][1]]];
  return {
    coords: at(b, 0.62, 0.5),
    geometry: {
      coast,
      land: [landRing],
      highRange: [6, 11],
      mediumRange: [3, 14],
      source: at(b, 0.85, 0.42),
      kmScale: w / 130, // the Bungo demo box is ≈ 130 km wide
    },
    strikeDeg: 0,
  };
}

/** Index of the first pass on/after the event time, or null. */
function eventPassIndex(event, steps) {
  const t = event && (event.eventTime || event.occurredAt || event.time);
  if (!t) return null;
  const day = String(t).slice(0, 10);
  const i = steps.findIndex((s) => s.date >= day);
  return i > 0 ? i : null;
}

const hazardCache = new Map();

/**
 * A demo-shaped hazard for a live event, or null when there is nothing to draw
 * on (no bbox or no pass dates). Cached per event, box and pass list.
 * steps: the live timeline steps ({ date }), real NISAR pass dates.
 */
export function simHazardFor(event, steps, override = 'auto') {
  if (!event || !Array.isArray(event.bbox) || event.bbox.length !== 4 || !steps || !steps.length) return null;
  const model = SIM_MODELS[override] ? override : simModelFor(event);
  const key = `sim|${event.id}|${event.bbox.join(',')}|${model}|${steps.map((s) => s.date).join(',')}`;
  const hit = hazardCache.get(key);
  if (hit) return hit;
  const bounds = boundsOf(event.bbox);
  const rng = mulberry32(seedFrom(key));
  const count = steps.length;
  const g = geometryFor(model, bounds, rng, count, eventPassIndex(event, steps));
  const span = Math.max(1, count - 1);
  const hazard = {
    id: key,
    simModel: model,
    model: SIM_MODELS[model],
    raster: SIM_MODELS[model].raster,
    bounds,
    coords: g.coords,
    geometry: g.geometry,
    changeLabels: SIM_MODELS[model].changeLabels,
    observed: steps.map((s, i) => ({ date: s.date, risk: Math.round((0.1 + 0.5 * (i / span)) * 100) / 100 })),
    forecast: [],
    rasters: new Map(),
  };
  hazard.riskExtents = (idx) => extentsFor(hazard, model, idx, g.strikeDeg);
  hazardCache.set(key, hazard);
  if (hazardCache.size > 12) hazardCache.delete(hazardCache.keys().next().value);
  return hazard;
}

/** The simulated frame for pass `idx` → { url, imageData }. Synchronous, cached. */
export function simFrame(hazard, idx) {
  let r = hazard.rasters.get(idx);
  if (!r) {
    r = procedural(hazard, idx, hazard.observed.length);
    hazard.rasters.set(idx, r);
  }
  return r;
}

/* ------------------------------------------------------------------ */
/* Extents: the demo shapes, scaled to the event's box                 */
/* ------------------------------------------------------------------ */

function extentsFor(hazard, model, idx, strikeDeg) {
  const b = hazard.bounds;
  const count = hazard.observed.length;
  const i = Math.min(count - 1, Math.max(0, idx | 0));
  const t = i / Math.max(1, count - 1);
  const date = hazard.observed[i].date;
  const rng = mulberry32(seedFrom(`${hazard.id}|${date}|extent`));
  const { w, h } = boxKm(b);
  const m = Math.min(w, h);
  const props = (risk) => ({ risk, schematic: true, simulated: true, kind: 'extent', date });
  const features = [];
  if (model === 'volcano' || model === 'flood') {
    const g = hazard.geometry;
    const reach = g.spreadKm[0] + (g.spreadKm[1] - g.spreadKm[0]) * t;
    features.push(feature({ type: 'Polygon', coordinates: ringPolygon(hazard.coords, reach * 1.35, rng, b) }, props('medium')));
    features.push(feature({ type: 'Polygon', coordinates: ringPolygon(hazard.coords, reach * 0.6, rng, b) }, props('high')));
  } else if (model === 'quake') {
    const g = hazard.geometry;
    const after = i >= g.mainshockIndex;
    const k = after ? 1 + 0.05 * (i - g.mainshockIndex) : 0.25 + 0.03 * i;
    features.push(feature({ type: 'Polygon', coordinates: ellipsePolygon(hazard.coords, 0.42 * m * k, 0.26 * m * k, strikeDeg, rng, b) }, props('medium')));
    features.push(feature({ type: 'Polygon', coordinates: ellipsePolygon(hazard.coords, 0.27 * m * k, 0.15 * m * k, strikeDeg, rng, b) }, props('high')));
    features.push(feature({ type: 'LineString', coordinates: g.fault.map((c) => clampToBounds(c, b)) }, { kind: 'fault', schematic: true, simulated: true, date }));
  } else {
    const g = hazard.geometry;
    const s = g.kmScale;
    features.push(feature({ type: 'Polygon', coordinates: coastBand(g.coast, g.mediumRange[0], g.mediumRange[1], (3 + 3 * t) * s, 1.5 * s, rng, b) }, props('medium')));
    features.push(feature({ type: 'Polygon', coordinates: coastBand(g.coast, g.highRange[0], g.highRange[1], (1.5 + 1.5 * t) * s, 1.5 * s, rng, b) }, props('high')));
    const arcBase = (14 + 54 * t) * s;
    for (let k = 0; k < 3; k++) {
      const r = arcBase - k * 9 * s;
      if (r < 5 * s) continue;
      const parts = arrivalArc(g.source, r, b, g.land);
      if (parts.length) features.push(feature({ type: 'MultiLineString', coordinates: parts }, { kind: 'arrival', risk: 'medium', schematic: true, simulated: true, date, order: k }));
    }
  }
  return { type: 'FeatureCollection', features };
}
