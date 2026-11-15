// map.js — MapLibre setup, basemap recolouring, all sources and layers, and
// the idempotent applyMapState(map, view). Imports only config.js. MapLibre is
// the global `maplibregl` loaded by the classic CDN script in index.html.
//
// Colour literals below are deliberate: MapLibre paint expressions are
// evaluated inside the GL style, which cannot read CSS custom properties, so
// the token values from css/tokens.css are repeated here verbatim.

import { HAZARD_REGISTRY } from './config.js';

const PALETTE = Object.freeze({
  canvas: '#07090E', // --bg-canvas
  water: '#0A1220',
  land: '#0C1016',
  line: 'rgba(235,245,238,.10)',
  lineRoad: 'rgba(235,245,238,.14)',
  text: '#9FB0C4', // --text-secondary
  riskHigh: '#E5484D', // --risk-high
  riskMedium: '#F5A524', // --risk-medium
  fault: 'rgba(235,245,238,.70)', // --mint-cream at 70%
  footprint: 'rgba(235,245,238,.32)', // --border-strong
  compoundFallback: 'rgba(235,245,238,.45)',
});

// A 1×1 fully transparent PNG: the initial image for both image sources, and
// what the raster shows when nothing may be displayed (never a synthetic
// stand-in, just nothing).
export const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const DESKTOP_PADDING = Object.freeze({ top: 72, bottom: 108, left: 324, right: 384 });
const MOBILE_PADDING = Object.freeze({ top: 64, bottom: 96, left: 16, right: 16 });

const DASH_FORECAST = [2, 2];
const DASH_OBSERVED = [1, 0];

const EMPTY_FC = Object.freeze({ type: 'FeatureCollection', features: [] });

// Per-map bookkeeping so applyMapState only touches MapLibre when something
// actually changed.
const applied = new WeakMap();

function stateOf(map) {
  let s = applied.get(map);
  if (!s) {
    s = {
      hazardId: null,
      rasterUrl: undefined,
      rasterVisible: undefined,
      rasterOpacity: undefined,
      changeUrl: undefined,
      showChange: undefined,
      riskKey: null,
      showRisk: undefined,
      forecastDash: undefined,
      compoundKey: null,
      compoundSeismic: undefined,
      compoundTsunami: undefined,
      marker: null,
      markerOnMap: false,
      markerKey: null,
      reticleShown: undefined,
    };
    applied.set(map, s);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                     */
/* ------------------------------------------------------------------ */

/** Image-source corners in MapLibre order: NW, NE, SE, SW. */
export function cornersOf(bounds) {
  return [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
  ];
}

function footprintFrame(bounds) {
  const { west, south, east, north } = bounds;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'footprint' },
        geometry: {
          type: 'LineString',
          coordinates: [[west, north], [east, north], [east, south], [west, south], [west, north]],
        },
      },
    ],
  };
}

/** Short `+` marks centred on each corner of the bounds. */
function footprintTicks(bounds) {
  const { west, south, east, north } = bounds;
  const dx = (east - west) * 0.025;
  const dy = (north - south) * 0.025;
  const corners = [[west, north], [east, north], [east, south], [west, south]];
  const lines = [];
  for (const [x, y] of corners) {
    lines.push([[x - dx, y], [x + dx, y]]);
    lines.push([[x, y - dy], [x, y + dy]]);
  }
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { kind: 'tick' }, geometry: { type: 'MultiLineString', coordinates: lines } },
    ],
  };
}

export function paddingFor(map, isMobile) {
  if (isMobile) return { ...MOBILE_PADDING };
  const el = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
  const w = el ? el.clientWidth : 0;
  const h = el ? el.clientHeight : 0;
  // Fall back to the compact padding when the desktop docks would leave no
  // room for the footprint (MapLibre warns and refuses to fit otherwise).
  if (w && h && (w - DESKTOP_PADDING.left - DESKTOP_PADDING.right < 96 || h - DESKTOP_PADDING.top - DESKTOP_PADDING.bottom < 96)) {
    return { ...MOBILE_PADDING };
  }
  return { ...DESKTOP_PADDING };
}

/* ------------------------------------------------------------------ */
/* Camera                                                               */
/* ------------------------------------------------------------------ */

/** Fit the hazard bounds with the dock-aware padding. */
export function refitCamera(map, hazard, isMobile = false, animate = true) {
  if (!map || !hazard || !hazard.bounds) return;
  const b = hazard.bounds;
  const bounds = [
    [b.west, b.south],
    [b.east, b.north],
  ];
  const options = { padding: paddingFor(map, isMobile), duration: animate ? 600 : 0, essential: true };
  try {
    map.fitBounds(bounds, options);
  } catch (err) {
    try {
      map.fitBounds(bounds, { padding: 16, duration: 0 });
    } catch (_) {
      /* the camera stays where it is; nothing else depends on it */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

function describeMapError(e) {
  const err = e && e.error;
  if (!err) return 'unknown error';
  const status = err.status || (err.response && err.response.status);
  if (status) return `HTTP ${status}`;
  const msg = typeof err === 'string' ? err : err.message;
  return msg ? String(msg) : 'unknown error';
}

/* ------------------------------------------------------------------ */
/* Creation                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create the flat, north-up map. Throws Error('Map library failed to load')
 * when the CDN script did not define `maplibregl`.
 *
 * options: { style, hazard, padding?, isMobile?, onClick?, onError? }
 *  - onError(message, { sourceId, detail }) receives spec §6 copy for tiles.
 *  - onClick({ lng, lat }) receives every map click; main.js decides inside/outside.
 */
export function createMap(container, { style, hazard, padding, isMobile = false, onClick, onError } = {}) {
  if (typeof maplibregl === 'undefined') {
    throw new Error('Map library failed to load');
  }
  const map = new maplibregl.Map({
    container,
    style,
    center: hazard ? hazard.coords : [131.104, 32.884],
    zoom: hazard ? hazard.zoom : 11,
    pitch: 0,
    bearing: 0,
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
    fadeDuration: 0,
  });

  // No rotation by any input: mouse (dragRotate above), touch and keyboard.
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

  map.on('error', (e) => {
    if (typeof onError !== 'function') return;
    // A superseded request (updateImage called again before the previous
    // image finished) is a cancellation, not a failure.
    const err = e && e.error;
    if (err && (err.name === 'AbortError' || /\babort/i.test(String(err.message || err)))) return;
    const detail = describeMapError(e);
    const sourceId = e && e.sourceId ? String(e.sourceId) : '';
    const message = `Map tiles failed to load (${detail}). The radar overlay and charts are unaffected.`;
    onError(message, { sourceId, detail });
  });

  map.on('click', (e) => {
    if (typeof onClick !== 'function' || !e || !e.lngLat) return;
    onClick({ lng: e.lngLat.lng, lat: e.lngLat.lat, point: e.point ? { x: e.point.x, y: e.point.y } : null });
  });

  if (hazard && hazard.bounds) {
    if (padding) {
      try {
        map.fitBounds([[hazard.bounds.west, hazard.bounds.south], [hazard.bounds.east, hazard.bounds.north]], { padding, duration: 0 });
      } catch (_) {
        refitCamera(map, hazard, isMobile, false);
      }
    } else {
      refitCamera(map, hazard, isMobile, false);
    }
  }

  return map;
}

/* ------------------------------------------------------------------ */
/* Basemap recolouring                                                  */
/* ------------------------------------------------------------------ */

const WATER_RE = /water|ocean|sea\b|lake|river|bathymetry/i;
const ROAD_RE = /road|highway|street|motorway|trunk|primary|secondary|tertiary|minor|service|transport|rail|bridge|tunnel|path|track|ferry|aeroway/i;

/** Recolour every vector style layer to the obsidian palette. */
export function styleBasemap(map) {
  let style = null;
  try {
    style = map.getStyle();
  } catch (_) {
    return;
  }
  if (!style || !Array.isArray(style.layers)) return;

  for (const layer of style.layers) {
    const id = layer.id;
    const type = layer.type;
    const paint = layer.paint || {};
    const set = (prop, value) => {
      try {
        map.setPaintProperty(id, prop, value);
      } catch (_) {
        /* a property the layer does not support; skip it */
      }
    };
    if (type === 'raster' || type === 'hillshade' || type === 'heatmap' || type === 'circle') continue;
    const name = `${id} ${layer['source-layer'] || ''}`;

    if (type === 'background') {
      set('background-color', PALETTE.canvas);
      set('background-opacity', 1);
    } else if (type === 'fill') {
      if (paint['fill-pattern'] !== undefined) continue;
      set('fill-color', WATER_RE.test(name) ? PALETTE.water : PALETTE.land);
      set('fill-outline-color', PALETTE.line);
    } else if (type === 'fill-extrusion') {
      if (paint['fill-extrusion-pattern'] !== undefined) continue;
      set('fill-extrusion-color', PALETTE.land);
    } else if (type === 'line') {
      if (paint['line-pattern'] !== undefined) continue;
      set('line-color', ROAD_RE.test(name) ? PALETTE.lineRoad : PALETTE.line);
    } else if (type === 'symbol') {
      set('text-color', PALETTE.text);
      set('text-halo-color', PALETTE.canvas);
      set('text-halo-width', 1);
      set('icon-opacity', 0.6);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Sources and layers                                                   */
/* ------------------------------------------------------------------ */

const EXTENT_FILTER = ['any', ['!', ['has', 'kind']], ['==', ['get', 'kind'], 'extent']];
const TRACE_FILTER = ['any', ['==', ['get', 'kind'], 'fault'], ['==', ['get', 'kind'], 'arrival']];
const RISK_MATCH = ['match', ['get', 'risk'], 'high', PALETTE.riskHigh, 'medium', PALETTE.riskMedium, PALETTE.riskMedium];
const COMPOUND_MATCH = ['match', ['get', 'risk'], 'high', PALETTE.riskHigh, 'medium', PALETTE.riskMedium, PALETTE.compoundFallback];

/**
 * The first layer of the trailing run of symbol layers. Some basemaps
 * (OpenFreeMap Liberty) interleave a few symbol layers among the roads, so
 * the *first* symbol layer would leave bridges and buildings drawn above
 * the overlays. Inserting before the trailing run keeps every non-label
 * basemap layer underneath and every label on top.
 */
export function labelStackStartId(map) {
  try {
    const style = map.getStyle();
    const layers = style && style.layers ? style.layers : [];
    let i = layers.length;
    while (i > 0 && layers[i - 1].type === 'symbol') i--;
    return layers[i] ? layers[i].id : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Add every source and layer, bottom to top:
 * raster, change, risk-fill, risk-line, fault-line, footprint-frame,
 * footprint-ticks, compound-seismic, compound-tsunami.
 * They are inserted beneath the basemap's trailing label stack so place
 * labels stay legible over the overlays. Safe to call once per map; a second call is
 * a no-op.
 */
export function addLayers(map, hazard) {
  if (!map || !hazard || map.getSource('raster')) return;
  const corners = cornersOf(hazard.bounds);
  const before = labelStackStartId(map);
  const add = (layer) => {
    if (before) map.addLayer(layer, before);
    else map.addLayer(layer);
  };

  // No 'raster-resampling': 'nearest' on these image layers: with MapLibre
  // 4.7.1 it drew the radar as a solid black square in Chrome (measured with
  // readPixels ≈ 2,2,3 inside the footprint; ≈ 80–100 grey with linear).
  map.addSource('raster', { type: 'image', url: TRANSPARENT_PIXEL, coordinates: corners });
  add({
    id: 'raster',
    type: 'raster',
    source: 'raster',
    paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
  });

  map.addSource('change', { type: 'image', url: TRANSPARENT_PIXEL, coordinates: corners });
  add({
    id: 'change',
    type: 'raster',
    source: 'change',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
  });

  map.addSource('risk', { type: 'geojson', data: EMPTY_FC });
  add({
    id: 'risk-fill',
    type: 'fill',
    source: 'risk',
    filter: EXTENT_FILTER,
    paint: { 'fill-color': RISK_MATCH, 'fill-opacity': 0.14 },
  });
  add({
    id: 'risk-line',
    type: 'line',
    source: 'risk',
    filter: EXTENT_FILTER,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': RISK_MATCH, 'line-width': 1.5, 'line-dasharray': DASH_OBSERVED },
  });
  add({
    id: 'fault-line',
    type: 'line',
    source: 'risk',
    filter: TRACE_FILTER,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'arrival', PALETTE.riskMedium, PALETTE.fault],
      'line-width': ['match', ['get', 'kind'], 'arrival', 1, 1.5],
      'line-dasharray': DASH_OBSERVED,
    },
  });

  map.addSource('footprint', { type: 'geojson', data: footprintFrame(hazard.bounds) });
  add({
    id: 'footprint-frame',
    type: 'line',
    source: 'footprint',
    paint: { 'line-color': PALETTE.footprint, 'line-width': 1 },
  });

  map.addSource('footprint-ticks', { type: 'geojson', data: footprintTicks(hazard.bounds) });
  add({
    id: 'footprint-ticks',
    type: 'line',
    source: 'footprint-ticks',
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': PALETTE.footprint, 'line-width': 1 },
  });

  map.addSource('compound-seismic', { type: 'geojson', data: EMPTY_FC });
  add({
    id: 'compound-seismic',
    type: 'line',
    source: 'compound-seismic',
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': COMPOUND_MATCH, 'line-width': 1, 'line-opacity': 0.85, 'line-dasharray': DASH_OBSERVED },
  });

  map.addSource('compound-tsunami', { type: 'geojson', data: EMPTY_FC });
  add({
    id: 'compound-tsunami',
    type: 'line',
    source: 'compound-tsunami',
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': COMPOUND_MATCH, 'line-width': 1, 'line-opacity': 0.85, 'line-dasharray': DASH_OBSERVED },
  });

  // Record what the sources already show so the first applyMapState does not
  // re-request the same pixel while it is still loading.
  const s = stateOf(map);
  s.hazardId = hazard.id;
  s.rasterUrl = TRANSPARENT_PIXEL;
  s.changeUrl = TRANSPARENT_PIXEL;
}

/* ------------------------------------------------------------------ */
/* Reticle marker                                                       */
/* ------------------------------------------------------------------ */

function makeReticleElement() {
  const el = document.createElement('div');
  el.className = 'reticle-marker';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/* ------------------------------------------------------------------ */
/* applyMapState                                                        */
/* ------------------------------------------------------------------ */

function setVisibility(map, layerId, visible) {
  if (!map.getLayer(layerId)) return;
  const want = visible ? 'visible' : 'none';
  if (map.getLayoutProperty(layerId, 'visibility') !== want) {
    map.setLayoutProperty(layerId, 'visibility', want);
  }
}

function setPaint(map, layerId, prop, value) {
  if (!map.getLayer(layerId)) return;
  try {
    map.setPaintProperty(layerId, prop, value);
  } catch (_) {
    /* unsupported on this layer; nothing to do */
  }
}

const DEMO_LAYERS = ['raster', 'change', 'risk-fill', 'risk-line', 'fault-line', 'footprint-frame', 'footprint-ticks', 'compound-seismic', 'compound-tsunami'];

/**
 * Hide every synthetic (demo-channel) layer and the reticle, for the LIVE
 * channel. Forgets what applyMapState applied, so the next applyMapState
 * (back on a demo channel) re-applies every image, visibility and paint.
 */
export function hideDemoLayers(map) {
  if (!map || !map.getSource('raster')) return;
  for (const id of DEMO_LAYERS) setVisibility(map, id, false);
  const s = applied.get(map);
  if (s && s.marker && s.markerOnMap) s.marker.remove();
  applied.delete(map);
}

/**
 * Apply a derived view (main.js deriveView output) to the map. Idempotent:
 * calling it twice with equal views issues no MapLibre calls the second time.
 *
 * view fields used:
 *  hazard, rasterUrl, rasterVisible, rasterOpacity, changeUrl, showChange,
 *  riskGeojson, riskKey, showRisk, isForecast, compound, compoundKey,
 *  compoundGeojson { seismic, tsunami }, point, showReticle.
 */
export function applyMapState(map, view) {
  if (!map || !view || !view.hazard) return;
  if (!map.getSource('raster')) return; // layers not added yet (style still loading)
  const s = stateOf(map);
  const hazard = view.hazard;
  const hazardChanged = s.hazardId !== hazard.id;
  const corners = cornersOf(hazard.bounds);

  // 1. Raster image: URL + coordinates. A missing URL shows the transparent
  //    pixel, never a stand-in image.
  const rasterUrl = view.rasterUrl || TRANSPARENT_PIXEL;
  if (hazardChanged || s.rasterUrl !== rasterUrl) {
    const src = map.getSource('raster');
    if (src && typeof src.updateImage === 'function') src.updateImage({ url: rasterUrl, coordinates: corners });
    s.rasterUrl = rasterUrl;
  }
  const rasterVisible = Boolean(view.rasterVisible);
  if (s.rasterVisible !== rasterVisible) {
    setVisibility(map, 'raster', rasterVisible);
    s.rasterVisible = rasterVisible;
  }
  // Exactly view.rasterOpacity: 0.35 on every forecast date (lock 1).
  const opacity = Number.isFinite(view.rasterOpacity) ? view.rasterOpacity : 0;
  if (s.rasterOpacity !== opacity) {
    setPaint(map, 'raster', 'raster-opacity', opacity);
    s.rasterOpacity = opacity;
  }

  // 2. Change image: visible only when view.showChange (never in forecast).
  const showChange = Boolean(view.showChange && view.changeUrl);
  const changeUrl = showChange ? view.changeUrl : TRANSPARENT_PIXEL;
  if (hazardChanged || s.changeUrl !== changeUrl) {
    const src = map.getSource('change');
    if (src && typeof src.updateImage === 'function') src.updateImage({ url: changeUrl, coordinates: corners });
    s.changeUrl = changeUrl;
  }
  if (s.showChange !== showChange) {
    setVisibility(map, 'change', showChange);
    s.showChange = showChange;
  }

  // 3. Risk extents: data, visibility, dash (lock 6: dashed in forecast).
  const riskKey = view.riskKey || JSON.stringify(view.riskGeojson || EMPTY_FC);
  if (s.riskKey !== riskKey) {
    const src = map.getSource('risk');
    if (src && typeof src.setData === 'function') src.setData(view.riskGeojson || EMPTY_FC);
    s.riskKey = riskKey;
  }
  const showRisk = Boolean(view.showRisk);
  if (s.showRisk !== showRisk) {
    setVisibility(map, 'risk-fill', showRisk);
    setVisibility(map, 'risk-line', showRisk);
    setVisibility(map, 'fault-line', showRisk);
    s.showRisk = showRisk;
  }
  const forecastDash = Boolean(view.isForecast);
  if (s.forecastDash !== forecastDash) {
    const dash = forecastDash ? DASH_FORECAST : DASH_OBSERVED;
    setPaint(map, 'risk-line', 'line-dasharray', dash);
    setPaint(map, 'fault-line', 'line-dasharray', dash);
    setPaint(map, 'compound-seismic', 'line-dasharray', dash);
    setPaint(map, 'compound-tsunami', 'line-dasharray', dash);
    s.forecastDash = forecastDash;
  }

  // 4. Footprint frame and corner ticks follow the hazard bounds (and are
  //    re-shown after hideDemoLayers, which resets this bookkeeping).
  if (!s.footprintShown) {
    setVisibility(map, 'footprint-frame', true);
    setVisibility(map, 'footprint-ticks', true);
    s.footprintShown = true;
  }
  if (hazardChanged) {
    const frame = map.getSource('footprint');
    if (frame && typeof frame.setData === 'function') frame.setData(footprintFrame(hazard.bounds));
    const ticks = map.getSource('footprint-ticks');
    if (ticks && typeof ticks.setData === 'function') ticks.setData(footprintTicks(hazard.bounds));
  }

  // 5. Compound overlays: visible only when compound is on and the overlay is
  //    not the active hazard.
  const compound = Boolean(view.compound);
  const geo = view.compoundGeojson || {};
  const compoundKey = compound ? String(view.compoundKey || '') : '';
  if (compound && s.compoundKey !== compoundKey) {
    const seismic = map.getSource('compound-seismic');
    if (seismic && typeof seismic.setData === 'function') {
      seismic.setData(geo.seismic || HAZARD_REGISTRY.earthquake.riskExtents(view.stepKind || 'observed', view.idx));
    }
    const tsunami = map.getSource('compound-tsunami');
    if (tsunami && typeof tsunami.setData === 'function') {
      tsunami.setData(geo.tsunami || HAZARD_REGISTRY.tsunami.riskExtents(view.stepKind || 'observed', view.idx));
    }
    s.compoundKey = compoundKey;
  }
  const showSeismic = compound && hazard.id !== 'earthquake';
  const showTsunami = compound && hazard.id !== 'tsunami';
  if (s.compoundSeismic !== showSeismic) {
    setVisibility(map, 'compound-seismic', showSeismic);
    s.compoundSeismic = showSeismic;
  }
  if (s.compoundTsunami !== showTsunami) {
    setVisibility(map, 'compound-tsunami', showTsunami);
    s.compoundTsunami = showTsunami;
  }

  // 6. Inspection reticle: an HTML marker, present only for an in-bounds point
  //    and shown only while the reticle toggle is on.
  const point = view.point && Number.isFinite(view.point.lng) && Number.isFinite(view.point.lat) ? view.point : null;
  if (point) {
    if (!s.marker) {
      s.marker = new maplibregl.Marker({ element: makeReticleElement(), anchor: 'center' });
    }
    const markerKey = `${point.lng}|${point.lat}`;
    if (s.markerKey !== markerKey) {
      s.marker.setLngLat([point.lng, point.lat]);
      s.markerKey = markerKey;
    }
    if (!s.markerOnMap) {
      s.marker.addTo(map);
      s.markerOnMap = true;
    }
    const shown = Boolean(view.showReticle);
    if (s.reticleShown !== shown) {
      const el = s.marker.getElement();
      if (shown) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
      s.reticleShown = shown;
    }
  } else if (s.marker && s.markerOnMap) {
    s.marker.remove();
    s.markerOnMap = false;
    s.markerKey = null;
  }

  s.hazardId = hazard.id;
}
