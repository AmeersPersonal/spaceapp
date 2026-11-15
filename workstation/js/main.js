// main.js — entry point: DOM refs, the single `state`, deriveView(), render(),
// events, the play timer, the router and the dialogs.
//
// The rule enforced here above everything else: a prediction must never look
// like a measurement. render() applies all seven forecast locks from
// HANDOFF.md §3 together, from one derived view, and the forecast branch
// never assigns state.mode, state.observedOpacity or state.baseline.

import {
  CONFIG,
  HAZARD_REGISTRY,
  getHazard,
  defaultHazard,
  timelineOf,
  levelFor,
  footprintKm,
  formatDate,
  formatShort,
  formatSpoken,
} from './config.js';
import { TelemetryService, ERROR_COPY } from './telemetry.js';
import { riskChart, pointChart } from './charts.js';
import { createMap, styleBasemap, addLayers, applyMapState, refitCamera } from './map.js';

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const MOBILE_QUERY = '(max-width: 900px)';

const COPY = Object.freeze({
  mapMissing: 'Map unavailable: the map library failed to load. Controls and evidence still work.',
  mapFailed: (m) => `Map unavailable: ${m}. Controls and evidence still work.`,
  pointIdle: 'Click inside the radar footprint to inspect a point.',
  pointOutside: 'Outside radar footprint — no coverage',
  pointWaiting: 'Point selected. Values appear once the observed rasters have loaded.',
  pointUnavailable: 'Raster unavailable — no point values can be sampled.',
  noTimeline: 'No timeline data.',
  pwMismatch: 'Passwords do not match.',
});

// Point-series display scales per raster type. The raw sample is a 0..1
// display intensity; seismic and tsunami channels show it on an illustrative
// centimetre axis (their pointUnit strings already say "synthetic, illustrative").
const POINT_SCALES = Object.freeze({
  sar: { domain: [0, 1], map: (v) => v },
  interferogram: { domain: [-20, 20], map: (v) => (v - 0.5) * 40 },
  ssha: { domain: [-50, 50], map: (v) => (v - 0.5) * 100 },
});

/* ------------------------------------------------------------------ */
/* State (js/spec.md §5)                                                */
/* ------------------------------------------------------------------ */

const state = {
  hazard: defaultHazard().id,
  idx: null /* set to last observed on load/switch */,
  mode: 'radar',
  baseline: 0,
  observedOpacity: 85,
  showRisk: true,
  showReticle: true,
  compound: false,
  point: null /* {lng,lat} | {outside:true} | null */,
  playing: false,
  route: 'home',
  // Separate slots so one failure never overwrites another; render() joins
  // map + backend into #map-error.
  errors: { map: '', asset: '', backend: '' },
};

// Data caches: not UI state, but inputs deriveView reads alongside `state`.
const cache = {
  timelines: new Map(), // hazardId → timeline array (fetched)
  rasters: new Map(), // hazardId → array of { canvas, imageData, url, source }
  rasterStatus: new Map(), // hazardId → 'loading' | 'ready' | 'error'
  changeUrls: new Map(), // `${hazard}|${baseline}|${idx}` → data URL
};

const telemetry = new TelemetryService(CONFIG, HAZARD_REGISTRY);

let map = null;
let mapReady = false;
let mapFatal = ''; // the library/constructor failure, which hazard switches must not clear
let mapLastError = ''; // the last style/tile failure, also kept across hazard switches
let playTimer = null;
let loadToken = 0;
let lastAnnounced = '';
let lastRiskSvg = '';
let lastPointSvg = '';
let lastTickSignature = '';
let lastBaselineSignature = '';
let dialogOpener = null;
let currentRoute = null;

/* ------------------------------------------------------------------ */
/* DOM                                                                  */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  html: document.documentElement,
  map: $('map'),
  hazardSwitch: $('hazard-switch'),
  compoundToggle: $('compound-toggle'),
  targetName: $('target-name'),
  targetCoords: $('target-coords'),
  targetFootprint: $('target-footprint'),
  modePill: $('mode-pill'),
  menuToggle: $('menu-toggle'),
  openMethod: $('open-method'),
  openAbout: $('open-about'),
  controls: $('controls'),
  controlsDrawer: $('controls-drawer'),
  passDate: $('pass-date'),
  passIndex: $('pass-index'),
  noPassAlert: $('no-pass-alert'),
  btnRadar: $('btn-radar'),
  btnChange: $('btn-change'),
  baselineWrap: $('baseline-wrap'),
  baseline: $('baseline'),
  opacity: $('opacity'),
  opacityReadout: $('opacity-readout'),
  opacityLock: $('opacity-lock'),
  toggleRisk: $('toggle-risk'),
  toggleReticle: $('toggle-reticle'),
  legendRadar: $('legend-radar'),
  legendChange: $('legend-change'),
  legendForecast: $('legend-forecast'),
  legendRisk: $('legend-risk'),
  evidence: $('evidence'),
  evidenceDrawer: $('evidence-drawer'),
  mapError: $('map-error'),
  assetError: $('asset-error'),
  observedCard: $('observed-card'),
  observedPass: $('observed-pass'),
  observedBaseline: $('observed-baseline'),
  observedPoint: $('observed-point'),
  forecastCard: $('forecast-card'),
  forecastDate: $('forecast-date'),
  forecastProb: $('forecast-prob'),
  forecastLevel: $('forecast-level'),
  forecastBar: $('forecast-bar'),
  forecastDriver: $('forecast-driver'),
  chartRisk: $('chart-risk'),
  pointTitle: $('point-title'),
  pointCoords: $('point-coords'),
  chartPoint: $('chart-point'),
  pointStatus: $('point-status'),
  play: $('play'),
  track: $('track'),
  segObserved: $('seg-observed'),
  nowTick: $('now-tick'),
  segForecast: $('seg-forecast'),
  dateSlider: $('date-slider'),
  ticks: $('ticks'),
  timelineDate: $('timeline-date'),
  page: $('page'),
  signinForm: $('signin-form'),
  signupForm: $('signup-form'),
  pwError: $('pw-error'),
  notfound: $('notfound'),
  signupPassword: $('signup-password'),
  signupConfirm: $('signup-confirm'),
  dlgMethod: $('dlg-method'),
  dlgAbout: $('dlg-about'),
  announcer: $('announcer'),
};

const pillMain = el.modePill ? el.modePill.querySelector('.pill-main') : null;
const pillSuffix = el.modePill ? el.modePill.querySelector('.pill-suffix') : null;
const riskSlot = el.chartRisk ? el.chartRisk.querySelector('.chart-slot') : null;
const pointSlot = el.chartPoint ? el.chartPoint.querySelector('.chart-slot') : null;
const pointCaption = el.chartPoint ? el.chartPoint.querySelector('figcaption') : null;
const playIcon = el.play ? el.play.querySelector('.icon-play') : null;
const pauseIcon = el.play ? el.play.querySelector('.icon-pause') : null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');
const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function setHidden(node, hidden) {
  if (node && node.hidden !== Boolean(hidden)) node.hidden = Boolean(hidden);
}

function setAttr(node, name, value) {
  if (!node) return;
  const v = String(value);
  if (node.getAttribute(name) !== v) node.setAttribute(name, v);
}

function capitalise(s) {
  const str = String(s || '');
  return str ? str[0].toUpperCase() + str.slice(1) : '';
}

function formatCoords(lng, lat) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}° ${ns}, ${Math.abs(lng).toFixed(3)}° ${ew}`;
}

function insideBounds(point, bounds) {
  return point.lng >= bounds.west && point.lng <= bounds.east && point.lat >= bounds.south && point.lat <= bounds.north;
}

/** The hazard's timeline: fetched if present, else the registry when offline mode. */
function timelineFor(hazardId) {
  const fetched = cache.timelines.get(hazardId);
  if (fetched) return fetched;
  if (!CONFIG.useLiveBackend) return timelineOf(getHazard(hazardId));
  return [];
}

function lastObservedIndex(timeline) {
  let last = -1;
  timeline.forEach((s, i) => {
    if (s.kind === 'observed') last = i;
  });
  return last;
}

/** Memoised change image per hazard|baseline|idx (same inputs → same URL). */
function changeUrlFor(hazardId, baseline, idx, rasters) {
  const key = `${hazardId}|${baseline}|${idx}`;
  if (cache.changeUrls.has(key)) return cache.changeUrls.get(key);
  const base = rasters[baseline];
  const cur = rasters[idx];
  if (!base || !cur) return null;
  const url = telemetry.changeImage(base.imageData, cur.imageData, baseline === idx);
  cache.changeUrls.set(key, url);
  return url;
}

/* ------------------------------------------------------------------ */
/* deriveView: pure with respect to (state, cache)                      */
/* ------------------------------------------------------------------ */

function deriveView(st) {
  const hazard = getHazard(st.hazard) || defaultHazard();
  const timeline = timelineFor(hazard.id);
  const len = timeline.length;
  const observedCount = timeline.filter((s) => s.kind === 'observed').length;
  const forecastCount = len - observedCount;
  const hasForecast = forecastCount > 0;

  const idx = len && st.idx !== null && st.idx !== undefined ? Math.min(len - 1, Math.max(0, st.idx)) : null;
  const step = idx === null ? null : timeline[idx];
  const isForecast = Boolean(step && step.kind === 'forecast');

  // Lock 1: the raster opacity is exactly CONFIG.forecastOpacity on forecast
  // dates; the observed setting is read, never written, here.
  const imageIndex = idx === null ? null : isForecast ? observedCount - 1 : idx;
  const rasterOpacity = isForecast ? CONFIG.forecastOpacity : st.observedOpacity / 100;

  const rasters = cache.rasters.get(hazard.id) || null;
  const rasterStatus = cache.rasterStatus.get(hazard.id) || 'idle';
  const rastersReady = Boolean(rasters && rasters.length === observedCount && observedCount > 0);
  const rasterVisible = !st.errors.asset;
  const rasterUrl = rastersReady && imageIndex !== null && rasters[imageIndex] ? rasters[imageIndex].url : null;

  // Lock 2: no difference layer on a forecast date, ever.
  // A failed raster/change image hides the difference layer too.
  const showChange = !isForecast && st.mode === 'change' && rastersReady && !st.errors.asset;
  let changeUrl = null;
  let changeError = '';
  if (showChange) {
    try {
      changeUrl = changeUrlFor(hazard.id, st.baseline, idx, rasters);
    } catch (err) {
      changeError = `Change image unavailable (${err && err.message ? err.message : 'error'}). No substitute is drawn.`;
    }
  }

  const riskGeojson = step ? hazard.riskExtents(step.kind, idx) : { type: 'FeatureCollection', features: [] };
  const riskKey = step ? `${hazard.id}|${step.kind}|${idx}` : `${hazard.id}|none`;

  const probability = isForecast && Number.isFinite(Number(step.probability)) ? Number(step.probability) : null;
  const level = probability === null ? null : levelFor(probability);
  const driver = isForecast && step.driver ? String(step.driver) : '';

  // Lock 7: the point series has exactly observedCount entries or is null.
  const scale = POINT_SCALES[hazard.raster] || POINT_SCALES.sar;
  let series = null;
  const pointInside = Boolean(st.point && Number.isFinite(st.point.lng) && Number.isFinite(st.point.lat));
  if (pointInside && rastersReady) {
    const raw = rasters.map((r) => telemetry.sample(r.imageData, hazard.bounds, st.point.lng, st.point.lat));
    if (raw.length === observedCount) {
      series = raw.map((v) => (v === null ? null : Math.round(scale.map(v) * 100) / 100));
    }
  }

  let pointStatus;
  if (st.errors.asset) pointStatus = COPY.pointUnavailable;
  else if (!st.point) pointStatus = COPY.pointIdle;
  else if (st.point.outside) pointStatus = COPY.pointOutside;
  else if (!series) pointStatus = rasterStatus === 'error' ? COPY.pointUnavailable : COPY.pointWaiting;
  else {
    const n = series.filter((v) => v !== null).length;
    pointStatus = `${n} observed value${n === 1 ? '' : 's'} at ${formatCoords(st.point.lng, st.point.lat)}.`
      + (hasForecast ? ' Nothing after NOW: no satellite pass has occurred.' : '');
  }

  const pointCoords = pointInside ? formatCoords(st.point.lng, st.point.lat) : formatCoords(hazard.coords[0], hazard.coords[1]);

  let compoundGeojson = null;
  let compoundKey = '';
  if (st.compound) {
    const kind = step ? step.kind : 'observed';
    const ci = idx === null ? 0 : idx;
    compoundGeojson = {
      seismic: hazard.id === 'earthquake' ? null : HAZARD_REGISTRY.earthquake.riskExtents(kind, ci),
      tsunami: hazard.id === 'tsunami' ? null : HAZARD_REGISTRY.tsunami.riskExtents(kind, ci),
    };
    compoundKey = `${kind}|${ci}`;
  }

  return {
    hazard,
    timeline,
    len,
    observedCount,
    forecastCount,
    hasForecast,
    idx,
    step,
    stepKind: step ? step.kind : 'observed',
    isForecast,
    imageIndex,
    rasterOpacity,
    rasterVisible,
    rasterUrl,
    rastersReady,
    rasterStatus,
    showChange,
    changeUrl,
    changeError,
    riskGeojson,
    riskKey,
    showRisk: st.showRisk,
    showReticle: st.showReticle,
    point: pointInside ? st.point : null,
    probability,
    level,
    driver,
    series,
    pointScale: scale,
    pointStatus,
    pointCoords,
    compound: st.compound,
    compoundGeojson,
    compoundKey,
    footprint: footprintKm(hazard.bounds),
  };
}

/* ------------------------------------------------------------------ */
/* render()                                                             */
/* ------------------------------------------------------------------ */

function renderTicks(view) {
  const signature = view.timeline.map((s) => `${s.kind}:${s.date}`).join(',');
  if (signature !== lastTickSignature) {
    const frag = document.createDocumentFragment();
    view.timeline.forEach((s, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.index = String(i);
      btn.dataset.kind = s.kind === 'forecast' ? 'forecast' : 'observed';
      btn.textContent = formatShort(s.date);
      btn.setAttribute('aria-label', `${s.kind === 'forecast' ? 'Forecast' : 'Observed sample pass'}, ${formatSpoken(s.date)}`);
      li.appendChild(btn);
      frag.appendChild(li);
    });
    el.ticks.replaceChildren(frag);
    lastTickSignature = signature;
  }
  const buttons = el.ticks.querySelectorAll('button[data-index]');
  buttons.forEach((btn) => {
    const active = Number(btn.dataset.index) === view.idx;
    if (active) setAttr(btn, 'aria-current', 'true');
    else if (btn.hasAttribute('aria-current')) btn.removeAttribute('aria-current');
  });
}

function renderBaselineOptions(view) {
  const observed = view.timeline.filter((s) => s.kind === 'observed');
  const signature = `${view.hazard.id}|${observed.map((s) => s.date).join(',')}`;
  if (signature !== lastBaselineSignature) {
    const frag = document.createDocumentFragment();
    observed.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = formatDate(s.date);
      frag.appendChild(opt);
    });
    el.baseline.replaceChildren(frag);
    lastBaselineSignature = signature;
  }
  const want = String(Math.min(Math.max(0, state.baseline), Math.max(0, observed.length - 1)));
  if (el.baseline.value !== want) el.baseline.value = want;
}

function render() {
  const view = deriveView(state);
  const { hazard, step, idx, isForecast, hasForecast, observedCount, forecastCount, len } = view;
  const stepDate = step ? formatDate(step.date) : '—';

  // 1. Root attributes (the only JS → CSS channel). Lock 3 colour/shape
  //    changes hang off data-mode="forecast".
  setAttr(el.html, 'data-mode', isForecast ? 'forecast' : 'observed');
  setAttr(el.html, 'data-hazard', hazard.id);
  setAttr(el.html, 'data-route', state.route);
  if (hasForecast) {
    if (el.html.hasAttribute('data-forecasts')) el.html.removeAttribute('data-forecasts');
  } else {
    setAttr(el.html, 'data-forecasts', 'none');
  }

  // 2. Top bar.
  const radio = el.hazardSwitch.querySelector(`input[name="hazard"][value="${hazard.id}"]`);
  if (radio && !radio.checked) radio.checked = true;
  if (el.compoundToggle.checked !== state.compound) el.compoundToggle.checked = state.compound;
  setText(el.targetName, `TARGET: ${hazard.targetName}`);
  setText(el.targetCoords, formatCoords(hazard.coords[0], hazard.coords[1]));
  setText(el.targetFootprint, `FOOTPRINT: ${view.footprint.label}`);
  // Lock 3 wording: the pill reads FORECAST MODE // MODEL PROJECTION.
  setText(pillMain, isForecast ? '◆ FORECAST MODE' : '● OBSERVED PASS');
  setText(pillSuffix, isForecast ? ' // MODEL PROJECTION' : ' // MEASURED');

  // 3. Controls.
  setText(el.passDate, stepDate);
  if (!step) setText(el.passIndex, state.errors.backend ? 'NO TIMELINE' : 'LOADING');
  else if (isForecast) setText(el.passIndex, `FORECAST ${pad2(idx - observedCount + 1)} / ${pad2(forecastCount)}`);
  else setText(el.passIndex, `PASS ${pad2(idx + 1)} / ${pad2(observedCount)}`);
  // Lock 4: the no-pass alert.
  setHidden(el.noPassAlert, !isForecast);

  // Lock 2: both view-mode buttons disabled; the baseline selector hidden.
  const changeBlocked = isForecast || !view.rastersReady;
  if (el.btnRadar.disabled !== isForecast) el.btnRadar.disabled = isForecast;
  if (el.btnChange.disabled !== changeBlocked) el.btnChange.disabled = changeBlocked;
  setAttr(el.btnRadar, 'aria-pressed', state.mode === 'radar' ? 'true' : 'false');
  setAttr(el.btnChange, 'aria-pressed', state.mode === 'change' ? 'true' : 'false');
  // Keyed on the derived flag: no selector when no change layer can show.
  setHidden(el.baselineWrap, !view.showChange);
  renderBaselineOptions(view);

  // Lock 1: the opacity control shows 35, is disabled and reads LOCKED. The
  // control's value is derived; state.observedOpacity is untouched.
  const opacityValue = isForecast ? 35 : state.observedOpacity;
  if (el.opacity.disabled !== isForecast) el.opacity.disabled = isForecast;
  if (Number(el.opacity.value) !== opacityValue) el.opacity.value = String(opacityValue);
  setAttr(el.opacity, 'aria-valuetext', isForecast ? 'Locked at 35 percent, context only' : `${opacityValue} percent`);
  setText(el.opacityReadout, `${opacityValue}%`);
  setHidden(el.opacityLock, !isForecast);

  if (el.toggleRisk.checked !== state.showRisk) el.toggleRisk.checked = state.showRisk;
  if (el.toggleReticle.checked !== state.showReticle) el.toggleReticle.checked = state.showReticle;

  // Legend variants.
  setHidden(el.legendRadar, isForecast || view.showChange);
  setHidden(el.legendChange, !view.showChange);
  setHidden(el.legendForecast, !isForecast);
  setHidden(el.legendRisk, !state.showRisk);
  const changeTexts = el.legendChange.querySelectorAll('.legend-text');
  if (changeTexts[0]) setText(changeTexts[0], capitalise(hazard.changeLabels.darker));
  if (changeTexts[1]) setText(changeTexts[1], capitalise(hazard.changeLabels.brighter));
  const suffix = isForecast ? ' (projected extent, dashed)' : ' (measured extent)';
  el.legendRisk.querySelectorAll('li').forEach((li) => {
    const mark = li.querySelector('.legend-mark');
    const text = li.querySelector('.legend-text');
    const risk = mark ? mark.dataset.risk : '';
    const label = hazard.riskLabels[risk] || risk;
    setText(text, `${capitalise(label)}${suffix}`);
  });

  // 4. Evidence.
  setHidden(el.observedCard, isForecast);
  setHidden(el.forecastCard, !isForecast);
  if (step && !isForecast) {
    setText(el.observedPass, `${pad2(idx + 1)} / ${pad2(observedCount)} · ${stepDate}`);
    const observed = view.timeline.filter((s) => s.kind === 'observed');
    const base = observed[state.baseline];
    setText(
      el.observedBaseline,
      state.mode === 'change' && base ? `${formatDate(base.date)} · change view` : 'None · radar image view',
    );
  } else if (!step) {
    setText(el.observedPass, '—');
    setText(el.observedBaseline, 'None · radar image view');
  }
  let pointText = 'None';
  if (view.point) pointText = view.pointCoords;
  else if (state.point && state.point.outside) pointText = 'Outside radar footprint';
  setText(el.observedPoint, pointText);

  // Lock 5: the prediction card (the exact disclaimer lives in the HTML).
  if (isForecast) {
    setText(el.forecastDate, stepDate);
    const pct = view.probability === null ? null : Math.round(view.probability * 100);
    setText(el.forecastProb, pct === null ? '—%' : `${pct}%`);
    setText(el.forecastLevel, view.level ? view.level.toUpperCase() : '—');
    setAttr(el.forecastLevel, 'data-level', view.level || 'low');
    el.forecastBar.style.setProperty('--p', String(pct === null ? 0 : pct));
    setAttr(el.forecastBar.parentElement, 'aria-label', `Sample probability bar, ${pct === null ? 'no value' : `${pct} percent`}`);
    setText(el.forecastDriver, view.driver || 'Simulated driver: —');
  }

  // Lock 6 (charts): NOW boundary, hatched future, dashed model segments are
  // produced by charts.js from the timeline kinds. Lock 7: the point chart
  // receives exactly observedCount values or null.
  const riskSvg = riskChart({ timeline: view.timeline, activeIndex: idx, label: hazard.primaryMetricLabel });
  if (riskSvg !== lastRiskSvg) {
    riskSlot.innerHTML = riskSvg;
    lastRiskSvg = riskSvg;
  }
  const pointSvg = pointChart({
    values: view.series,
    timeline: view.timeline,
    activeIndex: idx,
    label: hazard.pointSeriesLabel,
    unit: hazard.pointUnit,
    noun: hazard.pointNoun,
    yDomain: view.pointScale.domain,
    emptyMessage: state.errors.asset || view.rasterStatus === 'error'
      ? 'Raster unavailable'
      : state.point && state.point.outside
        ? 'No coverage'
        : view.point
          ? 'Loading rasters'
          : 'No point selected',
  });
  if (pointSvg !== lastPointSvg) {
    pointSlot.innerHTML = pointSvg;
    lastPointSvg = pointSvg;
  }
  setText(el.pointTitle, hazard.pointSeriesLabel);
  setText(el.pointCoords, view.pointCoords);
  setText(pointCaption, `No future ${hazard.pointNoun} values — ever.`);
  setText(el.pointStatus, view.pointStatus);
  setAttr(el.evidence, 'aria-busy', view.rasterStatus === 'loading' ? 'true' : 'false');

  // Errors: explicit, never a substitute.
  const mapText = [state.errors.map, state.errors.backend].filter(Boolean).join(' ');
  setText(el.mapError, mapText);
  setHidden(el.mapError, !mapText);
  const assetText = state.errors.asset || view.changeError;
  setText(el.assetError, assetText);
  setHidden(el.assetError, !assetText);

  // 5. Timeline.
  const sliderMax = Math.max(0, len - 1);
  setAttr(el.dateSlider, 'max', sliderMax);
  if (el.dateSlider.disabled !== (len < 2)) el.dateSlider.disabled = len < 2;
  if (idx !== null && Number(el.dateSlider.value) !== idx) el.dateSlider.value = String(idx);
  const spoken = step ? (isForecast ? `Forecast, ${formatSpoken(step.date)}` : `Observed sample pass, ${formatSpoken(step.date)}`) : COPY.noTimeline;
  setAttr(el.dateSlider, 'aria-valuetext', spoken);

  // Track geometry: --obs / --fc are plain numbers; the NOW line sits at
  // obs/(obs+fc) of the width, i.e. midway between the last observed and the
  // first forecast thumb stop when obs = observed − 0.5 and fc = forecast − 0.5.
  const obs = hasForecast ? observedCount - 0.5 : Math.max(1, observedCount);
  const fc = hasForecast ? forecastCount - 0.5 : 0;
  el.track.style.setProperty('--obs', String(obs));
  el.track.style.setProperty('--fc', String(fc));
  const lastObs = lastObservedIndex(view.timeline);
  const segObs = el.segObserved.querySelector('.meta');
  const segNow = el.nowTick.querySelector('.meta');
  const segFc = el.segForecast.querySelector('.meta');
  setText(segObs, observedCount ? `OBSERVED PASSES (01–${pad2(observedCount)})` : 'OBSERVED PASSES');
  setText(segNow, lastObs >= 0 ? `NOW (${formatDate(view.timeline[lastObs].date)})` : 'NOW');
  setText(segFc, hasForecast ? `FORECAST HORIZON (${pad2(observedCount + 1)}–${pad2(len)})` : 'FORECAST HORIZON');

  renderTicks(view);

  // Lock 3 wording on the date readout.
  setText(el.timelineDate, step ? (isForecast ? `FORECAST · ${stepDate}` : stepDate) : '—');

  setAttr(el.play, 'aria-label', state.playing ? 'Pause' : 'Play');
  setHidden(playIcon, state.playing);
  setHidden(pauseIcon, !state.playing);
  if (el.play.disabled !== (len < 2)) el.play.disabled = len < 2;

  // 6. Map.
  if (map && mapReady) {
    try {
      applyMapState(map, view);
    } catch (err) {
      const msg = `Map tiles failed to load (${err && err.message ? err.message : 'render error'}). The radar overlay and charts are unaffected.`;
      if (state.errors.map !== msg) {
        state.errors.map = msg;
        mapLastError = msg;
        const text = [msg, state.errors.backend].filter(Boolean).join(' ');
        setText(el.mapError, text);
        setHidden(el.mapError, false);
      }
    }
  }

  // 7. Announce only when the pass or the hazard changed.
  const announceKey = step ? `${hazard.id}|${idx}` : '';
  if (announceKey && announceKey !== lastAnnounced) {
    lastAnnounced = announceKey;
    setText(el.announcer, spoken);
  }
}

/* ------------------------------------------------------------------ */
/* Data loading (timeline + rasters), never substituting                */
/* ------------------------------------------------------------------ */

async function loadHazard(hazardId) {
  const token = ++loadToken;
  const hazard = getHazard(hazardId);
  if (!hazard) return;

  // Timeline (registry, or the live backend when enabled).
  state.errors.backend = '';
  let timeline;
  try {
    timeline = await telemetry.getTimeline(hazardId);
  } catch (err) {
    if (token !== loadToken || state.hazard !== hazardId) return;
    cache.timelines.delete(hazardId);
    state.errors.backend = err && err.message ? err.message : ERROR_COPY.backend('unknown error');
    state.idx = null;
    render();
    return;
  }
  cache.timelines.set(hazardId, timeline);
  if (token !== loadToken || state.hazard !== hazardId) return;
  if (state.idx === null || state.idx >= timeline.length) {
    state.idx = Math.max(0, lastObservedIndex(timeline));
  }
  render();

  // Rasters for every observed pass, in parallel. Any failure sets the asset
  // error, hides the raster and leaves the series empty: no fallback image.
  const observed = telemetry.observedSteps(hazardId);
  if (!cache.rasters.has(hazardId)) {
    cache.rasterStatus.set(hazardId, 'loading');
    render();
    try {
      const rasters = await Promise.all(observed.map((_, i) => telemetry.getRaster(hazardId, i)));
      cache.rasters.set(hazardId, rasters);
      cache.rasterStatus.set(hazardId, 'ready');
    } catch (err) {
      cache.rasterStatus.set(hazardId, 'error');
      if (state.hazard === hazardId) {
        const base = err && err.message ? err.message : 'Could not load the raster';
        state.errors.asset = base.endsWith('.') ? `${base.slice(0, -1)}${ERROR_COPY.assetSuffix}` : `${base}${ERROR_COPY.assetSuffix}`;
      }
    }
  }
  if (token !== loadToken || state.hazard !== hazardId) return;
  render();
}

/* ------------------------------------------------------------------ */
/* Play timer                                                           */
/* ------------------------------------------------------------------ */

function stopPlaying() {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  state.playing = false;
}

function startPlaying() {
  stopPlaying();
  const len = timelineFor(state.hazard).length;
  if (len < 2) return;
  state.playing = true;
  playTimer = setInterval(() => {
    const n = timelineFor(state.hazard).length;
    if (n < 2) {
      stopPlaying();
      render();
      return;
    }
    // Wraps from the last forecast back to the first observed pass; the
    // observed behaviour is restored by render() because every lock is derived.
    state.idx = ((state.idx === null ? -1 : state.idx) + 1) % n;
    render();
  }, Math.max(100, Number(CONFIG.playIntervalMs) || 1000));
}

/* ------------------------------------------------------------------ */
/* Hazard switch                                                        */
/* ------------------------------------------------------------------ */

function switchHazard(hazardId) {
  const hazard = getHazard(hazardId);
  if (!hazard || hazardId === state.hazard) return;
  stopPlaying();
  state.hazard = hazardId;
  state.idx = CONFIG.useLiveBackend && !cache.timelines.has(hazardId) ? null : Math.max(0, lastObservedIndex(timelineFor(hazardId)));
  state.point = null;
  state.mode = 'radar';
  state.baseline = 0;
  state.errors.asset = '';
  // Library and style/tile failures are global to the map, not to a hazard.
  state.errors.map = mapFatal || mapLastError;
  render();
  loadHazard(hazardId);
  if (map) refitCamera(map, hazard, isMobile(), true);
}

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

function setIndex(i) {
  const len = timelineFor(state.hazard).length;
  if (!len || !Number.isFinite(i)) return;
  stopPlaying();
  state.idx = Math.min(len - 1, Math.max(0, Math.round(i)));
  render();
}

function bindEvents() {
  el.dateSlider.addEventListener('input', () => setIndex(Number(el.dateSlider.value)));

  el.ticks.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (!btn || !el.ticks.contains(btn)) return;
    setIndex(Number(btn.dataset.index));
  });

  const chartClick = (e) => {
    const hit = e.target.closest('[data-index]');
    if (!hit) return;
    setIndex(Number(hit.getAttribute('data-index')));
  };
  el.chartRisk.addEventListener('click', chartClick);
  el.chartPoint.addEventListener('click', chartClick);

  el.play.addEventListener('click', () => {
    if (state.playing) stopPlaying();
    else startPlaying();
    render();
  });

  el.btnRadar.addEventListener('click', () => {
    if (el.btnRadar.disabled) return;
    state.mode = 'radar';
    render();
  });
  el.btnChange.addEventListener('click', () => {
    if (el.btnChange.disabled) return;
    state.mode = 'change';
    render();
  });

  el.baseline.addEventListener('change', () => {
    const v = Number(el.baseline.value);
    if (Number.isFinite(v)) state.baseline = v;
    render();
  });

  el.opacity.addEventListener('input', () => {
    // Forecast dates never write back: the control is disabled, and even a
    // synthetic event is ignored while the view is a forecast.
    // render() puts the control back to the locked 35.
    if (deriveView(state).isForecast) {
      render();
      return;
    }
    const v = Number(el.opacity.value);
    if (Number.isFinite(v)) state.observedOpacity = Math.min(100, Math.max(0, v));
    render();
  });

  el.toggleRisk.addEventListener('change', () => {
    state.showRisk = el.toggleRisk.checked;
    render();
  });
  el.toggleReticle.addEventListener('change', () => {
    state.showReticle = el.toggleReticle.checked;
    render();
  });
  el.compoundToggle.addEventListener('change', () => {
    state.compound = el.compoundToggle.checked;
    render();
  });

  el.hazardSwitch.addEventListener('change', (e) => {
    const input = e.target;
    if (input && input.name === 'hazard' && input.checked) switchHazard(input.value);
  });

  // Menu toggle (mobile dropdown).
  el.menuToggle.addEventListener('click', () => {
    const expanded = el.menuToggle.getAttribute('aria-expanded') === 'true';
    el.menuToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.menuToggle.getAttribute('aria-expanded') === 'true') {
      el.menuToggle.setAttribute('aria-expanded', 'false');
      el.menuToggle.focus();
    }
  });

  // Dialogs: showModal/close, Escape closes natively, focus returns to the opener.
  const bindDialog = (opener, dialog) => {
    opener.addEventListener('click', () => {
      dialogOpener = opener;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
    dialog.querySelectorAll('.dialog-close').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      });
    });
    dialog.addEventListener('close', () => {
      if (dialogOpener && typeof dialogOpener.focus === 'function') dialogOpener.focus();
      dialogOpener = null;
    });
  };
  bindDialog(el.openMethod, el.dlgMethod);
  bindDialog(el.openAbout, el.dlgAbout);

  // Forms: prevent submission, validate, reset, route. Nothing is read into
  // state, stored, logged or sent.
  el.signinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!el.signinForm.checkValidity()) {
      el.signinForm.reportValidity();
      return;
    }
    el.signinForm.reset();
    window.location.hash = '#/';
  });

  el.signupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!el.signupForm.checkValidity()) {
      el.signupForm.reportValidity();
      return;
    }
    if (el.signupPassword.value !== el.signupConfirm.value) {
      setText(el.pwError, COPY.pwMismatch);
      setHidden(el.pwError, false);
      el.signupConfirm.setAttribute('aria-invalid', 'true');
      el.signupConfirm.focus();
      return;
    }
    setHidden(el.pwError, true);
    el.signupConfirm.removeAttribute('aria-invalid');
    el.signupForm.reset();
    window.location.hash = '#/signin';
  });
  const clearPwError = () => {
    if (!el.pwError.hidden) {
      setHidden(el.pwError, true);
      el.signupConfirm.removeAttribute('aria-invalid');
    }
  };
  el.signupPassword.addEventListener('input', clearPwError);
  el.signupConfirm.addEventListener('input', clearPwError);

  // Mobile drawers are exclusive: both open at once would overlap, since
  // the evidence drawer grows upward over the controls drawer. (Desktop keeps
  // both open; their summaries are not rendered there.)
  const exclusive = (opened, other) => {
    opened.addEventListener('toggle', () => {
      if (opened.open && other.open && isMobile()) other.open = false;
    });
  };
  exclusive(el.controlsDrawer, el.evidenceDrawer);
  exclusive(el.evidenceDrawer, el.controlsDrawer);

  // Camera follows the viewport.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (map && state.route === 'home') refitCamera(map, getHazard(state.hazard) || defaultHazard(), isMobile(), false);
    }, 150);
  });

  window.addEventListener('hashchange', route);
}

/* ------------------------------------------------------------------ */
/* Map click                                                            */
/* ------------------------------------------------------------------ */

function onMapClick(lngLat) {
  if (state.route !== 'home') return;
  const hazard = getHazard(state.hazard) || defaultHazard();
  if (insideBounds(lngLat, hazard.bounds)) {
    state.point = { lng: lngLat.lng, lat: lngLat.lat };
  } else {
    state.point = { outside: true };
  }
  render();
}

function onMapError(message, info) {
  const sourceId = info && info.sourceId ? info.sourceId : '';
  if (sourceId === 'raster' || sourceId === 'change') {
    // An overlay image failed inside MapLibre: hide the raster, no substitute.
    const detail = info && info.detail ? info.detail : 'image error';
    const msg = `Could not load the ${sourceId} image (${detail})${ERROR_COPY.assetSuffix}`;
    if (state.errors.asset !== msg) {
      state.errors.asset = msg;
      render();
    }
    return;
  }
  // Before the style has loaded, a failure with no source means the style
  // itself failed: the overlays are never added, so don't claim they are fine.
  const text = !mapReady && !sourceId
    ? `Map unavailable: the basemap style failed to load (${info && info.detail ? info.detail : 'unknown error'}). Map overlays cannot be drawn; controls and evidence still work.`
    : message;
  mapLastError = text;
  if (state.errors.map !== text) {
    state.errors.map = text;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                               */
/* ------------------------------------------------------------------ */

function parseRoute(hash) {
  const h = String(hash || '');
  if (h === '' || h === '#' || h === '#/') return { name: 'home', anchor: null };
  if (h === '#/signin') return { name: 'signin', anchor: null };
  if (h === '#/signup') return { name: 'signup', anchor: null };
  // A plain in-page anchor (the skip link's "#controls") is not a page.
  if (!h.startsWith('#/')) {
    const target = document.getElementById(h.slice(1));
    if (target) return { name: 'home', anchor: target };
  }
  return { name: 'notfound', anchor: null };
}

function focusFirst(container) {
  if (!container) return;
  const target = container.querySelector('h1, h2, h3') || container.querySelector('input, select, textarea') || container.querySelector('a, button');
  if (!target) return;
  if (!target.hasAttribute('tabindex') && !/^(INPUT|SELECT|TEXTAREA|A|BUTTON)$/.test(target.tagName)) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus();
}

function route() {
  const { name, anchor } = parseRoute(window.location.hash);
  const previous = currentRoute;

  // Leaving a form route resets its form.
  if (previous === 'signin' && name !== 'signin') el.signinForm.reset();
  if (previous === 'signup' && name !== 'signup') {
    el.signupForm.reset();
    setHidden(el.pwError, true);
    el.signupConfirm.removeAttribute('aria-invalid');
  }

  if (name !== 'home') stopPlaying();
  state.route = name;
  currentRoute = name;
  el.menuToggle.setAttribute('aria-expanded', 'false');

  setHidden(el.signinForm, name !== 'signin');
  setHidden(el.signupForm, name !== 'signup');
  setHidden(el.notfound, name !== 'notfound');
  setHidden(el.page, name === 'home');

  render();

  if (name === 'signin') focusFirst(el.signinForm);
  else if (name === 'signup') focusFirst(el.signupForm);
  else if (name === 'notfound') focusFirst(el.notfound);
  else if (anchor) {
    if (!anchor.hasAttribute('tabindex')) anchor.setAttribute('tabindex', '-1');
    anchor.focus();
  } else if (previous !== null && previous !== 'home') {
    focusFirst(el.controls);
    if (map) refitCamera(map, getHazard(state.hazard) || defaultHazard(), isMobile(), false);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

function boot() {
  // Offline mode: the registry timeline is synchronous, so the first render
  // already shows the last observed pass. Backend mode waits for the fetch.
  if (!CONFIG.useLiveBackend) {
    state.idx = Math.max(0, lastObservedIndex(timelineFor(state.hazard)));
  }

  bindEvents();

  // 2. Map, guarded. Failure is reported, never fatal.
  const hazard = getHazard(state.hazard) || defaultHazard();
  try {
    map = createMap(el.map, {
      style: CONFIG.basemapStyle,
      hazard,
      isMobile: isMobile(),
      onClick: onMapClick,
      onError: onMapError,
    });
  } catch (err) {
    map = null;
    const msg = err && err.message === 'Map library failed to load' ? COPY.mapMissing : COPY.mapFailed(err && err.message ? err.message : 'map could not start');
    mapFatal = msg;
    state.errors.map = msg;
  }

  // 3. On load: recolour, add the layers, render.
  if (map) {
    map.on('load', () => {
      try {
        styleBasemap(map);
        addLayers(map, getHazard(state.hazard) || defaultHazard());
        mapReady = true;
      } catch (err) {
        state.errors.map = `Map layers could not be added (${err && err.message ? err.message : 'layer setup failed'}). Controls and evidence still work.`;
        mapLastError = state.errors.map;
      }
      render();
    });
  }

  // 4. Timeline and rasters.
  loadHazard(state.hazard);

  // 5. Route (also performs a render).
  route();

  // 6. Drawers start closed on narrow viewports.
  if (isMobile()) {
    el.controlsDrawer.open = false;
    el.evidenceDrawer.open = false;
  }

  // 7. First render, so the UI works without the map.
  render();

  // 8. Test hook for the acceptance script: a map handle and a simulated
  //    map click at a coordinate. Read-only access; it goes through the same
  //    onMapClick → state → render() path as a real click.
  window.__spaceapp = Object.freeze({
    get map() {
      return map;
    },
    inspect(lng, lat) {
      onMapClick({ lng: Number(lng), lat: Number(lat) });
    },
  });
}

boot();
