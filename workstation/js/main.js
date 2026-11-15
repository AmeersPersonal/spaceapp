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
import { createMap, styleBasemap, addLayers, applyMapState, refitCamera, hideDemoLayers, paddingFor } from './map.js';
import { api, probe, clearApiCache } from './api.js';
import { addLiveLayers, applyLiveMap, outlookCellAt, fitBox } from './liveMap.js';
import { loadBrowseImage } from './browse.js';
import { RoomClient, replayFrameAt } from './room.js';
import { simHazardFor, simFrame } from './simulate.js';
import {
  liveTimeline,
  lastMonths,
  setRangeEnd,
  MAX_SEARCH_DAYS,
  NISAR_LAUNCH,
  isoDay,
  areaAround,
  wrapLng,
  unionBounds,
  boundsOf,
  outlookBoxFrom,
  layerLabel,
  formatLngLat,
} from './explore.js';
import {
  renderEventHead,
  renderProjection,
  renderBriefing,
  renderAskLog,
  renderContext,
  renderMedia,
  renderScenes,
  renderArea,
  renderOutlook,
  h,
} from './live.js';

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
  sessionEnded: 'Your session has ended. Sign in again.',
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
  // Earth Replay API link (js/api.js probe). The demo channels never read it;
  // the LIVE channel is built from it.
  api: {
    status: 'checking' /* checking | online | offline */,
    eventCount: 0,
    user: null,
    auth: 'checking' /* checking | signed-in | signed-out | unavailable */,
    authMessage: '',
    error: '',
  },
  // 'demo' = the three synthetic channels; 'live' = channel 04, the Earth Replay API.
  source: 'demo',
  live: {
    events: { status: 'idle', list: [], message: '' },
    eventId: '',
    detail: { status: 'idle' },
    replay: null /* { id, name, bbox, scenes, eventTime? } — previews found by a search, not tracked */,
    idx: null,
    pendingFrame: null /* a frame from a replay room, applied once the event loads */,
    layer: 'preview',
    panel: 'event' /* event | area | outlook */,
    area: null /* { id, lng, lat, bbox } */,
    range: lastMonths(6),
    results: { nisar: { status: 'idle' }, quakes: { status: 'idle' }, context: { status: 'idle' } },
    busy: '',
    notice: '',
    actionError: '',
    predict: { status: 'idle' },
    brief: { status: 'idle' },
    context: { status: 'idle' },
    media: { status: 'idle' },
    ask: { turns: [], busy: false, error: '', chatId: null, history: '' },
    outlookOn: false,
    // "Simulated illustration": the demo generators run on the event's area.
    // FABRICATED frames, shown only with #sim-badge and #provenance-sim.
    sim: false,
    simModel: 'auto' /* auto | volcano | flood | quake | tsunami */,
    horizon: 30,
    outlookBox: null,
    outlook: { status: 'idle' },
    cell: null,
    room: { status: 'idle' /* idle | connecting | open | closed | error */, code: '', count: 0, message: '' },
  },
};

// Data caches: not UI state, but inputs deriveView reads alongside `state`.
const cache = {
  timelines: new Map(), // hazardId → timeline array (fetched)
  rasters: new Map(), // hazardId → array of { canvas, imageData, url, source }
  rasterStatus: new Map(), // hazardId → 'loading' | 'ready' | 'error'
  changeUrls: new Map(), // `${hazard}|${baseline}|${idx}` → data URL
  browse: new Map(), // live scene id → { status: 'loading'|'ready'|'error', url, coordinates, message }
};

let liveLayersReady = false;
let demoHidden = false; // demo layers currently hidden by hideDemoLayers
let liveSeq = 0; // guards stale live fetches (event switches)
const room = new RoomClient({
  onStatus: (status, message) => {
    state.live.room = { ...state.live.room, status, message: message || '' };
    if (status === 'open') {
      // A fresh room adopts what this viewer is looking at.
      room.send({ type: 'sync' });
    }
    render();
  },
  onPresence: (count) => {
    state.live.room = { ...state.live.room, count };
    render();
  },
  onState: (st, serverTime) => applyRoomState(st, serverTime),
  onError: (message) => {
    state.live.room = { ...state.live.room, message };
    render();
  },
});

const telemetry = new TelemetryService(CONFIG, HAZARD_REGISTRY);

let map = null;
let mapReady = false;
let mapFatal = ''; // the library/constructor failure, which hazard switches must not clear
let mapLastError = ''; // the last style/tile failure, also kept across hazard switches
let playTimer = null;
let loadToken = 0;
let areaQueryTimer = null;
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
  backendStatus: $('backend-status'),
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
  signinStatus: $('signin-status'),
  signupStatus: $('signup-status'),
  signinSubmit: $('signin-submit'),
  signupSubmit: $('signup-submit'),
  signinSignout: $('signin-signout'),
  notfound: $('notfound'),
  navSignin: $('nav-signin'),
  navUser: $('nav-user'),
  navSignout: $('nav-signout'),
  hzLive: $('hz-live'),
  provenance: $('provenance'),
  provenanceLive: $('provenance-live'),
  // Live channel
  liveControls: $('live-controls'),
  liveEvent: $('live-event'),
  liveRefresh: $('live-refresh'),
  liveStatus: $('live-status'),
  liveLegendRaster: $('live-legend-raster'),
  liveEventsNote: $('live-events-note'),
  liveLayerWrap: $('live-layer-wrap'),
  liveLayer: $('live-layer'),
  liveFit: $('live-fit'),
  liveOutlook: $('live-outlook'),
  liveSim: $('live-sim'),
  liveSimModel: $('live-sim-model'),
  liveSimModelWrap: $('live-sim-model-wrap'),
  simBadge: $('sim-badge'),
  provenanceSim: $('provenance-sim'),
  livePassNote: $('live-pass-note'),
  roomForm: $('room-form'),
  roomCode: $('room-code'),
  roomJoin: $('room-join'),
  roomLeave: $('room-leave'),
  roomStatus: $('room-status'),
  legendLive: $('legend-live'),
  legendOutlook: $('legend-outlook'),
  livePanel: $('live-panel'),
  liveViewEvent: $('live-view-event'),
  liveEventHead: $('live-event-head'),
  liveProjectionBody: $('live-projection-body'),
  livePredict: $('live-predict'),
  liveBriefingBody: $('live-briefing-body'),
  liveBrief: $('live-brief'),
  liveAskLog: $('live-ask-log'),
  liveAskForm: $('live-ask-form'),
  liveAskInput: $('live-ask-input'),
  liveAskSubmit: $('live-ask-submit'),
  liveAskNote: $('live-ask-note'),
  liveContextBody: $('live-context-body'),
  liveMediaBody: $('live-media-body'),
  liveScenesBody: $('live-scenes-body'),
  liveViewArea: $('live-view-area'),
  liveAreaClose: $('live-area-close'),
  liveAreaCoords: $('live-area-coords'),
  liveRangeStart: $('live-range-start'),
  liveRangeEnd: $('live-range-end'),
  liveAreaBody: $('live-area-body'),
  liveViewOutlook: $('live-view-outlook'),
  liveOutlookClose: $('live-outlook-close'),
  liveHorizon: $('live-horizon'),
  liveOutlookView: $('live-outlook-view'),
  liveOutlookBody: $('live-outlook-body'),
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

function renderTicks(view, passWord = 'Observed sample pass') {
  const signature = `${passWord}|${view.timeline.map((s) => `${s.kind}:${s.date}`).join(',')}`;
  if (signature !== lastTickSignature) {
    const frag = document.createDocumentFragment();
    view.timeline.forEach((s, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.index = String(i);
      btn.dataset.kind = s.kind === 'forecast' ? 'forecast' : 'observed';
      btn.textContent = formatShort(s.date);
      btn.setAttribute('aria-label', `${s.kind === 'forecast' ? 'Forecast' : passWord}, ${formatSpoken(s.date)}`);
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

/** One render for the whole page: shared chrome, then the active channel. */
function render() {
  renderCommon();
  if (state.source === 'live') renderLive();
  else renderDemo();
}

/** Auth, nav, backend link and route-independent bits shared by every channel. */
function renderCommon() {
  setAttr(el.html, 'data-source', state.source);
  // Channel blocks. The demo provenance strip shows on every demo channel;
  // the live channel carries its own strip, so neither claim is ever wrong.
  const live = state.source === 'live';
  setHidden(el.provenance, live);
  setHidden(el.provenanceLive, !live);
  if (!live) {
    setHidden(el.provenanceSim, true);
    setHidden(el.simBadge, true);
    setAttr(el.html, 'data-sim', 'off');
  }
  setHidden(el.livePanel, !live);
  setHidden(el.liveControls, !live);
  setHidden(el.legendLive, !live);
  const a = state.api;
  const signedIn = a.auth === 'signed-in' && a.user;
  const who = signedIn ? String(a.user.name || a.user.email || 'Signed in') : '';

  // Nav: Sign in ↔ name + Sign out.
  setHidden(el.navSignin, Boolean(signedIn));
  setHidden(el.navUser, !signedIn);
  setHidden(el.navSignout, !signedIn);
  setText(el.navUser, who);

  // Auth pages (Auth0 hand-off; no credentials ever enter this page).
  let authText;
  if (a.status === 'offline') authText = `Sign-in is unavailable: the API is offline (${a.error})`;
  else if (a.auth === 'checking') authText = 'Checking your session…';
  else if (a.auth === 'unavailable') authText = `Sign-in is unavailable right now: ${a.authMessage}`;
  else if (signedIn) authText = `Signed in as ${who}.`;
  else authText = 'You are signed out.';
  setText(el.signinStatus, authText);
  setText(el.signupStatus, authText);
  const cannot = a.status !== 'online' || a.auth === 'unavailable' || a.auth === 'checking';
  setHidden(el.signinSubmit, Boolean(signedIn));
  setHidden(el.signupSubmit, Boolean(signedIn));
  if (el.signinSubmit.disabled !== cannot) el.signinSubmit.disabled = cannot;
  if (el.signupSubmit.disabled !== cannot) el.signupSubmit.disabled = cannot;
  setHidden(el.signinSignout, !signedIn);

  // Backend link line. Its suffix says which data comes from the API.
  const suffix = state.source === 'live' ? '// LIVE CHANNEL DATA COMES FROM IT' : '// DEMO CHANNEL DATA IS NOT FROM IT';
  let linkText;
  if (a.status === 'online') {
    const authWord = signedIn ? `SIGNED IN AS ${who.toUpperCase()}` : a.auth === 'unavailable' ? 'SIGN-IN UNAVAILABLE' : 'SIGNED OUT';
    linkText = `BACKEND LINK: ONLINE · ${a.eventCount} EVENT${a.eventCount === 1 ? '' : 'S'} · ${authWord} ${suffix}`;
  } else if (a.status === 'offline') {
    linkText = `BACKEND LINK: OFFLINE // ${a.error}`;
  } else {
    linkText = `BACKEND LINK: CHECKING ${suffix}`;
  }
  setText(el.backendStatus, linkText);
  setAttr(el.backendStatus, 'data-state', a.status);

  // Errors: explicit, never a substitute.
  const mapText = [state.errors.map, state.errors.backend].filter(Boolean).join(' ');
  setText(el.mapError, mapText);
  setHidden(el.mapError, !mapText);
}

/**
 * The timeline dock, shared by both channels.
 * t: { timeline, idx, step, isForecast, hasForecast, observedCount, forecastCount, len, stepDate, spoken, observedLabel, passWord }
 */
function renderTimeline(t) {
  const { timeline, idx, step, isForecast, hasForecast, observedCount, forecastCount, len, stepDate, spoken } = t;
  const sliderMax = Math.max(0, len - 1);
  setAttr(el.dateSlider, 'max', sliderMax);
  if (el.dateSlider.disabled !== (len < 2)) el.dateSlider.disabled = len < 2;
  if (idx !== null && Number(el.dateSlider.value) !== idx) el.dateSlider.value = String(idx);
  setAttr(el.dateSlider, 'aria-valuetext', spoken);

  // Track geometry: --obs / --fc are plain numbers; the NOW line sits at
  // obs/(obs+fc) of the width, i.e. midway between the last observed and the
  // first forecast thumb stop when obs = observed − 0.5 and fc = forecast − 0.5.
  const obs = hasForecast ? observedCount - 0.5 : Math.max(1, observedCount);
  const fc = hasForecast ? forecastCount - 0.5 : 0;
  el.track.style.setProperty('--obs', String(obs));
  el.track.style.setProperty('--fc', String(fc));
  const lastObs = lastObservedIndex(timeline);
  const segObs = el.segObserved.querySelector('.meta');
  const segNow = el.nowTick.querySelector('.meta');
  const segFc = el.segForecast.querySelector('.meta');
  setText(segObs, observedCount ? `${t.observedLabel} (01–${pad2(observedCount)})` : t.observedLabel);
  setText(segNow, lastObs >= 0 ? `NOW (${formatDate(timeline[lastObs].date)})` : 'NOW');
  setText(segFc, hasForecast ? `FORECAST HORIZON (${pad2(observedCount + 1)}–${pad2(len)})` : 'FORECAST HORIZON');

  renderTicks({ timeline, idx }, t.passWord);

  // Lock 3 wording on the date readout.
  setText(el.timelineDate, step ? (isForecast ? `FORECAST · ${stepDate}` : stepDate) : '—');

  setAttr(el.play, 'aria-label', state.playing ? 'Pause' : 'Play');
  setHidden(playIcon, state.playing);
  setHidden(pauseIcon, !state.playing);
  if (el.play.disabled !== (len < 2)) el.play.disabled = len < 2;
}

function renderDemo() {
  const view = deriveView(state);
  const { hazard, step, idx, isForecast, hasForecast, observedCount, forecastCount, len } = view;
  const stepDate = step ? formatDate(step.date) : '—';

  // Coming back from the live channel: hide its layers, re-show the demo.
  if (map && mapReady && liveLayersReady) applyLiveMap(map, { active: false });
  demoHidden = false;

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

  // Errors: explicit, never a substitute (map + backend are joined in renderCommon).
  const assetText = state.errors.asset || view.changeError;
  setText(el.assetError, assetText);
  setHidden(el.assetError, !assetText);

  // 5. Timeline.
  const spoken = step ? (isForecast ? `Forecast, ${formatSpoken(step.date)}` : `Observed sample pass, ${formatSpoken(step.date)}`) : COPY.noTimeline;
  renderTimeline({
    timeline: view.timeline,
    idx,
    step,
    isForecast,
    hasForecast,
    observedCount,
    forecastCount,
    len,
    stepDate,
    spoken,
    observedLabel: 'OBSERVED PASSES',
    passWord: 'Observed sample pass',
  });

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
/* LIVE channel: view, render, loaders                                  */
/* ------------------------------------------------------------------ */

let stampSeq = 0;
/** A load-status object with a unique stamp (live.js keys its re-render on it). */
const st = (status, extra = {}) => ({ status, stamp: ++stampSeq, ...extra });
const IDLE = () => st('idle');

let lastEventOptionsSig = '';
let lastLayerOptionsSig = '';

const sceneKey = (s) => (s && (s.browseUrl || s.id)) || '';

/** The live detail being shown: a catalog event, or a replay shaped like one. */
function liveDetailData() {
  const L = state.live;
  if (L.replay) {
    return {
      event: { id: L.replay.id, name: L.replay.name, bbox: L.replay.bbox, type: L.replay.eventTime ? 'earthquake' : 'other' },
      scenes: L.replay.scenes,
      layers: [],
      dates: [],
    };
  }
  return L.detail.status === 'done' ? L.detail.data : null;
}

/** Everything renderLive() and the live map need, derived from state + cache. */
function liveView() {
  const L = state.live;
  const data = liveDetailData();
  const tl = liveTimeline(data, L.layer);
  const len = tl.steps.length;
  const idx = len && L.idx !== null && L.idx !== undefined ? Math.min(len - 1, Math.max(0, L.idx)) : null;
  const step = idx === null ? null : tl.steps[idx];
  const event = data ? data.event : null;
  let loading = 0;
  let imageErrors = 0;
  for (const s of tl.steps.flatMap((x) => x.scenes)) {
    const b = cache.browse.get(sceneKey(s));
    if (b && b.status === 'loading') loading++;
  }
  if (step && tl.mode === 'preview') {
    for (const s of step.scenes) {
      const b = cache.browse.get(sceneKey(s));
      if (b && b.status === 'error') imageErrors++;
    }
  }
  return { data, tl, len, idx, step, event, loading, imageErrors };
}

function liveMapView(v) {
  const L = state.live;
  const current = new Set(v.step && v.tl.mode === 'preview' ? v.step.scenes.map(sceneKey) : []);
  const images = [];
  for (const s of v.tl.steps.flatMap((x) => x.scenes)) {
    const key = sceneKey(s);
    const b = cache.browse.get(key);
    if (b && b.status === 'ready') images.push({ key, url: b.url, coordinates: b.coordinates, visible: current.has(key) });
  }
  const tile = v.tl.mode === 'tiles' && v.step ? v.step.tile : null;
  return {
    active: true,
    aoi: v.event && Array.isArray(v.event.bbox) ? v.event.bbox : null,
    probe: L.area ? L.area.bbox : null,
    outlookOn: L.outlookOn,
    cells: L.outlook.status === 'done' ? L.outlook.data.cells : [],
    selectedCell: L.cell,
    images,
    tiles: tile ? { url: tile.tiles, minZoom: tile.minZoom, maxZoom: tile.maxZoom, bounds: tile.bounds } : null,
    opacity: state.observedOpacity / 100,
  };
}

function renderEventOptions() {
  const L = state.live;
  const list = L.events.list;
  const sig = `${L.events.status}|${list.map((e) => `${e.id}:${e.name}`).join(',')}|${L.replay ? L.replay.id : ''}`;
  if (sig !== lastEventOptionsSig) {
    const frag = document.createDocumentFragment();
    if (L.replay) frag.appendChild(h('option', { value: L.replay.id }, `Replay: ${L.replay.name}`));
    if (!list.length) {
      frag.appendChild(h('option', { value: '' }, L.events.status === 'loading' ? 'Loading events…' : 'No tracked events yet'));
    } else {
      if (!L.eventId && !L.replay) frag.appendChild(h('option', { value: '' }, 'Choose an event…'));
      for (const e of list) frag.appendChild(h('option', { value: e.id }, e.name));
    }
    el.liveEvent.replaceChildren(frag);
    lastEventOptionsSig = sig;
  }
  const want = L.replay ? L.replay.id : L.eventId || '';
  if (el.liveEvent.value !== want) el.liveEvent.value = want;
  const disabled = !list.length && !L.replay;
  if (el.liveEvent.disabled !== disabled) el.liveEvent.disabled = disabled;
}

function renderLayerOptions(tl) {
  const L = state.live;
  const show = tl.layers.length > 0;
  setHidden(el.liveLayerWrap, !show);
  if (!show) return;
  const sig = tl.layers.join(',');
  if (sig !== lastLayerOptionsSig) {
    const frag = document.createDocumentFragment();
    frag.appendChild(h('option', { value: 'preview' }, 'ASF preview images'));
    for (const id of tl.layers) frag.appendChild(h('option', { value: id }, `${layerLabel(id)} (processed)`));
    el.liveLayer.replaceChildren(frag);
    lastLayerOptionsSig = sig;
  }
  if (el.liveLayer.value !== L.layer) el.liveLayer.value = L.layer;
}

function roomText() {
  const r = state.live.room;
  if (r.status === 'connecting') return `CONNECTING TO ROOM ${r.code}…`;
  if (r.status === 'open') {
    const shared = state.live.replay ? 'SEARCH REPLAYS ARE NOT SHARED' : 'EVENT, PASS AND PLAY ARE SHARED';
    return `IN ROOM ${r.code} · ${r.count || 1} VIEWER${r.count === 1 ? '' : 'S'} · ${shared}${r.message ? ` · ${r.message.toUpperCase()}` : ''}`;
  }
  if (r.status === 'error') return r.message || 'THE ROOM CONNECTION FAILED';
  if (r.status === 'closed') return `DISCONNECTED FROM ROOM ${r.code}`;
  return 'NOT IN A ROOM · PLAYBACK STAYS LOCAL';
}

function renderLive() {
  const L = state.live;
  const v = liveView();
  const { tl, step, idx, len, event } = v;
  if (!L.sim && tl.mode === 'preview') ensureBrowseImages(tl, idx);
  el.liveRefresh.disabled = L.refreshing || L.events.status === 'loading' || L.detail.status === 'loading' || Boolean(L.busy) || L.ask.busy;
  setText(el.liveStatus, L.actionError || L.notice || '');
  setHidden(el.liveStatus, !L.actionError && !L.notice);
  setAttr(el.liveStatus, 'class', L.actionError ? 'live-error' : 'meta');
  const stepDate = step ? formatDate(step.date) : '—';
  const signedIn = state.api.auth === 'signed-in';
  const hasEvent = !L.replay && L.detail.status === 'done';

  // 1. Root attributes. The live timeline has no forecast half.
  setAttr(el.html, 'data-mode', 'observed');
  setAttr(el.html, 'data-forecasts', 'none');
  setAttr(el.html, 'data-route', state.route);
  if (!el.hzLive.checked) el.hzLive.checked = true;

  // 2. Top bar.
  if (event && Array.isArray(event.bbox)) {
    const bb = event.bbox;
    setText(el.targetName, `TARGET: ${String(event.name).toUpperCase()}`);
    setText(el.targetCoords, formatCoords((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2));
    setText(el.targetFootprint, `AREA: ${footprintKm(boundsOf(bb)).label}`);
  } else {
    setText(el.targetName, event ? `TARGET: ${String(event.name).toUpperCase()}` : 'TARGET: NO EVENT SELECTED');
    setText(el.targetCoords, '—');
    setText(el.targetFootprint, 'AREA: —');
  }
  // Simulated illustration: FABRICATED frames from the demo models, keyed to
  // the real pass dates. Only ever shown with the badge + strip below.
  const sim = L.sim && step ? simHazardFor(event, tl.steps, L.simModel) : null;
  setHidden(el.liveSimModelWrap, !L.sim);
  if (el.liveSimModel.value !== L.simModel) el.liveSimModel.value = L.simModel;
  let simUrl = null;
  if (sim) {
    try {
      simUrl = simFrame(sim, idx).url;
    } catch (err) {
      state.errors.asset = `Simulated illustration unavailable (${err && err.message ? err.message : 'render error'}).`;
    }
  }
  const simOn = Boolean(sim && simUrl);
  setText(el.liveLegendRaster, simOn
    ? 'Simulated illustration: fabricated imagery, not measured data'
    : tl.mode === 'tiles'
      ? `${layerLabel(L.layer)}${step?.tile?.units ? ` (${step.tile.units})` : ''}: processed NISAR layer; colours are scaled per scene`
      : 'ASF preview: a real NISAR pass, quicklook only, not calibrated');
  setAttr(el.html, 'data-sim', simOn ? 'on' : 'off');
  setHidden(el.simBadge, !simOn);
  setHidden(el.provenanceSim, !simOn);
  if (simOn) setText(el.simBadge.lastChild, ` · NOT MEASURED · ${sim.model.label}`);
  setAttr(el.liveSim, 'aria-pressed', L.sim ? 'true' : 'false');
  const simDisabled = !len;
  if (el.liveSim.disabled !== simDisabled) el.liveSim.disabled = simDisabled;

  setText(pillMain, step ? '● NISAR PASS' : '● LIVE CATALOG');
  setText(
    pillSuffix,
    step ? (simOn ? ' // SIMULATED ILLUSTRATION' : tl.mode === 'tiles' ? ' // PROCESSED TILES' : ' // ASF PREVIEW') : ' // NO PASS SELECTED',
  );

  // 3. Controls.
  setText(el.passDate, stepDate);
  if (step) setText(el.passIndex, `PASS ${pad2(idx + 1)} / ${pad2(len)}`);
  else setText(el.passIndex, L.detail.status === 'loading' ? 'LOADING' : event ? 'NO PREVIEWABLE PASSES' : 'NO EVENT');
  setHidden(el.noPassAlert, true);
  if (el.opacity.disabled) el.opacity.disabled = false;
  if (Number(el.opacity.value) !== state.observedOpacity) el.opacity.value = String(state.observedOpacity);
  setAttr(el.opacity, 'aria-valuetext', `${state.observedOpacity} percent`);
  setText(el.opacityReadout, `${state.observedOpacity}%`);
  setHidden(el.opacityLock, true);

  renderEventOptions();
  const n = L.events.list.length;
  setText(
    el.liveEventsNote,
    L.events.status === 'loading' ? 'LOADING THE CATALOG' : L.events.status === 'error' ? L.events.message : `${n} TRACKED EVENT${n === 1 ? '' : 'S'}`,
  );
  renderLayerOptions(tl);
  setAttr(el.liveOutlook, 'aria-pressed', L.outlookOn ? 'true' : 'false');
  const canFit = Boolean(event && Array.isArray(event.bbox));
  if (el.liveFit.disabled !== !canFit) el.liveFit.disabled = !canFit;
  setText(
    el.livePassNote,
    v.loading ? `LOADING ${v.loading} PREVIEW IMAGE${v.loading === 1 ? '' : 'S'} FROM ASF…` : 'Click anywhere on the map to explore that area.',
  );

  // Room.
  const inRoom = L.room.status === 'open' || L.room.status === 'connecting';
  setHidden(el.roomJoin, inRoom);
  setHidden(el.roomLeave, !inRoom);
  if (el.roomCode.disabled !== inRoom) el.roomCode.disabled = inRoom;
  setText(el.roomStatus, roomText());
  setAttr(el.roomStatus, 'data-state', L.room.status);

  setHidden(el.legendOutlook, !L.outlookOn);

  // 4. Evidence: one of three views.
  setHidden(el.liveViewEvent, L.panel !== 'event');
  setHidden(el.liveViewArea, L.panel !== 'area');
  setHidden(el.liveViewOutlook, L.panel !== 'outlook');

  renderEventHead(el.liveEventHead, { detail: L.detail, replay: L.replay, step, stepCount: len, mode: tl.mode, layer: L.layer, imageErrors: v.imageErrors });
  for (const id of ['live-projection', 'live-briefing', 'live-ask', 'live-context', 'live-media']) setHidden($(id), !hasEvent);
  setHidden($('live-scenes'), !(hasEvent || L.replay));
  renderProjection(el.liveProjectionBody, L.predict);
  setHidden(el.livePredict, L.predict.status === 'loading' || L.predict.status === 'done');
  setText(el.livePredict, L.predict.status === 'error' ? 'Try again' : 'Project this event forward');
  renderBriefing(el.liveBriefingBody, L.brief);
  setHidden(el.liveBrief, L.brief.status === 'loading' || L.brief.status === 'done');
  setText(el.liveBrief, L.brief.status === 'error' ? 'Try again' : 'Write a briefing');
  renderAskLog(el.liveAskLog, L.ask);
  const askOff = !signedIn || L.ask.busy || L.ask.history === 'loading';
  if (el.liveAskInput.disabled !== askOff) el.liveAskInput.disabled = askOff;
  if (el.liveAskSubmit.disabled !== askOff) el.liveAskSubmit.disabled = askOff;
  setText(el.liveAskSubmit, L.ask.busy ? 'Asking…' : 'Ask');
  setText(
    el.liveAskNote,
    signedIn
      ? L.ask.chatId
        ? 'SAVED TO YOUR ACCOUNT · ANSWERS ARE AI HYPOTHESES'
        : 'YOUR QUESTIONS ARE SAVED TO YOUR ACCOUNT · ANSWERS ARE AI HYPOTHESES'
      : state.api.auth === 'unavailable'
        ? 'SIGN-IN IS UNAVAILABLE, SO QUESTIONS ARE OFF'
        : 'SIGN IN (TOP RIGHT) TO ASK QUESTIONS AND KEEP THE CONVERSATION',
  );
  renderContext(el.liveContextBody, L.context);
  renderMedia(el.liveMediaBody, L.media);
  renderScenes(el.liveScenesBody, L.detail, L.replay);

  // Area explorer.
  setText(el.liveAreaCoords, L.area ? `${formatLngLat(L.area.lng, L.area.lat)} · ABOUT 1° ACROSS` : '—');
  const today = isoDay(Date.now());
  for (const [input, value] of [[el.liveRangeStart, L.range.start], [el.liveRangeEnd, L.range.end]]) {
    setAttr(input, 'min', NISAR_LAUNCH);
    setAttr(input, 'max', today);
    if (input.value !== value) input.value = value;
  }
  renderArea(el.liveAreaBody, { area: L.area, results: L.results, events: L.events.list, busy: L.busy, notice: L.notice, actionError: L.actionError, signedIn });

  // Outlook.
  el.liveHorizon.querySelectorAll('button[data-horizon]').forEach((b) => setAttr(b, 'aria-pressed', Number(b.dataset.horizon) === L.horizon ? 'true' : 'false'));
  renderOutlook(el.liveOutlookBody, L.outlook, L.cell);

  setText(el.assetError, state.errors.asset);
  setHidden(el.assetError, !state.errors.asset);

  // 5. Timeline: NISAR passes only.
  const spoken = step ? `NISAR pass, ${formatSpoken(step.date)}` : 'No NISAR passes to show.';
  renderTimeline({
    timeline: tl.steps,
    idx,
    step,
    isForecast: false,
    hasForecast: false,
    observedCount: len,
    forecastCount: 0,
    len,
    stepDate,
    spoken,
    observedLabel: 'NISAR PASSES',
    passWord: 'NISAR pass',
  });

  // 6. Map.
  if (map && mapReady) {
    if (simOn) {
      // The demo layers draw the simulated frame + extents on the event box.
      applyMapState(map, {
        hazard: sim,
        idx,
        stepKind: 'observed',
        isForecast: false,
        rasterUrl: simUrl,
        rasterVisible: true,
        rasterOpacity: state.observedOpacity / 100,
        showChange: false,
        changeUrl: null,
        riskGeojson: sim.riskExtents(idx),
        riskKey: `${sim.id}|${idx}`,
        showRisk: true,
        compound: false,
        point: null,
        showReticle: false,
      });
      demoHidden = false;
    } else if (!demoHidden) {
      hideDemoLayers(map);
      demoHidden = true;
    }
    if (liveLayersReady) {
      try {
        const lv = liveMapView(v);
        // While simulating, the real previews/tiles step aside (not mixed).
        if (simOn) {
          lv.images = lv.images.map((img) => ({ ...img, visible: false }));
          lv.tiles = null;
          lv.aoi = null;
        }
        applyLiveMap(map, lv);
      } catch (err) {
        state.errors.map = `Live map layers failed (${err && err.message ? err.message : 'render error'}).`;
      }
    }
  }

  // 7. Announce on pass or event change.
  const announceKey = step ? `live|${event ? event.id : ''}|${idx}` : '';
  if (announceKey && announceKey !== lastAnnounced) {
    lastAnnounced = announceKey;
    setText(el.announcer, spoken);
  }
}

/** Load the current pass and its neighbours; avoid downloading the whole catalog. */
function ensureBrowseImages(tl, index = state.live.idx ?? 0) {
  if (tl.mode !== 'preview') return;
  const current = Math.max(0, Math.min(tl.steps.length - 1, index ?? 0));
  const needed = tl.steps.slice(Math.max(0, current - 1), current + 2).flatMap(x => x.scenes);
  for (const s of needed) {
    const key = sceneKey(s);
    if (!key || cache.browse.has(key)) continue;
    cache.browse.set(key, { status: 'loading' });
    loadBrowseImage(s.browseUrl, s.bounds)
      .then((r) => cache.browse.set(key, { status: 'ready', url: r.url, coordinates: r.coordinates }))
      .catch((err) => cache.browse.set(key, { status: 'error', message: err && err.message ? err.message : 'load failed' }))
      .finally(() => {
        if (cache.browse.size > 64) {
          const view = liveView();
          const keep = new Set(view.tl.steps.slice(Math.max(0, (view.idx ?? 0) - 1), (view.idx ?? 0) + 2).flatMap(x => x.scenes).map(sceneKey));
          for (const [oldKey, image] of cache.browse) {
            if (cache.browse.size <= 64) break;
            if (keep.has(oldKey) || image.status === 'loading') continue;
            if (image.url) URL.revokeObjectURL(image.url);
            cache.browse.delete(oldKey);
          }
        }
        if (state.source === 'live') render();
      });
  }
}

function fitLive(animate = true) {
  if (!map) return;
  const v = liveView();
  // The simulated illustration is drawn on the event box only, so frame that
  // (as the demo channels frame their study area); otherwise frame the scenes too.
  const simulating = state.live.sim && v.event && Array.isArray(v.event.bbox);
  const scenes = !simulating && v.tl.mode === 'preview' ? v.tl.steps.flatMap((x) => x.scenes) : [];
  const box = simulating ? v.event.bbox : unionBounds(v.event, scenes);
  if (box) fitBox(map, box, paddingFor(map, isMobile()), animate);
}

function markSignedOut() {
  state.api = { ...state.api, auth: 'signed-out', user: null };
}

async function loadLiveEvents(selectId, stub = null, { fresh = false } = {}) {
  const L = state.live;
  L.events = { ...L.events, status: 'loading', message: '' };
  render();
  try {
    const d = await api.events({ fresh });
    if (!Array.isArray(d.events)) throw new Error('The catalog response was incomplete. Refresh to try again.');
    let list = d.events;
    // The catalog list is cached for ~60 s, so a just-tracked event may be
    // missing: list it from what we know until the cache catches up.
    if (stub && !list.some((e) => e.id === stub.id)) list = [stub, ...list];
    L.events = { status: 'done', list, message: '' };
    state.api = { ...state.api, eventCount: list.length };
    const want = selectId || L.eventId || (list[0] && list[0].id);
    if (want && !L.replay && (want !== L.eventId || L.detail.status !== 'done')) {
      selectLiveEvent(want, { fromRoom: false });
      return;
    }
  } catch (err) {
    L.events = { status: 'error', list: L.events.list, message: err && err.message ? err.message : 'Could not load events' };
  }
  render();
}

async function refreshLiveCatalog() {
  const L = state.live;
  if (L.refreshing || L.events.status === 'loading' || L.detail.status === 'loading' || L.ask.busy || L.busy) return;
  const id = L.eventId;
  L.refreshing = true;
  L.actionError = '';
  L.notice = '';
  render();
  try {
    clearApiCache();
    await loadLiveEvents(undefined, null, { fresh: true });
    if (L.events.status !== 'done' || !id || L.eventId !== id || L.replay || L.detail.status !== 'done') return;
    const seq = liveSeq;
    const data = await api.event(id, { fresh: true });
    if (seq !== liveSeq || L.eventId !== id) return;
    if (!data.event || !Array.isArray(data.scenes) || !Array.isArray(data.layers)) throw new Error('The event response was incomplete.');
    L.detail = st('done', { data });
    const timeline = liveTimeline(data, L.layer);
    L.idx = timeline.steps.length ? Math.min(L.idx ?? 0, timeline.steps.length - 1) : null;
    L.notice = 'Catalog refreshed.';
  } catch (err) {
    L.actionError = err?.message || 'Could not refresh this event. Try again.';
  } finally {
    L.refreshing = false;
    render();
  }
}

async function selectLiveEvent(id, { fromRoom = false } = {}) {
  const L = state.live;
  stopPlaying();
  const seq = ++liveSeq;
  L.replay = null;
  L.eventId = id;
  L.detail = st('loading', { id });
  L.idx = null;
  L.layer = 'preview';
  L.panel = 'event';
  L.predict = IDLE();
  L.brief = IDLE();
  L.context = IDLE();
  L.media = IDLE();
  L.ask = { turns: [], busy: false, error: '', chatId: null, history: '' };
  state.errors.asset = '';
  if (!fromRoom && room.open) room.send({ type: 'load', eventId: id });
  render();
  try {
    const data = await api.event(id);
    if (seq !== liveSeq) return;
    if (!data.event || !Array.isArray(data.scenes) || !Array.isArray(data.layers)) throw new Error('The event response was incomplete. Refresh to try again.');
    L.detail = st('done', { data });
    const tl = liveTimeline(data, L.layer);
    const pending = L.pendingFrame;
    const playback = L.room.playback;
    const shared = room.open && playback?.eventId === id;
    L.idx = tl.steps.length
      ? shared
        ? replayFrameAt(playback, tl.steps.length, playback.serverTime + performance.now() - playback.receivedAt)
        : Number.isInteger(pending) ? Math.min(tl.steps.length - 1, Math.max(0, pending)) : tl.steps.length - 1
      : null;
    L.pendingFrame = null;
    ensureBrowseImages(tl);
    if (state.source === 'live') fitLive();
    loadInto('context', () => api.context(id), seq);
    loadInto('media', () => api.media(id), seq);
    if (state.api.auth === 'signed-in') loadChatHistory(id, seq);
    if (shared ? playback.playing : L.pendingPlay) {
      L.pendingPlay = false;
      render();
      startPlaying();
      return;
    }
  } catch (err) {
    if (seq !== liveSeq) return;
    L.detail = st('error', { message: err && err.message ? err.message : 'Could not load the event' });
  }
  render();
}

/** Fetch into state.live[key] as a stamped status object, for the current event only. */
async function loadInto(key, fetcher, seq = liveSeq) {
  state.live[key] = st('loading');
  render();
  try {
    const data = await fetcher();
    if (seq !== liveSeq) return;
    state.live[key] = st('done', { data });
  } catch (err) {
    if (seq !== liveSeq) return;
    if (err && err.status === 401) markSignedOut();
    state.live[key] = st('error', { message: err && err.message ? err.message : 'Request failed' });
  }
  render();
}

async function loadChatHistory(eventId, seq) {
  const L = state.live;
  L.ask = { ...L.ask, history: 'loading' };
  render();
  try {
    const { chats } = await api.chats();
    if (seq !== liveSeq) return;
    const chat = (chats || []).find((c) => c.eventId === eventId);
    if (!chat) {
      L.ask = { ...L.ask, history: 'done' };
      render();
      return;
    }
    const { messages } = await api.chatMessages(chat.id);
    if (seq !== liveSeq) return;
    const turns = [];
    for (const m of messages || []) {
      if (m.role === 'user') turns.push({ question: m.content, answer: '' });
      else if (m.role === 'assistant' && turns.length && !turns[turns.length - 1].answer) turns[turns.length - 1].answer = m.content;
    }
    L.ask = { ...L.ask, chatId: chat.id, turns: turns.filter((t) => t.answer), history: 'done' };
  } catch (err) {
    if (seq !== liveSeq) return;
    if (err && err.status === 401) markSignedOut();
    L.ask = { ...L.ask, history: '' };
  }
  render();
}

async function askQuestion(text) {
  const L = state.live;
  const id = L.eventId;
  const q = String(text || '').trim();
  if (!id || L.replay || L.ask.busy || L.ask.history === 'loading') return;
  if (q.length < 3) {
    L.ask = { ...L.ask, error: 'Questions need at least 3 characters.' };
    render();
    return;
  }
  if (state.api.auth !== 'signed-in') {
    L.ask = { ...L.ask, error: 'Sign in to ask a question.' };
    render();
    return;
  }
  const seq = liveSeq;
  const before = L.ask.turns;
  L.ask = { ...L.ask, busy: true, error: '', turns: [...before, { question: q, answer: '' }] };
  render();
  try {
    let chatId = L.ask.chatId;
    if (!chatId) {
      try {
        const name = (L.detail.status === 'done' && L.detail.data.event.name) || id;
        const c = await api.createChat(id, String(name).slice(0, 120));
        chatId = c && c.chat ? c.chat.id : null;
      } catch (err) {
        if (err && err.status === 401) throw err;
        chatId = null; // saving failed; the question is still answered
      }
    }
    const d = await api.ask(id, q, chatId || undefined);
    if (seq !== liveSeq) return;
    L.ask = { ...L.ask, busy: false, chatId: d.chatId || chatId, turns: [...before, { question: q, answer: d.answer, disclaimer: d.disclaimer }] };
    if (el.liveAskInput.value.trim() === q) el.liveAskInput.value = '';
  } catch (err) {
    if (seq !== liveSeq) return;
    if (err && err.status === 401) markSignedOut();
    L.ask = { ...L.ask, busy: false, turns: before, error: err && err.status === 401 ? COPY.sessionEnded : err && err.message ? err.message : 'The question failed.' };
  }
  render();
}

/* Area explorer */

function exploreAt(lng, lat) {
  const L = state.live;
  const w = wrapLng(lng);
  L.area = { id: ++stampSeq, lng: w, lat, bbox: areaAround(w, lat) };
  L.panel = 'area';
  L.notice = '';
  L.actionError = '';
  L.busy = '';
  runAreaQueries();
}

function runAreaQueries() {
  clearTimeout(areaQueryTimer);
  const L = state.live;
  const area = L.area;
  if (!area) return;
  const { start, end } = L.range;
  const period = `${area.id}|${start}..${end}`;
  L.results = { nisar: st('loading', { period }), quakes: st('loading', { period }), context: st('loading', { period }) };
  const track = (key, promise) =>
    promise
      .then((data) => st('done', { data, period }))
      .catch((err) => st('error', { message: err && err.message ? err.message : 'Request failed', period }))
      .then((r) => {
        if (state.live.results[key].period !== period) return;
        state.live.results = { ...state.live.results, [key]: r };
        render();
      });
  areaQueryTimer = setTimeout(() => {
    if (state.source !== 'live' || state.live.area?.id !== area.id || state.live.results.nisar.period !== period) return;
    track('nisar', api.nisarSearch(area.bbox, start, end));
    track('quakes', api.quakes(area.bbox, start, end));
    track('context', api.datasetContext(area.bbox, start, end));
  }, 350);
  render();
}

async function liveAction(action, id) {
  const L = state.live;
  if (L.busy) return;
  if (action.startsWith('track-') && state.api.auth !== 'signed-in') {
    L.actionError = 'Sign in to track this place.';
    render();
    return;
  }
  const fail = (err) => {
    if (err && err.status === 401) {
      markSignedOut();
      L.actionError = 'Your session has ended. Sign in again to track places.';
    } else {
      L.actionError = err && err.message ? err.message : 'That did not work.';
    }
  };
  const withPreview = (scenes) => (scenes || []).filter((s) => s.browseUrl && Array.isArray(s.bounds));
  L.actionError = '';
  L.notice = '';

  if (action === 'open-event' && id) {
    selectLiveEvent(id);
    return;
  }
  if (action === 'track-area' && L.area) {
    const area = L.area;
    const dateRange = { ...L.range };
    L.busy = 'area';
    render();
    try {
      const name = `Area near ${formatLngLat(area.lng, area.lat)}`;
      const out = await api.trackArea({ aoi: area.bbox, dateRange, name, type: 'other' });
      L.busy = '';
      await loadLiveEvents(out.eventId, { id: out.eventId, name, type: 'other', bbox: area.bbox, sceneCount: 0 });
      watchNewEvent(out.eventId);
      return;
    } catch (err) {
      fail(err);
    }
    L.busy = '';
  } else if (action === 'track-quake' && id) {
    L.busy = id;
    render();
    try {
      const out = await api.trackQuake(id);
      L.busy = '';
      const q = L.results.quakes.status === 'done' ? L.results.quakes.data.earthquakes.find((x) => x.sourceId === id) : null;
      const aoi = q && q.suggested && Array.isArray(q.suggested.aoi) ? q.suggested.aoi : null;
      await loadLiveEvents(out.eventId, { id: out.eventId, name: q ? q.title : out.eventId, type: 'earthquake', bbox: aoi, sceneCount: 0 });
      watchNewEvent(out.eventId);
      return;
    } catch (err) {
      fail(err);
    }
    L.busy = '';
  } else if (action === 'replay-area' && L.area && L.results.nisar.status === 'done') {
    const scenes = withPreview(L.results.nisar.data.scenes);
    if (!scenes.length) L.notice = 'None of these scenes has a preview image to replay.';
    else startReplay({ id: `replay-area-${L.area.id}`, name: `Area near ${formatLngLat(L.area.lng, L.area.lat)}`, bbox: L.area.bbox, scenes });
  } else if (action === 'replay-quake' && id && L.results.quakes.status === 'done') {
    const q = L.results.quakes.data.earthquakes.find((x) => x.sourceId === id);
    if (q && q.suggested) {
      L.busy = `replay-${id}`;
      render();
      try {
        const { aoi, dateRange } = q.suggested;
        const found = await api.nisarSearch(aoi, dateRange.start, dateRange.end);
        const scenes = withPreview(found.scenes);
        L.busy = '';
        if (!scenes.length) L.notice = `NISAR has no previewable scenes for M ${q.magnitude.toFixed(1)} yet.`;
        else {
          startReplay({ id: `replay-${id}`, name: q.title, bbox: aoi, scenes, eventTime: q.time });
          return;
        }
      } catch (err) {
        L.busy = '';
        fail(err);
      }
    }
  }
  render();
}

/**
 * A just-tracked event has no scenes until the backend's ingest finds them.
 * Re-check its detail at most five times over ~2 minutes and fill the scenes in place
 * (without resetting the panel) as soon as they appear.
 */
async function watchNewEvent(id) {
  const seq = liveSeq;
  for (const delay of [5000, 10000, 20000, 30000, 45000]) {
    await new Promise((r) => setTimeout(r, delay));
    const L = state.live;
    if (seq !== liveSeq || L.eventId !== id || L.replay || state.source !== 'live' || document.hidden) return;
    if (L.detail.status === 'done' && L.detail.data.scenes.length > 0) return;
    let data;
    try {
      data = await api.event(id, { fresh: true });
    } catch {
      continue;
    }
    if (seq !== liveSeq || state.live.eventId !== id) return;
    if (!Array.isArray(data.scenes) || !data.scenes.length) continue;
    L.detail = st('done', { data });
    const tl = liveTimeline(data, L.layer);
    L.idx = tl.steps.length ? tl.steps.length - 1 : null;
    ensureBrowseImages(tl);
    if (state.source === 'live') fitLive();
    render();
    return;
  }
  if (seq === liveSeq) {
    state.live.notice = 'The ingest is still running. Refresh the catalog to check again.';
    render();
  }
}

function startReplay(next) {
  const L = state.live;
  stopPlaying();
  ++liveSeq;
  L.replay = next;
  L.eventId = '';
  L.detail = IDLE();
  L.idx = 0;
  L.layer = 'preview';
  L.panel = 'event';
  state.errors.asset = '';
  const tl = liveTimeline(liveDetailData(), 'preview');
  ensureBrowseImages(tl);
  fitLive();
  render();
  if (tl.steps.length > 1) startPlaying();
  render();
}

/* Outlook (modelled) */

function currentViewBox() {
  if (!map) return [122.9, 24.0, 146.0, 45.7];
  const b = map.getBounds();
  return outlookBoxFrom({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
}

async function loadOutlook() {
  const L = state.live;
  const box = L.outlookBox || currentViewBox();
  L.outlookBox = box;
  const key = `${box.join(',')}|${L.horizon}`;
  L.outlook = st('loading', { key });
  render();
  try {
    const data = await api.outlook(box, L.horizon);
    if (L.outlook.key !== key) return;
    L.outlook = st('done', { data, key });
    if (L.cell && !data.cells.some((c) => c.id === L.cell)) L.cell = null;
  } catch (err) {
    if (L.outlook.key !== key) return;
    L.outlook = st('error', { key, message: err && err.message ? err.message : 'Outlook failed' });
  }
  render();
}

function toggleOutlook(on = !state.live.outlookOn) {
  const L = state.live;
  L.outlookOn = on;
  if (on) {
    L.outlookBox = currentViewBox();
    L.panel = 'outlook';
    loadOutlook();
    return;
  }
  L.cell = null;
  if (L.panel === 'outlook') L.panel = L.area ? 'area' : 'event';
  render();
}

function selectCell(cellId) {
  const L = state.live;
  L.cell = cellId;
  L.panel = 'outlook';
  const cell = L.outlook.status === 'done' ? L.outlook.data.cells.find((c) => c.id === cellId) : null;
  if (cell && map) fitBox(map, cell.bbox, paddingFor(map, isMobile()), true);
  render();
}

/* Replay room */

function applyRoomState(rs, serverTime) {
  const L = state.live;
  if (state.source !== 'live' || !rs) return;
  const clock = Number.isFinite(serverTime) ? serverTime : Date.now();
  L.room.playback = { ...rs, serverTime: clock, receivedAt: performance.now() };
  // Remote state is applied without sending anything back: only explicit
  // user actions (seek, play, pause, choosing an event) are sent to the room.
  {
    if (!rs.eventId) {
      // An empty room adopts this viewer's event and pass.
      if (L.eventId && !L.replay) {
        room.send({ type: 'load', eventId: L.eventId });
        if (L.idx !== null) room.send({ type: 'seek', frame: L.idx });
      }
      return;
    }
    if (rs.eventId !== L.eventId || L.replay) {
      L.pendingFrame = Number.isInteger(rs.frame) ? rs.frame : null;
      L.pendingPlay = Boolean(rs.playing);
      selectLiveEvent(rs.eventId, { fromRoom: true });
      return;
    }
    const v = liveView();
    if (v.len) L.idx = replayFrameAt(rs, v.len, clock);
    if (rs.playing && !state.playing) startPlaying();
    else if (!rs.playing && state.playing) stopPlaying();
    render();
  }
}

function leaveRoom() {
  room.close();
  state.live.room = { status: 'idle', code: '', count: 0, message: '' };
}

/* Channel switching */

function saveSource(source) {
  try {
    window.localStorage.setItem('spaceapp.source', source);
  } catch {
    /* per-viewer convenience only */
  }
}

function savedSource() {
  try {
    return window.localStorage.getItem('spaceapp.source');
  } catch {
    return null;
  }
}

function enterLive() {
  if (state.source === 'live') return;
  stopPlaying();
  state.source = 'live';
  saveSource('live');
  render();
  const status = state.live.events.status;
  if (status === 'idle' || status === 'error') loadLiveEvents();
  else fitLive();
}

function enterDemo(hazardId) {
  stopPlaying();
  leaveRoom();
  state.source = 'demo';
  saveSource('demo');
  if (getHazard(hazardId) && hazardId !== state.hazard) {
    switchHazard(hazardId);
    return;
  }
  render();
  if (!cache.rasters.has(state.hazard)) loadHazard(state.hazard);
  if (map) refitCamera(map, getHazard(state.hazard) || defaultHazard(), isMobile(), true);
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

/** Length of the timeline the active channel shows. */
function activeLength() {
  return state.source === 'live' ? liveView().len : timelineFor(state.hazard).length;
}

function startPlaying() {
  stopPlaying();
  const len = activeLength();
  if (len < 2) return;
  state.playing = true;
  playTimer = setInterval(() => {
    const n = activeLength();
    if (n < 2) {
      stopPlaying();
      render();
      return;
    }
    // Wraps from the last forecast back to the first observed pass; the
    // observed behaviour is restored by render() because every lock is derived.
    if (state.source === 'live') {
      const playback = state.live.room.playback;
      state.live.idx = room.open && playback?.playing && playback.eventId === state.live.eventId
        ? replayFrameAt(playback, n, playback.serverTime + performance.now() - playback.receivedAt)
        : ((state.live.idx === null ? -1 : state.live.idx) + 1) % n;
    } else {
      state.idx = ((state.idx === null ? -1 : state.idx) + 1) % n;
    }
    render();
  }, state.source === 'live' && room.open ? 200 : Math.max(100, Number(CONFIG.playIntervalMs) || 1000));
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
  const len = activeLength();
  if (!len || !Number.isFinite(i)) return;
  stopPlaying();
  const next = Math.min(len - 1, Math.max(0, Math.round(i)));
  if (state.source === 'live') {
    state.live.idx = next;
    // A user's seek is shared with the replay room (search replays are not).
    if (room.open && !state.live.replay) room.send({ type: 'pause', frame: next });
  } else {
    state.idx = next;
  }
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
    if (state.source === 'live' && room.open && !state.live.replay) {
      room.send(state.playing ? { type: 'play' } : { type: 'pause', frame: state.live.idx === null ? 0 : state.live.idx });
    }
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
    if (state.source === 'demo' && deriveView(state).isForecast) {
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
    if (!input || input.name !== 'hazard' || !input.checked) return;
    if (input.value === 'live') enterLive();
    else if (state.source === 'live') enterDemo(input.value);
    else switchHazard(input.value);
  });

  bindLiveEvents();

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

  // Auth forms are plain GET navigations to /auth/login (Auth0 hosted page).
  // They hold no credential fields; the browser leaves this page to sign in.
  const guardAuth = (e) => {
    const a = state.api;
    if (a.status !== 'online' || a.auth === 'unavailable' || a.auth === 'checking' || a.auth === 'signed-in') e.preventDefault();
  };
  el.signinForm.addEventListener('submit', guardAuth);
  el.signupForm.addEventListener('submit', guardAuth);

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
      if (map && state.route === 'home' && state.source === 'demo') refitCamera(map, getHazard(state.hazard) || defaultHazard(), isMobile(), false);
    }, 150);
  });

  window.addEventListener('hashchange', route);
}

/** Controls and evidence of the LIVE channel. */
function bindLiveEvents() {
  const L = () => state.live;
  el.liveRefresh.addEventListener('click', refreshLiveCatalog);

  el.liveEvent.addEventListener('change', () => {
    const id = el.liveEvent.value;
    if (!id || (L().replay && id === L().replay.id)) return;
    selectLiveEvent(id);
  });
  el.liveLayer.addEventListener('change', () => {
    L().layer = el.liveLayer.value || 'preview';
    const v = liveView();
    L().idx = v.len ? v.len - 1 : null;
    stopPlaying();
    render();
  });
  el.liveFit.addEventListener('click', () => fitLive());
  el.liveOutlook.addEventListener('click', () => toggleOutlook());
  el.liveSim.addEventListener('click', () => {
    L().sim = !L().sim;
    render();
    fitLive();
  });
  el.liveSimModel.addEventListener('change', () => {
    L().simModel = el.liveSimModel.value || 'auto';
    render();
  });

  el.livePredict.addEventListener('click', () => {
    if (L().eventId) loadInto('predict', () => api.predict(L().eventId));
  });
  el.liveBrief.addEventListener('click', () => {
    if (L().eventId) loadInto('brief', () => api.summary(L().eventId));
  });
  el.liveAskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    askQuestion(el.liveAskInput.value);
  });

  el.liveAreaClose.addEventListener('click', () => {
    L().area = null;
    L().panel = 'event';
    render();
  });
  const onRange = (key, input) => () => {
    const next = setRangeEnd(L().range, key, input.value, { maxSpan: MAX_SEARCH_DAYS });
    const changed = next.start !== L().range.start || next.end !== L().range.end;
    L().range = next;
    if (changed) runAreaQueries();
    else render();
  };
  el.liveRangeStart.addEventListener('change', onRange('start', el.liveRangeStart));
  el.liveRangeEnd.addEventListener('change', onRange('end', el.liveRangeEnd));
  el.liveAreaBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled || !el.liveAreaBody.contains(btn)) return;
    liveAction(btn.dataset.action, btn.dataset.id || '');
  });

  el.liveOutlookClose.addEventListener('click', () => toggleOutlook(false));
  el.liveOutlookView.addEventListener('click', () => {
    L().outlookBox = currentViewBox();
    loadOutlook();
  });
  el.liveHorizon.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-horizon]');
    if (!btn) return;
    const days = Number(btn.dataset.horizon);
    if (days === L().horizon) return;
    L().horizon = days;
    loadOutlook();
  });
  el.liveOutlookBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cell]');
    if (btn) selectCell(btn.dataset.cell);
  });

  el.roomForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.roomCode.value.trim().toUpperCase();
    if (!el.roomForm.checkValidity() || !code) {
      el.roomForm.reportValidity();
      return;
    }
    state.live.room = { status: 'connecting', code, count: 0, message: '' };
    render();
    room.connect(code);
  });
  el.roomLeave.addEventListener('click', () => {
    leaveRoom();
    render();
  });
}

/* ------------------------------------------------------------------ */
/* Map click                                                            */
/* ------------------------------------------------------------------ */

function onMapClick(lngLat) {
  if (state.route !== 'home') return;
  if (state.source === 'live') {
    // An outlook cell answers first; anywhere else explores that area.
    const cell = lngLat.point ? outlookCellAt(map, lngLat.point) : null;
    if (cell) selectCell(cell);
    else exploreAt(lngLat.lng, lngLat.lat);
    return;
  }
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
  if (sourceId === 'live-tiles') {
    const msg = `Processed tiles failed to load (${info && info.detail ? info.detail : 'tile error'}). Nothing is drawn in their place.`;
    if (state.errors.asset !== msg) {
      state.errors.asset = msg;
      render();
    }
    return;
  }
  if (sourceId.startsWith('live-')) return; // preview failures are reported by their loader
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
    if (map && state.source === 'demo') refitCamera(map, getHazard(state.hazard) || defaultHazard(), isMobile(), false);
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
      try {
        addLiveLayers(map);
        liveLayersReady = true;
      } catch (err) {
        state.errors.map = `Live map layers could not be added (${err && err.message ? err.message : 'layer setup failed'}).`;
      }
      render();
      if (state.source === 'live') fitLive(false);
    });
  }

  // Load demo rasters only when the viewer has deliberately selected a demo.
  if (savedSource() === 'demo') loadHazard(state.hazard);

  // 4b. Earth Replay API connection + session check (never blocks the demo).
  probe().then((r) => {
    state.api = r.online
      ? { status: 'online', eventCount: r.eventCount, user: r.user, auth: r.auth, authMessage: r.authMessage, error: '' }
      : { status: 'offline', eventCount: 0, user: null, auth: 'unavailable', authMessage: r.error, error: r.error };
    // The session is known now: load the saved conversation for an open event.
    const L = state.live;
    if (r.online && r.auth === 'signed-in' && L.detail.status === 'done' && !L.ask.history) loadChatHistory(L.eventId, liveSeq);
    render();
  });

  // 4c. Come back to the channel the viewer last used (e.g. after the Auth0
  //     round trip, which always lands on "/").
  if (savedSource() !== 'demo') enterLive();

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
    // Console access to the backend client, e.g. await __spaceapp.api.events()
    api,
    probe,
    // Read-only peek at the live channel for tests.
    get live() {
      const v = liveView();
      return { source: state.source, eventId: state.live.eventId, mode: v.tl.mode, steps: v.len, idx: v.idx, panel: state.live.panel, loading: v.loading };
    },
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(areaQueryTimer);
    stopPlaying();
    leaveRoom();
  });
}

boot();
