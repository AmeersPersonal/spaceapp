import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";
import "./NisarMap.css";
import { api } from "./api.js";
import { loadBrowseImage } from "./browseImage.js";
import { studyArea } from "./studyArea.js";

// The map fed by the backend catalog instead of the bundled sample data.
// Two kinds of NISAR imagery, in order of preference:
//   1. processed tile layers (event.layers), once the processor has run;
//   2. ASF browse previews of each catalogued scene, placed by footprint.
// With neither, the event's area and acquisition dates are shown on their own.

const day = (iso) => iso.slice(0, 10);

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatTime(iso) {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const rectangle = ([w, s, e, n]) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  },
});

// The box that holds the event area and every scene footprint.
function unionBounds(event, scenes) {
  const boxes = [event.bbox, ...scenes.map((s) => s.bounds)].filter(Boolean);
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

const layerId = (sceneId) => `scene-${sceneId}`;
const wideScreen = () => window.innerWidth > 900;

function NisarMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const addedRef = useRef(new Set()); // scene IDs currently on the map
  const pickRef = useRef(() => null); // finds the visible scene under a point

  const [mapReady, setMapReady] = useState(false);
  const [events, setEvents] = useState(null);
  const [listError, setListError] = useState("");
  const [eventId, setEventId] = useState("");
  const [detail, setDetail] = useState(null); // { event, scenes, layers, ... }
  const [detailError, setDetailError] = useState("");
  const [placed, setPlaced] = useState({}); // sceneId -> { url, coordinates }
  const [failed, setFailed] = useState(0); // previews that could not be shown
  const [dateIndex, setDateIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [opacity, setOpacity] = useState(0.85);
  const [infoOpen, setInfoOpen] = useState(wideScreen);
  const [selectedId, setSelectedId] = useState(null);

  // Step 1: the map, created once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: studyArea.basemapStyle,
      center: [0, 20],
      zoom: 1.5,
      pitchWithRotate: false,
      dragRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addSource("aoi", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "aoi-fill", type: "fill", source: "aoi", paint: { "fill-color": "#BFD1E5", "fill-opacity": 0.06 } });
      map.addLayer({ id: "aoi-line", type: "line", source: "aoi", paint: { "line-color": "#BFD1E5", "line-width": 1.5, "line-dasharray": [2, 2] } });
      mapRef.current = map;
      setMapReady(true);
    });
    // Click a scene on the map to open its details; the pointer shows what is clickable.
    map.on("click", (e) => {
      const scene = pickRef.current(e.lngLat.lng, e.lngLat.lat);
      if (scene) {
        setSelectedId(scene.id);
        setInfoOpen(true);
      }
    });
    map.on("mousemove", (e) => {
      map.getCanvas().style.cursor = pickRef.current(e.lngLat.lng, e.lngLat.lat) ? "pointer" : "";
    });
    const added = addedRef.current;
    return () => {
      mapRef.current = null;
      added.clear();
      setMapReady(false);
      map.remove();
    };
  }, []);

  // Step 2: the event list.
  useEffect(() => {
    let cancelled = false;
    api
      .events()
      .then(({ events: list }) => {
        if (cancelled) return;
        setEvents(list);
        // Start on an event that already has something to show.
        const best = list.find((e) => e.sceneCount > 0) ?? list[0];
        if (best) setEventId(best.id);
      })
      .catch((error) => !cancelled && setListError(error.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 3: the chosen event's scenes and layers.
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    api
      .event(eventId)
      .then((data) => {
        if (cancelled) return;
        setDetailError("");
        setFailed(0);
        setPlaced({});
        setSelectedId(null);
        setDetail(data);
      })
      .catch((error) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const event = detail?.event ?? null;
  const scenes = useMemo(() => detail?.scenes ?? [], [detail]);

  // Processed tiles, if any: use the first layer's dates.
  const tileLayer = detail?.layers?.[0]?.layer ?? null;
  const tileEntries = useMemo(
    () => (detail?.layers ?? []).filter((l) => l.layer === tileLayer).sort((a, b) => a.date.localeCompare(b.date)),
    [detail, tileLayer],
  );
  const previewScenes = useMemo(() => scenes.filter((s) => s.browseUrl && s.bounds), [scenes]);
  const mode = tileEntries.length ? "tiles" : previewScenes.length ? "previews" : "area";

  const dates = useMemo(() => {
    if (mode === "tiles") return tileEntries.map((l) => l.date);
    return [...new Set((mode === "previews" ? previewScenes : scenes).map((s) => day(s.acquiredAt)))].sort();
  }, [mode, tileEntries, previewScenes, scenes]);

  const currentDate = dates[Math.min(dateIndex, dates.length - 1)] ?? null;

  // Frame the data (also the "Zoom to data" button). On wide screens leave room for the card.
  const fitToData = useCallback(() => {
    const map = mapRef.current;
    const box = map && event ? unionBounds(event, scenes) : null;
    if (!box) return;
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {
      padding: { top: 150, bottom: 170, left: wideScreen() ? 370 : 40, right: 70 },
      duration: 600,
      maxZoom: 9,
    });
  }, [event, scenes]);

  // Step 4: draw the event's area and frame it.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    map.getSource("aoi").setData({
      type: "FeatureCollection",
      features: event?.bbox ? [rectangle(event.bbox)] : [],
    });
    fitToData();
  }, [mapReady, event, fitToData]);

  // Step 5: load every preview image once and work out where it goes.
  useEffect(() => {
    if (mode !== "previews") return;
    let cancelled = false;
    const urls = [];
    previewScenes.forEach((scene) => {
      loadBrowseImage(scene.browseUrl, scene.bounds)
        .then((image) => {
          urls.push(image.url);
          if (cancelled) return URL.revokeObjectURL(image.url);
          setPlaced((prev) => ({ ...prev, [scene.id]: image }));
        })
        .catch(() => !cancelled && setFailed((n) => n + 1));
    });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [mode, previewScenes]);

  // Step 6: keep the map's image layers in step with the placed previews.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const wanted = new Set(Object.keys(placed));
    for (const id of [...addedRef.current]) {
      if (!wanted.has(id)) {
        if (map.getLayer(layerId(id))) map.removeLayer(layerId(id));
        if (map.getSource(layerId(id))) map.removeSource(layerId(id));
        addedRef.current.delete(id);
      }
    }
    for (const id of wanted) {
      if (addedRef.current.has(id)) continue;
      map.addSource(layerId(id), { type: "image", url: placed[id].url, coordinates: placed[id].coordinates });
      map.addLayer(
        { id: layerId(id), type: "raster", source: layerId(id), layout: { visibility: "none" }, paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } },
        "aoi-fill",
      );
      addedRef.current.add(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opacity is applied by the next effect
  }, [mapReady, placed]);

  // Show only the previews acquired on the chosen date.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    for (const id of addedRef.current) {
      const scene = previewScenes.find((s) => s.id === id);
      const visible = scene && day(scene.acquiredAt) === currentDate;
      map.setLayoutProperty(layerId(id), "visibility", visible ? "visible" : "none");
      map.setPaintProperty(layerId(id), "raster-opacity", opacity);
    }
  }, [mapReady, placed, previewScenes, currentDate, opacity]);

  // Which visible scene sits under a map point (footprint boxes), for click and hover.
  useEffect(() => {
    pickRef.current = (lng, lat) =>
      mode === "previews" && currentDate
        ? previewScenes.find(
            (s) =>
              day(s.acquiredAt) === currentDate &&
              addedRef.current.has(s.id) &&
              lng >= s.bounds[0] && lng <= s.bounds[2] && lat >= s.bounds[1] && lat <= s.bounds[3],
          ) ?? null
        : null;
  }, [mode, currentDate, previewScenes, placed]);

  // Processed tiles for the chosen date.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const entry = mode === "tiles" ? tileEntries.find((l) => l.date === currentDate) : null;
    if (!entry) {
      if (map.getLayer("nisar-tiles")) map.removeLayer("nisar-tiles");
      if (map.getSource("nisar-tiles")) map.removeSource("nisar-tiles");
      return;
    }
    const url = new URL(entry.tiles, window.location.origin).href;
    const source = map.getSource("nisar-tiles");
    if (source) {
      source.setTiles([url]);
    } else {
      map.addSource("nisar-tiles", { type: "raster", tiles: [url], tileSize: 256, minzoom: entry.minZoom, maxzoom: entry.maxZoom, ...(entry.bounds ? { bounds: entry.bounds } : {}) });
      map.addLayer({ id: "nisar-tiles", type: "raster", source: "nisar-tiles", paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } }, "aoi-fill");
    }
    if (map.getLayer("nisar-tiles")) map.setPaintProperty("nisar-tiles", "raster-opacity", opacity);
  }, [mapReady, mode, tileEntries, currentDate, opacity]);

  // Start each event at its newest acquisition.
  useEffect(() => {
    setDateIndex(Math.max(0, dates.length - 1));
    setPlaying(false);
  }, [dates]);

  // Play through the acquisitions.
  useEffect(() => {
    if (!playing || dates.length < 2) return;
    const timer = setInterval(() => setDateIndex((i) => (i + 1) % dates.length), 1500);
    return () => clearInterval(timer);
  }, [playing, dates.length]);

  const onDate = currentDate ? scenes.filter((s) => day(s.acquiredAt) === currentDate) : [];
  const selected = scenes.find((s) => s.id === selectedId) ?? null;
  const loadingPreviews = mode === "previews" && Object.keys(placed).length + failed < previewScenes.length;
  const lastIndex = Math.max(0, dates.length - 1);

  return (
    <div className="sx">
      <div ref={containerRef} className="sx-map" />

      <div className="sx-nisar-top">
        <select
          className="sx-select sx-event-select"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          disabled={!events?.length}
          aria-label="Event"
        >
          {!events && <option>Loading events…</option>}
          {events?.length === 0 && <option>No events yet</option>}
          {events?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        {currentDate && <div className="sx-datebadge sx-nisar-date">{formatDate(currentDate)}</div>}
        {event && (
          <button className="sx-fit" onClick={fitToData} title="Zoom to the data">
            Zoom to data
          </button>
        )}
      </div>

      <aside className="sx-info">
        <button className="sx-info-head" onClick={() => setInfoOpen((o) => !o)} aria-expanded={infoOpen}>
          <span className="sx-info-title">{event ? event.name : "NISAR data"}</span>
          <span className="sx-info-sub">
            {event ? `${plural(scenes.length, "scene")} · ${plural(dates.length, "date")}` : events?.length === 0 ? "No events" : "Loading…"}
          </span>
          <span className="sx-chevron" aria-hidden="true">{infoOpen ? "▾" : "▸"}</span>
        </button>

        {infoOpen && (
          <div className="sx-info-body">
            {listError && <p className="sx-error">{listError}</p>}
            {detailError && <p className="sx-error">{detailError}</p>}
            {events?.length === 0 && (
              <p className="sx-note">
                The catalog has no events yet. Ingest an area or register an earthquake, or switch to the sample data.
              </p>
            )}
            {event && (
              <>
                {mode === "tiles" && <p className="sx-note">Showing processed layer “{tileLayer}”.</p>}
                {mode === "previews" && (
                  <p className="sx-note">
                    ASF’s preview image of each scene (an HH/HV colour composite). Quick-look pictures, not
                    measurements or change maps.
                    {loadingPreviews && " Loading previews…"}
                    {failed > 0 && ` ${plural(failed, "preview")} could not be loaded.`}
                  </p>
                )}
                {mode === "area" && (
                  <p className="sx-note">
                    {scenes.length
                      ? "These scenes have no preview or footprint stored yet (re-run the ingest to add them), and none are processed into map tiles. The dashed box is the tracked area."
                      : "No scenes found for this area yet. The dashed box is the tracked area."}
                  </p>
                )}

                {onDate.length > 0 && (
                  <>
                    <h3 className="sx-info-h">{formatDate(currentDate)}</h3>
                    <ul className="sx-scenes">
                      {onDate.map((s) => (
                        <li key={s.id}>
                          <button
                            className={`sx-scene${s.id === selectedId ? " sx-scene-active" : ""}`}
                            onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
                          >
                            <strong>{s.product}</strong> · {s.polarizations.join("/") || "—"}
                            {s.flightDirection ? ` · ${s.flightDirection.toLowerCase()}` : ""}
                            <span className="sx-scene-status">{String(s.status).replaceAll("_", " ")}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {selected && (
                  <dl className="sx-detail">
                    <div><dt>Acquired</dt><dd>{formatDate(day(selected.acquiredAt))}, {formatTime(selected.acquiredAt)}</dd></div>
                    {selected.pathNumber != null && <div><dt>Track / frame</dt><dd>{selected.pathNumber} / {selected.frameNumber ?? "—"}</dd></div>}
                    {selected.productionConfig && <div><dt>Processing</dt><dd>{selected.productionConfig === "UR" ? "Urgent response" : selected.productionConfig === "PR" ? "Standard production" : selected.productionConfig}</dd></div>}
                    <div><dt>Scene</dt><dd className="sx-scene-id">{selected.id}</dd></div>
                  </dl>
                )}
                {mode === "previews" && !selected && (
                  <p className="sx-note">Tip: click a scene on the map for its details.</p>
                )}
                <p className="sx-credit">NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC.</p>
              </>
            )}
          </div>
        )}
      </aside>

      <div className="sx-controls sx-controls-compact">
        <div className="sx-row">
          <button
            className="sx-play"
            onClick={() => setPlaying((p) => !p)}
            disabled={dates.length < 2}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <input
            className="sx-slider sx-grow"
            type="range"
            min="0"
            max={lastIndex}
            step="1"
            value={Math.min(dateIndex, lastIndex)}
            disabled={dates.length < 2}
            onChange={(e) => {
              setPlaying(false);
              setDateIndex(Number(e.target.value));
            }}
            aria-label="Acquisition date"
          />
          <span className="sx-date">{currentDate ? formatDate(currentDate) : "No dates"}</span>
        </div>
        <div className="sx-row">
          <label className="sx-inline sx-grow">
            Opacity
            <input
              className="sx-slider sx-grow"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

export default NisarMap;
