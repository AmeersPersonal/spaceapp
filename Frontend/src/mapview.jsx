import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";
import { basemapStyle, studyAreas } from "./studyArea.js";
import { useBottomInset, useTopInset } from "./useBottomInset.js";

// Vite needs to be told where MapLibre's background worker file is.
maplibregl.setWorkerUrl(workerUrl);

// Everything the map needs to know about one study area's timeline.
// The timeline has two halves: dates the satellite has already flown
// (we have an image) and dates the model is predicting (we do not).
function buildTimeline(area) {
  const { west, south, east, north } = area.bounds;
  const OBSERVED = area.dates;
  const FORECAST = area.forecast ?? [];
  const TIMELINE = [
    ...OBSERVED.map((d) => ({ ...d, kind: "observed" })),
    ...FORECAST.map((d) => ({ ...d, kind: "forecast" })),
  ];
  const LAST_OBSERVED = OBSERVED.length - 1;
  return {
    OBSERVED,
    FORECAST,
    TIMELINE,
    LAST_OBSERVED,
    // Where the "Now" divider sits on the slider track, as a percentage.
    NOW_PERCENT: Math.min(
      100,
      TIMELINE.length > 1
        ? ((LAST_OBSERVED + 0.5) / (TIMELINE.length - 1)) * 100
        : 100,
    ),
    // Corner order MapLibre expects: top-left, top-right, bottom-right, bottom-left.
    IMAGE_CORNERS: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}

const MAP_PADDING = 1.5; // degrees of slack around the study area

function insideBounds({ west, south, east, north }, lng, lat) {
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function maxBoundsFor({ west, south, east, north }) {
  return [
    [west - MAP_PADDING, south - MAP_PADDING],
    [east + MAP_PADDING, north + MAP_PADDING],
  ];
}

const RISK_COLOR = ["match", ["get", "risk"], "high", "#e5484d", "#f5a524"];

// (Re)build the radar overlay and the risk zones for one study area.
// Each area gets brand-new sources rather than moving one image across the
// globe: an image source whose coordinates change while images are still
// loading can end up with nothing to draw, taking the layers above it with it.
function installOverlays(map, area) {
  for (const id of ["risk-line", "risk-fill", "radar"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of ["risk", "radar"]) {
    if (map.getSource(id)) map.removeSource(id);
  }

  // Step 2 — the radar image, laid over the map.
  map.addSource("radar", {
    type: "image",
    url: area.dates[area.dates.length - 1].image,
    coordinates: buildTimeline(area).IMAGE_CORNERS,
  });
  map.addLayer({
    id: "radar",
    type: "raster",
    source: "radar",
    paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 },
  });

  // Step 6 — risk zones: observed for the past, predicted for the future.
  map.addSource("risk", { type: "geojson", data: area.riskZonesUrl });
  map.addLayer({
    id: "risk-fill",
    type: "fill",
    source: "risk",
    paint: { "fill-color": RISK_COLOR, "fill-opacity": 0.28 },
  });
  map.addLayer({
    id: "risk-line",
    type: "line",
    source: "risk",
    paint: { "line-color": RISK_COLOR, "line-width": 1.5 },
  });
}

// ---------- Helpers that read the radar images ----------

// Load an image and return its raw pixels so we can measure and compare them.
function loadPixels(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

// Radar brightness (0 to 1) at a longitude/latitude.
function sampleAt(pixels, { west, south, east, north }, lng, lat) {
  const x = Math.floor(((lng - west) / (east - west)) * pixels.width);
  const y = Math.floor(((north - lat) / (north - south)) * pixels.height);
  const cx = Math.min(pixels.width - 1, Math.max(0, x));
  const cy = Math.min(pixels.height - 1, Math.max(0, y));
  return pixels.data[(cy * pixels.width + cx) * 4] / 255;
}

// Average the image into small blocks. Radar images are grainy ("speckle"),
// so comparing single pixels gives noise; comparing block averages does not.
const BLOCK = 4;
function blockAverage(pixels) {
  const w = Math.floor(pixels.width / BLOCK);
  const h = Math.floor(pixels.height / BLOCK);
  const out = new Float32Array(w * h);
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let sum = 0;
      for (let dy = 0; dy < BLOCK; dy++) {
        for (let dx = 0; dx < BLOCK; dx++) {
          sum +=
            pixels.data[
              ((by * BLOCK + dy) * pixels.width + bx * BLOCK + dx) * 4
            ];
        }
      }
      out[by * w + bx] = sum / (BLOCK * BLOCK);
    }
  }
  return { width: w, height: h, values: out };
}

// Build a change-detection image: blue where the ground got darker than the
// baseline date, orange where it got brighter, transparent where it's the same.
// Returns ImageData, handed straight to the map with no network round trip.
function buildChangeImage(basePixels, currentPixels) {
  const base = blockAverage(basePixels);
  const current = blockAverage(currentPixels);
  const out = new ImageData(base.width, base.height);
  const THRESHOLD = 55; // ignore small differences

  for (let i = 0; i < base.values.length; i++) {
    const diff = current.values[i] - base.values[i];
    if (Math.abs(diff) < THRESHOLD) continue;
    const o = i * 4;
    if (diff < 0) {
      out.data[o] = 43;
      out.data[o + 1] = 131;
      out.data[o + 2] = 255;
    } else {
      out.data[o] = 255;
      out.data[o + 1] = 140;
      out.data[o + 2] = 40;
    }
    out.data[o + 3] = Math.min(255, 90 + Math.abs(diff) * 2);
  }
  return out;
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------- Chart of radar brightness at the clicked point ----------
// Only the observed half has values; the forecast half is shaded and empty,
// because no satellite pass has happened yet.

function TimeChart({ tl, values, activeIndex }) {
  const { TIMELINE, FORECAST, LAST_OBSERVED } = tl;
  const W = 300;
  const H = 130;
  const pad = { left: 30, right: 10, top: 10, bottom: 22 };
  const span = TIMELINE.length - 1 || 1;
  const x = (i) => pad.left + (i / span) * (W - pad.left - pad.right);
  const y = (v) => pad.top + (1 - v) * (H - pad.top - pad.bottom);
  const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const nowX = x(LAST_OBSERVED + 0.5);

  return (
    <svg
      className="sx-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Radar brightness over time at the selected point"
    >
      {FORECAST.length > 0 && (
        <rect
          className="sx-chart-future"
          x={nowX}
          y={pad.top}
          width={W - pad.right - nowX}
          height={H - pad.top - pad.bottom}
        />
      )}
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line
            className="sx-chart-grid"
            x1={pad.left}
            x2={W - pad.right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text
            className="sx-chart-label"
            x={pad.left - 6}
            y={y(tick) + 3}
            textAnchor="end"
          >
            {tick}
          </text>
        </g>
      ))}
      <polyline className="sx-chart-line" points={line} />
      {values.map((v, i) => (
        <circle
          key={i}
          className={
            i === activeIndex
              ? "sx-chart-dot sx-chart-dot-active"
              : "sx-chart-dot"
          }
          cx={x(i)}
          cy={y(v)}
          r={i === activeIndex ? 5 : 3}
        >
          <title>{`${formatDate(TIMELINE[i].date)}: ${v.toFixed(2)}`}</title>
        </circle>
      ))}
      {FORECAST.length > 0 && (
        <>
          <line
            className="sx-chart-now"
            x1={nowX}
            x2={nowX}
            y1={pad.top}
            y2={H - pad.bottom}
          />
          <text className="sx-chart-label" x={nowX + 4} y={pad.top + 9}>
            no data yet
          </text>
        </>
      )}
      <text className="sx-chart-label" x={pad.left} y={H - 5}>
        {formatDate(TIMELINE[0].date)}
      </text>
      <text
        className="sx-chart-label"
        x={W - pad.right}
        y={H - 5}
        textAnchor="end"
      >
        {formatDate(TIMELINE[TIMELINE.length - 1].date)}
      </text>
    </svg>
  );
}

// ---------- Chart of hazard risk across the whole timeline ----------
// Solid line = worked out from radar we already have.
// Dashed line = the model's prediction.

function RiskChart({ tl, activeIndex }) {
  const { TIMELINE, FORECAST, LAST_OBSERVED } = tl;
  const W = 300;
  const H = 130;
  const pad = { left: 30, right: 10, top: 10, bottom: 22 };
  const span = TIMELINE.length - 1 || 1;
  const x = (i) => pad.left + (i / span) * (W - pad.left - pad.right);
  const y = (v) => pad.top + (1 - v) * (H - pad.top - pad.bottom);
  const nowX = x(LAST_OBSERVED + 0.5);

  // Points we actually have a number for, in timeline order.
  const points = TIMELINE.map((step, i) => {
    const value = step.kind === "observed" ? step.risk : step.probability;
    return typeof value === "number" ? { i, value, kind: step.kind } : null;
  }).filter(Boolean);

  if (points.length === 0) return null;

  const past = points.filter((p) => p.kind === "observed");
  const future = points.filter((p) => p.kind === "forecast");
  // Join the two lines so the curve does not break at "Now".
  const bridge =
    past.length && future.length ? [past[past.length - 1], ...future] : future;
  const toPath = (list) => list.map((p) => `${x(p.i)},${y(p.value)}`).join(" ");

  return (
    <svg
      className="sx-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Hazard risk over time, measured then predicted"
    >
      {FORECAST.length > 0 && (
        <rect
          className="sx-chart-future"
          x={nowX}
          y={pad.top}
          width={W - pad.right - nowX}
          height={H - pad.top - pad.bottom}
        />
      )}
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line
            className="sx-chart-grid"
            x1={pad.left}
            x2={W - pad.right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text
            className="sx-chart-label"
            x={pad.left - 6}
            y={y(tick) + 3}
            textAnchor="end"
          >
            {tick}
          </text>
        </g>
      ))}
      {past.length > 1 && (
        <polyline className="sx-chart-line" points={toPath(past)} />
      )}
      {bridge.length > 1 && (
        <polyline
          className="sx-chart-line sx-chart-line-forecast"
          points={toPath(bridge)}
        />
      )}
      {points.map((p) => (
        <circle
          key={p.i}
          className={
            p.i === activeIndex
              ? "sx-chart-dot sx-chart-dot-active"
              : "sx-chart-dot"
          }
          cx={x(p.i)}
          cy={y(p.value)}
          r={p.i === activeIndex ? 5 : 3}
        >
          <title>{`${formatDate(TIMELINE[p.i].date)}: ${p.value.toFixed(2)}`}</title>
        </circle>
      ))}
      {FORECAST.length > 0 && (
        <>
          <line
            className="sx-chart-now"
            x1={nowX}
            x2={nowX}
            y1={pad.top}
            y2={H - pad.bottom}
          />
          <text className="sx-chart-label" x={nowX + 4} y={pad.top + 9}>
            predicted
          </text>
        </>
      )}
      <text className="sx-chart-label" x={pad.left} y={H - 5}>
        {formatDate(TIMELINE[0].date)}
      </text>
      <text
        className="sx-chart-label"
        x={W - pad.right}
        y={H - 5}
        textAnchor="end"
      >
        {formatDate(TIMELINE[TIMELINE.length - 1].date)}
      </text>
    </svg>
  );
}

// ---------- The map explorer ----------

function MapView() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const changeCache = useRef(new Map());
  const overlayAreaRef = useRef(null); // which area the map's overlays show

  const [areaId, setAreaId] = useState(studyAreas[0].id);
  const area = studyAreas.find((a) => a.id === areaId) ?? studyAreas[0];
  const tl = useMemo(() => buildTimeline(area), [area]);
  const {
    OBSERVED,
    FORECAST,
    TIMELINE,
    LAST_OBSERVED,
    NOW_PERCENT,
    IMAGE_CORNERS,
  } = tl;
  // The map's click handler is set up once, so it reads the area from here.
  const areaRef = useRef(area);
  useEffect(() => {
    areaRef.current = area;
  }, [area]);

  const [mapReady, setMapReady] = useState(false);
  const [pixels, setPixels] = useState(null); // raw pixels of every observed image
  const [loadError, setLoadError] = useState("");

  const [dateIndex, setDateIndex] = useState(
    () => studyAreas[0].dates.length - 1, // start at "now"
  );
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState("radar"); // 'radar' or 'change'
  const [baselineIndex, setBaselineIndex] = useState(0);
  const [opacity, setOpacity] = useState(0.85);
  const [showRisk, setShowRisk] = useState(true);
  const [point, setPoint] = useState(null); // clicked location
  const controlsRef = useBottomInset(); // keeps the attribution above the controls bar
  const pickerRef = useTopInset(); // keeps the phone prompt below the scenario picker
  const [panelOpen, setPanelOpen] = useState(false); // detail card, opened by clicking the map

  const step = TIMELINE[dateIndex] ?? TIMELINE[LAST_OBSERVED];
  const isForecast = step.kind === "forecast";

  // Switch to another disaster: reset the timeline to its "now" and drop
  // anything that belonged to the old area.
  function selectArea(id) {
    if (id === areaId) return;
    const next = studyAreas.find((a) => a.id === id);
    if (!next) return;
    setAreaId(id);
    setDateIndex(next.dates.length - 1);
    setPlaying(false);
    setMode("radar");
    setBaselineIndex(0);
    setPoint(null);
    setPixels(null);
    setLoadError("");
  }

  // Step 1 — create the map, locked onto the first study area.
  useEffect(() => {
    const first = areaRef.current;
    const { west, south, east, north } = first.bounds;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle,
      bounds: [
        [west, south],
        [east, north],
      ],
      fitBoundsOptions: { padding: 30 },
      maxBounds: maxBoundsFor(first.bounds),
      // Strictly 2D: no tilting or rotating.
      pitchWithRotate: false,
      dragRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );

    // The overlays are added by the area effect below once the map is ready.
    map.on("load", () => {
      mapRef.current = map;
      setMapReady(true);
    });

    // Surface map problems instead of failing silently.
    map.on("error", (event) => {
      console.error("Map error:", event.error ?? event);
    });

    // Step 5 — click a point inside the study area: drop a marker there and
    // open the detail card for it.
    map.on("click", (event) => {
      const { lng, lat } = event.lngLat;
      if (insideBounds(areaRef.current.bounds, lng, lat)) {
        setPoint({ lng, lat });
        setPanelOpen(true);
      }
    });
    map.on("mouseenter", "radar", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "radar", () => {
      map.getCanvas().style.cursor = "";
    });

    return () => {
      mapRef.current = null;
      overlayAreaRef.current = null; // a new map needs its overlays again
      setMapReady(false);
      map.remove();
    };
  }, []);

  // Build the overlays for the chosen area, then fly there. The pan limits
  // are lifted for the flight and put back around the new area when it lands.
  // Declared before the effects that update the overlays, so they always
  // find them in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (overlayAreaRef.current === area.id) return;
    const firstTime = overlayAreaRef.current === null;
    overlayAreaRef.current = area.id;
    installOverlays(map, area);
    if (firstTime) return; // the map was created looking at this area
    const { west, south, east, north } = area.bounds;
    const lock = () => map.setMaxBounds(maxBoundsFor(area.bounds));
    map.setMaxBounds(null);
    map.once("moveend", lock);
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 30, duration: 2200, essential: true },
    );
    return () => map.off("moveend", lock);
  }, [mapReady, area]);

  // Load the pixels of every observed image for this area (for the chart and
  // change view).
  useEffect(() => {
    let cancelled = false;
    Promise.all(OBSERVED.map((d) => loadPixels(d.image)))
      .then((all) => {
        if (!cancelled) setPixels(all);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [OBSERVED]);

  // Steps 3 and 4 — show the chosen date. Future dates have no image of their
  // own, so the last real pass stays on screen, dimmed, as ground context.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const source = map.getSource("radar");
    if (!source) return;
    const imageIndex = isForecast ? LAST_OBSERVED : dateIndex;
    const url = OBSERVED[imageIndex]?.image;
    if (!url) return;

    // Once this area's images are decoded, hand them over directly: no
    // request to cancel halfway, nothing to race with the next date.
    const ready = pixels && pixels.length === OBSERVED.length;
    let image = ready ? pixels[imageIndex] : null;
    if (ready && !isForecast && mode === "change") {
      const key = `${area.id}-${baselineIndex}-${dateIndex}`;
      if (!changeCache.current.has(key)) {
        changeCache.current.set(
          key,
          buildChangeImage(pixels[baselineIndex], pixels[dateIndex]),
        );
      }
      image = changeCache.current.get(key);
    }
    source.updateImage(
      image
        ? { image, coordinates: IMAGE_CORNERS }
        : { url, coordinates: IMAGE_CORNERS },
    );
  }, [
    mapReady,
    area,
    OBSERVED,
    LAST_OBSERVED,
    IMAGE_CORNERS,
    pixels,
    dateIndex,
    isForecast,
    mode,
    baselineIndex,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !map.getLayer("radar")) return;
    // Fade the radar on forecast dates so it reads as background, not evidence.
    map.setPaintProperty(
      "radar",
      "raster-opacity",
      isForecast ? opacity * 0.35 : opacity,
    );
  }, [mapReady, area, opacity, isForecast]);

  // Swap the risk zones for the predicted ones, and make them stronger the
  // more likely the model thinks the hazard is.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource("risk");
    if (!source) return;
    source.setData((isForecast && step.riskZonesUrl) || area.riskZonesUrl);
    map.setPaintProperty(
      "risk-fill",
      "fill-opacity",
      isForecast ? 0.18 + 0.45 * (step.probability ?? 0.5) : 0.28,
    );
  }, [mapReady, area, isForecast, step]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !map.getLayer("risk-fill")) return;
    const visibility = showRisk ? "visible" : "none";
    map.setLayoutProperty("risk-fill", "visibility", visibility);
    map.setLayoutProperty("risk-line", "visibility", visibility);
  }, [mapReady, area, showRisk]);

  // Step 3 — play button: run the whole timeline, past into future.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setDateIndex((i) => (i + 1) % TIMELINE.length);
    }, 1000);
    return () => clearInterval(timer);
  }, [playing, TIMELINE.length]);

  // Marker for the clicked point.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !point) return;
    if (!markerRef.current) {
      markerRef.current = new maplibregl.Marker({ color: "#ffffff" });
      // Clicking the pin itself reopens the card after it has been closed.
      const el = markerRef.current.getElement();
      el.style.cursor = "pointer";
      el.addEventListener("click", () => setPanelOpen(true));
    }
    markerRef.current.setLngLat([point.lng, point.lat]).addTo(map);
    return () => markerRef.current?.remove();
  }, [mapReady, point]);

  const series = useMemo(() => {
    if (!point || !pixels) return null;
    return pixels.map((p) => sampleAt(p, area.bounds, point.lng, point.lat));
  }, [point, pixels, area]);

  const currentDate = formatDate(step.date);

  return (
    <div className={`sx${panelOpen ? " sx-panel-open" : ""}`}>
      <div ref={containerRef} className="sx-map" />

      <div className="sx-topleft">
        <div className="sx-datebadge">
          {currentDate}
          {isForecast && <span className="sx-tag">Forecast</span>}
        </div>
        {area.isSample && <div className="sx-samplebadge">Sample data</div>}
      </div>

      {/* Pick a disaster. Each one is a separate study area. */}
      <nav ref={pickerRef} className="sx-picker" aria-label="Disasters">
        {studyAreas.map((a) => (
          <button
            key={a.id}
            className={`sx-pick sx-pick-${a.id}${a.id === area.id ? " sx-pick-active" : ""}`}
            onClick={() => selectArea(a.id)}
            aria-pressed={a.id === area.id}
          >
            <span className="sx-pick-dot" aria-hidden="true" />
            <span className="sx-pick-text">
              <span className="sx-pick-hazard">{a.hazard}</span>
              <span className="sx-pick-place">{a.name}</span>
            </span>
          </button>
        ))}
      </nav>

      {!panelOpen && (
        <button className="sx-hint" onClick={() => setPanelOpen(true)}>
          Click the map to open the forecast
        </button>
      )}

      <div ref={controlsRef} className={`sx-controls${panelOpen ? " sx-controls-shift" : ""}`}>
        {/* The track under the slider: how much is data, how much is model. */}
        <div className="sx-timeline" aria-hidden="true">
          <div className="sx-tl-past" style={{ width: `${NOW_PERCENT}%` }}>
            <span>Observed</span>
          </div>
          <div
            className="sx-tl-future"
            style={{ width: `${100 - NOW_PERCENT}%` }}
          >
            <span>Forecast</span>
          </div>
          {FORECAST.length > 0 && (
            <div className="sx-tl-now" style={{ left: `${NOW_PERCENT}%` }}>
              <span>Now</span>
            </div>
          )}
        </div>

        <div className="sx-row">
          <button
            className="sx-play"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <input
            className={`sx-slider sx-grow${isForecast ? " sx-slider-forecast" : ""}`}
            type="range"
            min="0"
            max={TIMELINE.length - 1}
            step="1"
            value={dateIndex}
            onChange={(e) => {
              setPlaying(false);
              setDateIndex(Number(e.target.value));
            }}
            aria-label="Date"
          />
          <span className={`sx-date${isForecast ? " sx-date-forecast" : ""}`}>
            {currentDate}
          </span>
        </div>

        <div className="sx-row sx-wrap">
          <div className="sx-toggle" role="group" aria-label="View">
            <button
              className={mode === "radar" ? "sx-active" : ""}
              onClick={() => setMode("radar")}
              disabled={isForecast}
            >
              Radar image
            </button>
            <button
              className={mode === "change" ? "sx-active" : ""}
              onClick={() => setMode("change")}
              disabled={!pixels || isForecast}
            >
              Change since
            </button>
          </div>

          {mode === "change" && !isForecast && (
            <select
              className="sx-select"
              value={baselineIndex}
              onChange={(e) => setBaselineIndex(Number(e.target.value))}
              aria-label="Baseline date"
            >
              {OBSERVED.map((d, i) => (
                <option key={d.date} value={i}>
                  {formatDate(d.date)}
                </option>
              ))}
            </select>
          )}

          <label className="sx-inline">
            Opacity
            <input
              className="sx-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>

          <label className="sx-inline">
            <input
              type="checkbox"
              checked={showRisk}
              onChange={(e) => setShowRisk(e.target.checked)}
            />
            Risk estimate
          </label>
        </div>
      </div>

      <aside className={`sx-panel${panelOpen ? "" : " sx-panel-hidden"}`}>
        <button
          className="sx-close"
          onClick={() => setPanelOpen(false)}
          aria-label="Close"
        >
          ×
        </button>
        <p className="sx-eyebrow">{area.hazard}</p>
        <h2>{area.name}</h2>

        {/* The prediction card, only while the slider is past "Now". */}
        {isForecast && (
          <div className="sx-forecast">
            <div className="sx-forecast-head">
              <span className="sx-forecast-title">
                Predicted for {currentDate}
              </span>
              <span className={`sx-pill sx-pill-${step.level ?? "medium"}`}>
                {(step.level ?? "medium").toUpperCase()}
              </span>
            </div>
            <div className="sx-prob">
              <div
                className="sx-prob-fill"
                style={{
                  width: `${Math.round((step.probability ?? 0) * 100)}%`,
                }}
              />
            </div>
            <p className="sx-prob-value">
              {Math.round((step.probability ?? 0) * 100)}% chance of{" "}
              {area.hazard.toLowerCase()}
            </p>
            {step.note && <p className="sx-text">{step.note}</p>}
            {area.modelNote && <p className="sx-note">{area.modelNote}</p>}
          </div>
        )}

        {area.story.map((text) => (
          <p key={text} className="sx-text">
            {text}
          </p>
        ))}

        {area.sources?.length > 0 && (
          <>
            <h3>Data behind this</h3>
            <ul className="sx-sources">
              {area.sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        )}

        <h3>Risk over time</h3>
        <RiskChart tl={tl} activeIndex={dateIndex} />
        <p className="sx-note">
          Solid line is worked out from radar we already have. Dashed line is
          the model's prediction.
        </p>

        <h3>Legend</h3>
        {isForecast ? (
          <p className="sx-note">
            No satellite pass yet for this date. The last real image is faded
            underneath for context; the coloured zones are the prediction.
          </p>
        ) : mode === "radar" ? (
          <div className="sx-legend">
            <div className="sx-ramp" />
            <div className="sx-ramp-labels">
              <span>{area.legend.dark}</span>
              <span>{area.legend.bright}</span>
            </div>
          </div>
        ) : (
          <ul className="sx-legend-list">
            <li>
              <span className="sx-swatch" style={{ background: "#2b83ff" }} />
              {area.legend.darker}
            </li>
            <li>
              <span className="sx-swatch" style={{ background: "#ff8c28" }} />
              {area.legend.brighter}
            </li>
          </ul>
        )}
        {showRisk && (
          <ul className="sx-legend-list">
            <li>
              <span className="sx-swatch" style={{ background: "#e5484d" }} />
              {area.legend.high}{" "}
              {isForecast ? "(predicted)" : "(from observations)"}
            </li>
            <li>
              <span className="sx-swatch" style={{ background: "#f5a524" }} />
              {area.legend.medium}{" "}
              {isForecast ? "(predicted)" : "(from observations)"}
            </li>
          </ul>
        )}

        <h3>Brightness over time</h3>
        {loadError && <p className="sx-error">{loadError}</p>}
        {series ? (
          <>
            <TimeChart tl={tl} values={series} activeIndex={dateIndex} />
            <p className="sx-note">
              At {point.lat.toFixed(3)}°, {point.lng.toFixed(3)}°. 0 is darkest,
              1 is brightest.
            </p>
          </>
        ) : (
          <p className="sx-note">
            Click anywhere on the radar image to chart that spot across every
            pass.
          </p>
        )}
      </aside>
    </div>
  );
}

export default MapView;
