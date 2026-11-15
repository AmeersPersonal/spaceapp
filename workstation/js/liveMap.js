// liveMap.js — MapLibre sources and layers for the LIVE channel, and the
// idempotent applyLiveMap(map, lv). Imports map.js helpers only.
//
// Layers, bottom to top (all beneath the basemap's label stack):
//   live-tiles         processed NISAR tiles for the current date (raster)
//   live-scene-<n>     ASF browse previews for the current date (image)
//   live-outlook-fill  MODELLED earthquake outlook cells: hatched pale sky
//   live-outlook-line  dashed pale-sky outline (selected cell thicker)
//   live-aoi-line      the event's area, dashed pale sky
//   live-probe-line    the clicked exploration box, dashed mint
//
// Measurements (previews, tiles) are solid imagery; modelled output (the
// outlook) is always hatched + dashed + pale sky, never a flat colour fill,
// so it cannot be read as an observation.

import { labelStackStartId } from './map.js';

const PALE_SKY = '#BFD1E5'; // --pale-sky
const MINT = '#EBF5EE'; // --mint-cream
const EMPTY_FC = Object.freeze({ type: 'FeatureCollection', features: [] });
const HATCH_ID = 'live-hatch';
const VECTOR_LAYERS = ['live-outlook-fill', 'live-outlook-line', 'live-aoi-line', 'live-probe-line'];

const applied = new WeakMap();

function stateOf(map) {
  let s = applied.get(map);
  if (!s) {
    s = { images: new Map(), imageSeq: 0, aoiKey: null, probeKey: null, outlookKey: null, tilesKey: null, active: undefined, opacity: undefined, outlookOn: undefined };
    applied.set(map, s);
  }
  return s;
}

const rect = ([w, s, e, n], properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
});

/** 8×8 diagonal hatch in pale sky, for modelled fills. */
function hatchImage() {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + y) % size === 0 || (x + y) % size === 1) {
        const o = (y * size + x) * 4;
        data[o] = 191;
        data[o + 1] = 209;
        data[o + 2] = 229;
        data[o + 3] = 255;
      }
    }
  }
  return { width: size, height: size, data };
}

/** Add the live sources and vector layers once. Safe to call repeatedly. */
export function addLiveLayers(map) {
  if (!map || map.getSource('live-aoi')) return;
  const before = labelStackStartId(map);
  const add = (layer) => (before ? map.addLayer(layer, before) : map.addLayer(layer));

  if (!map.hasImage(HATCH_ID)) map.addImage(HATCH_ID, hatchImage());

  map.addSource('live-outlook', { type: 'geojson', data: EMPTY_FC });
  add({
    id: 'live-outlook-fill',
    type: 'fill',
    source: 'live-outlook',
    layout: { visibility: 'none' },
    paint: {
      'fill-pattern': HATCH_ID,
      'fill-opacity': ['interpolate', ['linear'], ['get', 'probability'], 0, 0.15, 0.5, 0.5, 1, 0.85],
    },
  });
  add({
    id: 'live-outlook-line',
    type: 'line',
    source: 'live-outlook',
    layout: { visibility: 'none' },
    paint: {
      'line-color': PALE_SKY,
      'line-width': ['case', ['boolean', ['get', 'selected'], false], 2.5, 0.75],
      'line-opacity': ['case', ['boolean', ['get', 'selected'], false], 1, 0.6],
      'line-dasharray': [2, 2],
    },
  });

  map.addSource('live-aoi', { type: 'geojson', data: EMPTY_FC });
  add({
    id: 'live-aoi-line',
    type: 'line',
    source: 'live-aoi',
    layout: { visibility: 'none' },
    paint: { 'line-color': PALE_SKY, 'line-width': 1.5, 'line-dasharray': [3, 2] },
  });

  map.addSource('live-probe', { type: 'geojson', data: EMPTY_FC });
  add({
    id: 'live-probe-line',
    type: 'line',
    source: 'live-probe',
    layout: { visibility: 'none' },
    paint: { 'line-color': MINT, 'line-width': 1.5, 'line-dasharray': [1, 2] },
  });
}

function setVisibility(map, id, visible) {
  if (!map.getLayer(id)) return;
  const want = visible ? 'visible' : 'none';
  if (map.getLayoutProperty(id, 'visibility') !== want) map.setLayoutProperty(id, 'visibility', want);
}

/** The outlook cell under a screen point, or null. */
export function outlookCellAt(map, point) {
  if (!map || !point || !map.getLayer('live-outlook-fill')) return null;
  if (map.getLayoutProperty('live-outlook-fill', 'visibility') !== 'visible') return null;
  try {
    const hit = map.queryRenderedFeatures([point.x, point.y], { layers: ['live-outlook-fill'] })[0];
    return hit && hit.properties ? String(hit.properties.id) : null;
  } catch {
    return null;
  }
}

/**
 * Apply the live view. lv:
 *  active      boolean — false hides every live layer
 *  aoi         [w,s,e,n] | null
 *  probe       [w,s,e,n] | null
 *  outlookOn   boolean; cells [{id,bbox,probability}]; selectedCell id | null
 *  images      [{ key, url, coordinates, visible }]   (only images that finished loading)
 *  tiles       { url, minZoom, maxZoom, bounds } | null
 *  opacity     0..1 for previews and tiles
 */
export function applyLiveMap(map, lv) {
  if (!map || !lv || !map.getSource('live-aoi')) return;
  const s = stateOf(map);
  const active = Boolean(lv.active);
  const before = 'live-outlook-fill';

  // Area and probe outlines.
  const aoiKey = active && lv.aoi ? lv.aoi.join(',') : '';
  if (s.aoiKey !== aoiKey) {
    map.getSource('live-aoi').setData(aoiKey ? { type: 'FeatureCollection', features: [rect(lv.aoi)] } : EMPTY_FC);
    s.aoiKey = aoiKey;
  }
  const probeKey = active && lv.probe ? lv.probe.join(',') : '';
  if (s.probeKey !== probeKey) {
    map.getSource('live-probe').setData(probeKey ? { type: 'FeatureCollection', features: [rect(lv.probe)] } : EMPTY_FC);
    s.probeKey = probeKey;
  }

  // Outlook cells (modelled).
  const cells = active && lv.outlookOn && Array.isArray(lv.cells) ? lv.cells : [];
  const outlookKey = `${cells.map((c) => c.id).join(',')}|${lv.selectedCell || ''}`;
  if (s.outlookKey !== outlookKey) {
    map.getSource('live-outlook').setData({
      type: 'FeatureCollection',
      features: cells
        .filter((c) => Array.isArray(c.bbox))
        .map((c) => rect(c.bbox, { id: c.id, probability: Number(c.probability) || 0, selected: c.id === lv.selectedCell })),
    });
    s.outlookKey = outlookKey;
  }
  const outlookOn = active && Boolean(lv.outlookOn);
  if (s.outlookOn !== outlookOn || s.active !== active) {
    setVisibility(map, 'live-outlook-fill', outlookOn);
    setVisibility(map, 'live-outlook-line', outlookOn);
    s.outlookOn = outlookOn;
  }
  if (s.active !== active) {
    setVisibility(map, 'live-aoi-line', active);
    setVisibility(map, 'live-probe-line', active);
  }

  const opacity = Number.isFinite(lv.opacity) ? lv.opacity : 0.85;

  // Browse previews: add each once, then only toggle visibility and opacity.
  const want = new Map((active ? lv.images || [] : []).map((img) => [img.key, img]));
  for (const img of want.values()) {
    if (s.images.has(img.key)) continue;
    const id = `live-scene-${++s.imageSeq}`;
    try {
      map.addSource(id, { type: 'image', url: img.url, coordinates: img.coordinates });
      map.addLayer(
        { id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } },
        before,
      );
      s.images.set(img.key, { id, visible: false, opacity });
    } catch {
      /* a bad image is skipped; the panel reports load failures */
    }
  }
  for (const [key, rec] of s.images) {
    const img = want.get(key);
    const visible = Boolean(img && img.visible);
    if (rec.visible !== visible) {
      setVisibility(map, rec.id, visible);
      rec.visible = visible;
    }
    if (visible && rec.opacity !== opacity) {
      map.setPaintProperty(rec.id, 'raster-opacity', opacity);
      rec.opacity = opacity;
    }
  }

  // Processed tiles for the current date.
  const tiles = active ? lv.tiles : null;
  const tilesKey = tiles ? tiles.url : '';
  if (s.tilesKey !== tilesKey) {
    if (map.getLayer('live-tiles')) map.removeLayer('live-tiles');
    if (map.getSource('live-tiles')) map.removeSource('live-tiles');
    if (tiles) {
      const url = new URL(tiles.url, window.location.origin).href;
      map.addSource('live-tiles', {
        type: 'raster',
        tiles: [url],
        tileSize: 256,
        ...(Number.isFinite(tiles.minZoom) ? { minzoom: tiles.minZoom } : {}),
        ...(Number.isFinite(tiles.maxZoom) ? { maxzoom: tiles.maxZoom } : {}),
        ...(Array.isArray(tiles.bounds) ? { bounds: tiles.bounds } : {}),
      });
      map.addLayer({ id: 'live-tiles', type: 'raster', source: 'live-tiles', paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } }, before);
    }
    s.tilesKey = tilesKey;
  }
  if (tiles && s.opacity !== opacity && map.getLayer('live-tiles')) map.setPaintProperty('live-tiles', 'raster-opacity', opacity);

  s.opacity = opacity;
  s.active = active;
}

/** Fit a [w,s,e,n] box with dock-aware padding supplied by the caller. */
export function fitBox(map, bbox, padding, animate = true) {
  if (!map || !Array.isArray(bbox)) return;
  try {
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding, duration: animate ? 600 : 0, maxZoom: 11, essential: true });
  } catch {
    try {
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 16, duration: 0, maxZoom: 11 });
    } catch {
      /* camera stays */
    }
  }
}

export const LIVE_VECTOR_LAYERS = VECTOR_LAYERS;
