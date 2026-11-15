import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";
import "./NisarMap.css";
import { api } from "./api.js";
import { useAuth } from "./auth.jsx";
import AreaExplorer from "./AreaExplorer.jsx";
import OutlookPanel from "./OutlookPanel.jsx";
import { loadBrowseImage } from "./browseImage.js";
import { JAPAN_BBOX, LAYERS, areaAround, centreInJapan, contains, lastMonths, layerLabel, orderLayers, quakeDay, statusLabel, wrapLng, worldMask } from "./explore.js";
import { studyArea } from "./studyArea.js";
import { useBottomInset, useTopInset } from "./useBottomInset.js";

// The map fed by the backend catalog instead of the bundled sample data.
//
// Signed out: Japan is highlighted (the rest of the world is dimmed) and only Japan's
// events are offered; clicking elsewhere asks the visitor to sign in.
// Signed in: any event is available, and clicking a spot queries it (AreaExplorer)
// and offers the events that cover it.
//
// An event is shown with, in order of preference:
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

const emptyCollection = { type: "FeatureCollection", features: [] };

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

const OUTLOOK_LOADING = { status: "loading" };
const layerId = (sceneId) => `scene-${sceneId}`;
const wideScreen = () => window.innerWidth > 900;

function NisarMap({ onOpenSample }) {
  const { status: authStatus } = useAuth();
  const signedIn = authStatus === "signed-in";
  const showJapan = authStatus === "signed-out" || authStatus === "unavailable";

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const addedRef = useRef(new Set()); // scene IDs currently on the map
  const clickRef = useRef(() => {}); // latest click and hover behaviour, read by the map's listeners
  const hoverRef = useRef(() => "");

  const [mapReady, setMapReady] = useState(false);
  const [events, setEvents] = useState(null);
  const [listError, setListError] = useState("");
  // Deep link from the Events page: /?event=ID&replay=1 opens that event and plays it from the start.
  const [params] = useSearchParams();
  const [eventId, setEventId] = useState(() => params.get("event") ?? "");
  const [autoplay, setAutoplay] = useState(() => params.get("replay") === "1");
  const [layerPick, setLayerPick] = useState(""); // which processed layer to show, when an event has several
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [range, setRange] = useState(() => lastMonths(6)); // the area search period: last 6 months until changed
  // Earthquake outlook: a modeled layer of shaded cells, and its panel in the card.
  const [outlookOn, setOutlookOn] = useState(false);
  const [outlookBox, setOutlookBox] = useState(null); // region it is computed for
  const [horizon, setHorizon] = useState(30);
  const [outlookRaw, setOutlook] = useState({ status: "loading" });
  const [cellId, setCellId] = useState(null);
  const [replay, setReplay] = useState(null); // scenes found by a search, replayed without tracking: { id, name, bbox, scenes, eventTime? }
  const [detail, setDetail] = useState(null); // { event, scenes, layers, ... }
  const [detailError, setDetailError] = useState("");
  const [placed, setPlaced] = useState({}); // sceneId -> { url, coordinates }
  const [failed, setFailed] = useState(0); // previews that could not be shown
  const [dateIndex, setDateIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [opacity, setOpacity] = useState(0.85);
  const controlsRef = useBottomInset(); // keeps the attribution above the controls bar
  const toolbarRef = useTopInset(); // keeps the details card below the toolbar, even when it wraps
  const [infoOpen, setInfoOpen] = useState(wideScreen);
  const [selectedId, setSelectedId] = useState(null);
  const [japan, setJapan] = useState(null); // Japan's outline (GeoJSON)
  const [probe, setProbe] = useState(null); // the clicked spot: { id, lng, lat, bbox }
  const [prompt, setPrompt] = useState(false); // signed-out visitor clicked outside the showcase
  const ctaRef = useRef(null);

  // On a phone the card is short, so the sign-in prompt can open below its fold: bring it into view.
  useEffect(() => {
    if (prompt && infoOpen) ctaRef.current?.scrollIntoView({ block: "nearest" });
  }, [prompt, infoOpen]);

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
      // Japan showcase: dim the world, outline the country.
      map.addSource("japan-mask", { type: "geojson", data: emptyCollection });
      map.addSource("japan", { type: "geojson", data: emptyCollection });
      map.addLayer({ id: "japan-mask", type: "fill", source: "japan-mask", paint: { "fill-color": "#1e0f1c", "fill-opacity": 0.55 }, layout: { visibility: "none" } });
      map.addLayer({ id: "japan-glow", type: "line", source: "japan", paint: { "line-color": "#BFD1E5", "line-width": 7, "line-opacity": 0.28, "line-blur": 5 }, layout: { visibility: "none" } });
      map.addLayer({ id: "japan-line", type: "line", source: "japan", paint: { "line-color": "#BFD1E5", "line-width": 1.8 }, layout: { visibility: "none" } });

      // Earthquake outlook cells, shaded from pale yellow (low chance) to red (high).
      map.addSource("outlook", { type: "geojson", data: emptyCollection });
      map.addLayer({
        id: "outlook-fill",
        type: "fill",
        source: "outlook",
        layout: { visibility: "none" },
        paint: {
          "fill-color": ["interpolate", ["linear"], ["get", "probability"], 0, "#f6e27a", 0.3, "#f5a524", 0.7, "#e5484d", 1, "#b3122a"],
          "fill-opacity": ["interpolate", ["linear"], ["get", "probability"], 0, 0.18, 1, 0.6],
        },
      });
      map.addLayer({
        id: "outlook-line",
        type: "line",
        source: "outlook",
        layout: { visibility: "none" },
        paint: { "line-color": ["case", ["get", "selected"], "#ffffff", "rgba(42, 20, 40, 0.55)"], "line-width": ["case", ["get", "selected"], 2.5, 0.8] },
      });

      map.addSource("aoi", { type: "geojson", data: emptyCollection });
      map.addLayer({ id: "aoi-fill", type: "fill", source: "aoi", paint: { "fill-color": "#BFD1E5", "fill-opacity": 0.06 } });
      map.addLayer({ id: "aoi-line", type: "line", source: "aoi", paint: { "line-color": "#BFD1E5", "line-width": 1.5, "line-dasharray": [2, 2] } });
      mapRef.current = map;
      setMapReady(true);
    });
    map.on("click", (e) => clickRef.current(e.lngLat, e.point));
    map.on("mousemove", (e) => {
      map.getCanvas().style.cursor = hoverRef.current(e.lngLat);
    });
    const added = addedRef.current;
    return () => {
      mapRef.current = null;
      markerRef.current = null;
      added.clear();
      setMapReady(false);
      map.remove();
    };
  }, []);

  // Japan's outline is a small static file.
  useEffect(() => {
    let cancelled = false;
    fetch("/data/japan.geojson")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Japan outline unavailable"))))
      .then((data) => !cancelled && setJapan(data))
      .catch(() => {}); // the showcase still works without the highlight
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 2: the event list.
  useEffect(() => {
    let cancelled = false;
    api
      .events()
      .then(({ events: list }) => !cancelled && setEvents(list))
      .catch((error) => !cancelled && setListError(error.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Signed-out visitors see Japan's events only.
  const visibleEvents = useMemo(() => {
    if (!events) return null;
    return signedIn ? events : events.filter(centreInJapan);
  }, [events, signedIn]);

  // The event on screen: the user's pick if it is visible, else the first one with scenes.
  const activeId = useMemo(() => {
    if (!visibleEvents) return "";
    if (visibleEvents.some((e) => e.id === eventId)) return eventId;
    return (visibleEvents.find((e) => e.sceneCount > 0) ?? visibleEvents[0])?.id ?? "";
  }, [visibleEvents, eventId]);

  // Step 3: the active event's scenes and layers.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    api
      .event(activeId)
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
  }, [activeId]);

  // A replay stands in for the catalog event: same shape, so the rest of the map treats it alike.
  const replayDetail = useMemo(
    () =>
      replay && {
        event: { id: replay.id, name: replay.name, bbox: replay.bbox, type: replay.eventTime ? "earthquake" : "other" },
        scenes: replay.scenes.map((s) => ({ ...s, status: "preview" })),
        layers: [],
      },
    [replay],
  );
  const current = replayDetail ?? (activeId && detail?.event?.id === activeId ? detail : null);
  const event = current?.event ?? null;
  const scenes = useMemo(() => current?.scenes ?? [], [current]);

  // Processed tiles, if any: use the first layer's dates.
  const layerIds = useMemo(() => orderLayers(current?.layers), [current]);
  const tileLayer = layerIds.includes(layerPick) ? layerPick : (layerIds[0] ?? null);
  const tileEntries = useMemo(
    () => (current?.layers ?? []).filter((l) => l.layer === tileLayer).sort((a, b) => a.date.localeCompare(b.date)),
    [current, tileLayer],
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

  const fitJapan = useCallback(() => {
    mapRef.current?.fitBounds([[JAPAN_BBOX[0], JAPAN_BBOX[1]], [JAPAN_BBOX[2], JAPAN_BBOX[3]]], {
      padding: { top: 150, bottom: 110, left: wideScreen() ? 370 : 30, right: 70 },
      duration: 900,
    });
  }, []);

  // Japan highlight on for signed-out visitors, off once signed in.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (japan) {
      map.getSource("japan").setData(japan);
      map.getSource("japan-mask").setData(worldMask(japan));
    }
    const visibility = showJapan && japan ? "visible" : "none";
    for (const id of ["japan-mask", "japan-glow", "japan-line"]) map.setLayoutProperty(id, "visibility", visibility);
  }, [mapReady, japan, showJapan]);

  // Starting or leaving a replay swaps every scene on the map.
  useEffect(() => {
    setPlaced({});
    setFailed(0);
    setSelectedId(null);
  }, [replay]);

  // Step 4: outline the clicked area, or else the event's area, and frame what is on show.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const box = probe?.bbox ?? event?.bbox;
    map.getSource("aoi").setData({ type: "FeatureCollection", features: box ? [rectangle(box)] : [] });
  }, [mapReady, event, probe]);

  useEffect(() => {
    if (!mapReady) return;
    if (event) fitToData();
    else if (showJapan) fitJapan();
  }, [mapReady, event, showJapan, fitToData, fitJapan]);

  // A pin on the clicked spot.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (!probe) {
      markerRef.current?.remove();
      return;
    }
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: "#ffffff" });
    markerRef.current.setLngLat([probe.lng, probe.lat]).addTo(map);
  }, [mapReady, probe]);

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

  // Step 6: keep the map's image layers in step with the placed previews of the event on show.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const wanted = new Set(Object.keys(placed).filter((id) => previewScenes.some((s) => s.id === id)));
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
  }, [mapReady, placed, previewScenes]);

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

  // Clicking and hovering: a scene on the map opens its details; anywhere else either
  // queries that spot (signed in) or asks the visitor to sign in. Read through refs so the
  // map's listeners always see the latest state.
  useEffect(() => {
    const sceneAt = (lng, lat) =>
      mode === "previews" && currentDate
        ? previewScenes.find(
            (s) => day(s.acquiredAt) === currentDate && addedRef.current.has(s.id) && contains(s.bounds, lng, lat),
          ) ?? null
        : null;
    clickRef.current = ({ lng: rawLng, lat }, point) => {
      // With the outlook on, a shaded cell answers the click first.
      const cell = outlookOn && point ? mapRef.current?.queryRenderedFeatures(point, { layers: ["outlook-fill"] })[0] : null;
      if (cell) {
        setProbe(null);
        setCellId(cell.properties.id);
        setInfoOpen(true);
        return;
      }
      const lng = wrapLng(rawLng);
      const scene = sceneAt(lng, lat);
      if (scene) {
        setProbe(null);
        setSelectedId(scene.id);
      } else if (signedIn) {
        setProbe({ id: Date.now(), lng, lat, bbox: areaAround(lng, lat) });
      } else if (showJapan) {
        setPrompt(true);
      } else {
        return;
      }
      setInfoOpen(true);
    };
    hoverRef.current = ({ lng, lat }) => (sceneAt(wrapLng(lng), lat) ? "pointer" : signedIn ? "crosshair" : "");
  }, [mode, currentDate, previewScenes, placed, signedIn, showJapan, outlookOn]);

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

  // Start each catalog event at its newest acquisition; a replay starts at the first.
  useEffect(() => {
    setDateIndex(replay || autoplay ? 0 : Math.max(0, dates.length - 1));
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new set of dates restarts playback
  }, [dates]);

  // Play through the acquisitions, at the chosen speed; stop on the last one unless looping.
  useEffect(() => {
    if (!playing || dates.length < 2) return;
    const timer = setInterval(
      () => setDateIndex((i) => (i + 1 < dates.length ? i + 1 : loop ? 0 : i)),
      1500 / speed,
    );
    return () => clearInterval(timer);
  }, [playing, dates.length, speed, loop]);

  useEffect(() => {
    if (playing && !loop && dateIndex >= dates.length - 1) setPlaying(false);
  }, [playing, loop, dateIndex, dates.length]);

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (dateIndex >= dates.length - 1) setDateIndex(0); // play again from the start
    setPlaying(true);
  };

  // The outlook covers Japan for visitors; signed in, it covers the part of the map on screen (at most 60 degrees a side).
  const viewBox = () => {
    const map = mapRef.current;
    if (!map || showJapan) return JAPAN_BBOX;
    const bounds = map.getBounds();
    const centre = map.getCenter();
    const half = (span) => Math.min(30, Math.max(0.5, span / 2));
    const lng = wrapLng(centre.lng);
    const halfW = half(bounds.getEast() - bounds.getWest());
    const halfH = half(bounds.getNorth() - bounds.getSouth());
    return [
      Math.max(-180, lng - halfW),
      Math.max(-85, centre.lat - halfH),
      Math.min(180, lng + halfW),
      Math.min(85, centre.lat + halfH),
    ].map((v) => Number(v.toFixed(1)));
  };

  const toggleOutlook = () => {
    if (!outlookOn) {
      setOutlookBox(viewBox());
      setProbe(null);
      setInfoOpen(true);
    }
    setCellId(null);
    setOutlookOn((on) => !on);
  };

  // Fetch the outlook for the chosen region and horizon; a result for another request counts as loading.
  const outlookKey = outlookBox ? `${outlookBox.join(",")}:${horizon}` : "";
  useEffect(() => {
    if (!outlookOn || !outlookBox) return;
    let cancelled = false;
    api
      .outlook(outlookBox, horizon)
      .then((data) => !cancelled && setOutlook({ status: "done", data, key: outlookKey }))
      .catch((error) => !cancelled && setOutlook({ status: "error", message: error.message, key: outlookKey }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outlookKey stands for the box and the horizon
  }, [outlookOn, outlookKey]);
  const outlook = outlookRaw.key === outlookKey ? outlookRaw : OUTLOOK_LOADING;

  // Draw the cells; the chosen one gets a white outline.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const cells = outlookOn && outlook.status === "done" ? outlook.data.cells : [];
    map.getSource("outlook").setData({
      type: "FeatureCollection",
      features: cells.map((c) => ({ ...rectangle(c.bbox), properties: { id: c.id, probability: c.probability, selected: c.id === cellId } })),
    });
    for (const layer of ["outlook-fill", "outlook-line"]) map.setLayoutProperty(layer, "visibility", outlookOn ? "visible" : "none");
  }, [mapReady, outlookOn, outlook, cellId]);

  const selectCell = (id) => {
    setCellId(id);
    const cell = outlook.status === "done" ? outlook.data.cells.find((c) => c.id === id) : null;
    if (cell) {
      mapRef.current?.fitBounds([[cell.bbox[0], cell.bbox[1]], [cell.bbox[2], cell.bbox[3]]], {
        padding: { top: 170, bottom: 170, left: wideScreen() ? 370 : 40, right: 70 },
        duration: 600,
        maxZoom: 7,
      });
    }
  };

  // Choosing an event (from the picker, the list or a click result) leaves any area query.
  const openEvent = (id) => {
    setProbe(null);
    setPrompt(false);
    setReplay(null);
    setEventId(id);
  };

  // Replay scenes found by a search: leave the area query and play them from the first, once their previews have loaded.
  const startReplay = (next) => {
    setProbe(null);
    setPrompt(false);
    setReplay(next);
    setAutoplay(true);
    setInfoOpen(wideScreen());
  };

  // A new event was just started from a click result: add it to the list right away
  // (the catalog list is cached for a minute) and open it.
  const onTracked = (item) => {
    setEvents((list) => [item, ...(list ?? []).filter((e) => e.id !== item.id)]);
    openEvent(item.id);
  };

  const onDate = currentDate ? scenes.filter((s) => day(s.acquiredAt) === currentDate) : [];
  const selected = scenes.find((s) => s.id === selectedId) ?? null;
  const loadingPreviews =
    mode === "previews" && previewScenes.filter((s) => placed[s.id]).length + failed < previewScenes.length;

  // A replay (or deep link) starts by itself once there is something to play and its previews are in.
  useEffect(() => {
    if (autoplay && dates.length > 1 && !loadingPreviews) {
      setAutoplay(false);
      setDateIndex(0);
      setPlaying(true);
    }
  }, [autoplay, dates, loadingPreviews]);

  // Where the shown date sits against an earthquake, when the event is one.
  const eventDay = replay?.eventTime ? day(replay.eventTime) : quakeDay(event);
  const offset = eventDay && currentDate ? Math.round((Date.parse(currentDate) - Date.parse(eventDay)) / 86_400_000) : null;
  const relation =
    offset === null
      ? ""
      : offset === 0
        ? "the day of the earthquake"
        : `${plural(Math.abs(offset), "day")} ${offset < 0 ? "before" : "after"} the earthquake`;
  const lastIndex = Math.max(0, dates.length - 1);
  const japanOnly = showJapan && !event;
  const exploring = signedIn && probe;
  const headTitle = event ? event.name : japanOnly ? "Japan" : "NISAR data";
  const headSub = event
    ? `${plural(scenes.length, "scene")} · ${plural(dates.length, "date")}`
    : japanOnly
      ? "Showcase region"
      : signedIn
        ? "Click the map to explore"
        : "Loading…";

  return (
    <div className="sx">
      <div ref={containerRef} className="sx-map" />

      <div ref={toolbarRef} className="sx-nisar-top">
        <select
          className="sx-select sx-event-select"
          value={replay ? replay.id : activeId}
          onChange={(e) => openEvent(e.target.value)}
          disabled={!visibleEvents?.length && !replay}
          aria-label="Event"
        >
          {replay && <option value={replay.id}>Replay: {replay.name}</option>}
          {!visibleEvents && <option>Loading events…</option>}
          {visibleEvents?.length === 0 && <option>{signedIn ? "No events yet" : "No Japan events yet"}</option>}
          {visibleEvents?.map((e) => (
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
        <button
          className={`sx-fit${outlookOn ? " sx-fit-on" : ""}`}
          onClick={toggleOutlook}
          aria-pressed={outlookOn}
          title="Modeled chance of earthquakes in the coming days"
        >
          Outlook
        </button>
        {replay && (
          <button className="sx-fit" onClick={() => setReplay(null)} title="Leave the replay">
            Exit replay
          </button>
        )}
        {showJapan && event && (
          <button className="sx-fit" onClick={fitJapan} title="Back to all of Japan">
            All of Japan
          </button>
        )}
      </div>

      <aside className="sx-info">
        {exploring ? (
          <AreaExplorer
            key={probe.id}
            probe={probe}
            events={events}
            range={range}
            onRange={setRange}
            onClose={() => setProbe(null)}
            onOpenEvent={openEvent}
            onTracked={onTracked}
            onReplay={startReplay}
          />
        ) : outlookOn ? (
          <OutlookPanel
            state={outlook}
            horizon={horizon}
            onHorizon={setHorizon}
            selectedId={cellId}
            onSelect={selectCell}
            onClose={toggleOutlook}
            onUseView={
              signedIn
                ? () => {
                    setCellId(null);
                    setOutlookBox(viewBox());
                  }
                : null
            }
          />
        ) : (
          <>
            <button className="sx-info-head" onClick={() => setInfoOpen((o) => !o)} aria-expanded={infoOpen}>
              <span className="sx-info-title">{headTitle}</span>
              <span className="sx-info-sub">{headSub}</span>
              <span className="sx-chevron" aria-hidden="true">{infoOpen ? "▾" : "▸"}</span>
            </button>

            {infoOpen && (
              <div className="sx-info-body">
                {listError && <p className="sx-error">{listError}</p>}
                {detailError && <p className="sx-error">{detailError}</p>}

                {japanOnly && (
                  <>
                    <p className="sx-text">
                      Japan sits on the Pacific Ring of Fire: volcanoes, large earthquakes and heavy rain
                      reshape its ground every year. NISAR’s radar sees those changes through cloud and at night.
                    </p>
                    {visibleEvents?.length === 0 && (
                      <p className="sx-note">No NISAR events for Japan are catalogued yet.</p>
                    )}
                    {visibleEvents?.length > 0 && (
                      <ul className="sx-scenes">
                        {visibleEvents.map((e) => (
                          <li key={e.id}>
                            <button className="sx-scene" onClick={() => openEvent(e.id)}>
                              <strong>{e.name}</strong>
                              <span className="sx-scene-status">
                                {e.type} · {plural(e.sceneCount ?? 0, "scene")}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button className="sx-action" onClick={toggleOutlook}>
                      See the earthquake outlook
                    </button>{" "}
                    {onOpenSample && (
                      <button className="sx-action sx-action-quiet" onClick={onOpenSample}>
                        See the Mount Aso demo
                      </button>
                    )}
                  </>
                )}

                {event && (
                  <>
                    {replay && (
                      <p className="sx-note">
                        Replay of scenes found by your search, played from the first. Nothing is tracked or saved.
                      </p>
                    )}
                    {mode === "tiles" && (
                      <div className="sx-legend-box">
                        <p className="sx-note">
                          Showing <strong>{layerLabel(tileLayer)}</strong>
                          {tileEntries[0]?.units ? ` (${tileEntries[0].units})` : ""}, processed from the NISAR scene.
                        </p>
                        {LAYERS[tileLayer] && (
                          <>
                            <div className={`sx-layer-ramp sx-layer-ramp-${LAYERS[tileLayer].style}`} aria-hidden="true" />
                            <div className="sx-ramp-labels">
                              <span>{LAYERS[tileLayer].low}</span>
                              <span>{LAYERS[tileLayer].high}</span>
                            </div>
                            <p className="sx-note">{LAYERS[tileLayer].note}</p>
                          </>
                        )}
                      </div>
                    )}
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
                                <span className="sx-scene-status">{statusLabel(s.status)}</span>
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
                  </>
                )}

                {signedIn && !event && events?.length === 0 && (
                  <p className="sx-note">
                    The catalog has no events yet. Click anywhere on the map to see what NISAR has there and start tracking it.
                  </p>
                )}
                {signedIn && !event && events?.length > 0 && (
                  <p className="sx-note">Click anywhere on the map to see what NISAR and NASA have for that spot, or pick an event above.</p>
                )}
                {event && !replay && (
                  <Link to={`/events/${event.id}`} className="sx-action sx-action-quiet sx-action-small">
                    Photos, briefing and questions
                  </Link>
                )}
                {signedIn && event && (
                  <p className="sx-note">Click empty map to explore any other spot.</p>
                )}

                {showJapan && (
                  <div ref={ctaRef} className={`sx-cta${prompt ? " sx-cta-attn" : ""}`}>
                    <strong>{prompt ? "Sign in to explore that spot" : "Explore anywhere"}</strong>
                    <span>
                      Signed-in users can click any place on Earth to see its NISAR scenes, nearby earthquakes and
                      NASA data, and start tracking it.
                    </span>
                    <Link to="/signin" className="sx-action">Sign in</Link>
                  </div>
                )}
                <p className="sx-credit">
                  NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC. Country outline: Natural Earth.
                </p>
              </div>
            )}
          </>
        )}
      </aside>

      {event && (
        <div ref={controlsRef} className="sx-controls sx-controls-compact">
          <div className="sx-row">
            <button
              className="sx-play"
              onClick={togglePlay}
              disabled={dates.length < 2}
              aria-label={playing ? "Pause" : dateIndex >= lastIndex && dates.length > 1 ? "Play again from the start" : "Play"}
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
          {currentDate && dates.length > 1 && (
            <p className="sx-replay-note" aria-live="polite">
              Date {Math.min(dateIndex, lastIndex) + 1} of {dates.length}
              {relation && ` · ${relation}`}
            </p>
          )}
          <div className="sx-row sx-wrap">
            <label className="sx-inline sx-grow sx-opacity">
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
            {layerIds.length > 1 && mode === "tiles" && (
              <label className="sx-inline">
                Layer
                <select className="sx-select sx-speed" value={tileLayer ?? ""} onChange={(e) => setLayerPick(e.target.value)}>
                  {layerIds.map((id) => (
                    <option key={id} value={id}>
                      {layerLabel(id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="sx-inline">
              Speed
              <select className="sx-select sx-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </label>
            <label className="sx-inline">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              Loop
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default NisarMap;
