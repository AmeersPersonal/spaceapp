import { useEffect, useState } from "react";
import { api } from "./api.js";
import DateRange from "./DateRange.jsx";
import { MAX_SEARCH_DAYS, contains, formatCoords } from "./explore.js";

// What the system finds for a spot the signed-in user clicked: NISAR scenes over it,
// catalog events that cover it, recent earthquakes nearby and other NASA datasets.
// Everything is queried live for a 1-degree box around the click, over the chosen period
// (the last 6 months until the user picks another). Scenes found, and each quake, can also be
// replayed on the map without tracking anything.

const DATASET_NAMES = {
  gpm: "Rainfall (GPM IMERG)",
  smap: "Soil moisture (SMAP)",
  hls: "Optical imagery (Landsat/Sentinel-2)",
  terrain: "Terrain (NASADEM)",
  grace: "Water storage (GRACE)",
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const pending = { status: "loading" };

/** Run one query and keep its outcome (data or message) next to its status. */
function track(promise, set, isCurrent) {
  promise
    .then((data) => isCurrent() && set({ status: "done", data }))
    .catch((error) => isCurrent() && set({ status: "error", message: error.message }));
}

function AreaExplorer({ probe, events, range, onRange, onClose, onOpenEvent, onTracked, onReplay }) {
  // Each result remembers the period it was fetched for; one for another period counts as still loading.
  const [nisarRaw, setNisar] = useState(pending);
  const [quakesRaw, setQuakes] = useState(pending);
  const [contextRaw, setContext] = useState(pending);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [noticeRaw, setNotice] = useState(null);

  const { bbox } = probe;
  const { start, end } = range;
  const period = `${start}..${end}`;
  const fresh = (r) => (r.period === period ? r : pending);
  const nisar = fresh(nisarRaw);
  const quakes = fresh(quakesRaw);
  const context = fresh(contextRaw);
  const notice = noticeRaw?.period === period ? noticeRaw.text : "";

  // The parent remounts this panel (key) for every new click, so state starts fresh;
  // picking another period runs the three queries again for the same spot.
  useEffect(() => {
    let current = true;
    const isCurrent = () => current;
    const tag = (set) => (result) => set({ ...result, period });
    track(api.nisarSearch(bbox, start, end), tag(setNisar), isCurrent);
    track(api.quakes(bbox, start, end), tag(setQuakes), isCurrent);
    track(api.datasetContext(bbox, start, end), tag(setContext), isCurrent);
    return () => {
      current = false;
    };
  }, [bbox, start, end, period]);

  const here = (events ?? []).filter((e) => contains(e.bbox, probe.lng, probe.lat));

  const failWith = (error) =>
    setActionError(error.status === 401 ? "Your session has ended. Sign in again to track places." : error.message);

  const trackArea = async () => {
    setBusy("area");
    setActionError("");
    try {
      const name = `Area near ${formatCoords(probe.lng, probe.lat)}`;
      const out = await api.trackArea({ aoi: bbox, dateRange: { start, end }, name, type: "other" });
      onTracked({ id: out.eventId, name, type: "other", bbox, sceneCount: 0 });
    } catch (error) {
      failWith(error);
    } finally {
      setBusy("");
    }
  };

  const trackQuake = async (quake) => {
    setBusy(quake.sourceId);
    setActionError("");
    try {
      const out = await api.trackQuake(quake.sourceId);
      const aoi = quake.suggested?.aoi;
      onTracked({
        id: out.eventId,
        name: quake.title,
        type: "earthquake",
        bbox: Array.isArray(aoi) && aoi.length === 4 ? aoi : null,
        sceneCount: 0,
      });
    } catch (error) {
      failWith(error);
    } finally {
      setBusy("");
    }
  };

  const withPreview = (scenes) => scenes.filter((s) => s.browseUrl && s.bounds);

  // Replay what the search found for this spot.
  const replayArea = () => {
    const scenes = withPreview(nisarData.scenes);
    if (scenes.length === 0) {
      setNotice({ period, text: "None of these scenes has a preview image to replay." });
      return;
    }
    onReplay({
      id: `replay-area-${probe.id}`,
      name: `Area near ${formatCoords(probe.lng, probe.lat)}`,
      bbox,
      scenes,
    });
  };

  // Replay a past earthquake: NISAR scenes from 36 days before it to 60 days after (the suggested ingest window).
  const replayQuake = async (quake) => {
    const key = `replay-${quake.sourceId}`;
    setBusy(key);
    setActionError("");
    setNotice(null);
    try {
      const { aoi, dateRange } = quake.suggested;
      const found = await api.nisarSearch(aoi, dateRange.start, dateRange.end);
      const scenes = withPreview(found.scenes);
      if (scenes.length === 0) {
        setNotice({ period, text: `NISAR has no previewable scenes for M ${quake.magnitude.toFixed(1)} (${shortDate(quake.time)}) yet.` });
        return;
      }
      onReplay({ id: key, name: quake.title, bbox: aoi, scenes, eventTime: quake.time });
    } catch (error) {
      setActionError(error.message);
    } finally {
      setBusy("");
    }
  };

  const nisarData = nisar.status === "done" ? nisar.data : null;
  const quakeList = quakes.status === "done" ? [...quakes.data.earthquakes].sort((a, b) => b.magnitude - a.magnitude).slice(0, 3) : [];

  return (
    <>
      <div className="sx-info-head sx-info-head-static">
        <span className="sx-info-title">Selected area</span>
        <span className="sx-info-sub">{formatCoords(probe.lng, probe.lat)} · about 1° across</span>
        <button className="sx-close-x" onClick={onClose} aria-label="Close area details">×</button>
      </div>

      <div className="sx-info-body">
        <h3 className="sx-info-h">Period to search</h3>
        <DateRange value={range} onChange={onRange} maxSpan={MAX_SEARCH_DAYS} />
        <h3 className="sx-info-h">NISAR coverage, {shortDate(start)} – {shortDate(end)}</h3>
        {nisar.status === "loading" && <p className="sx-note">Searching…</p>}
        {nisar.status === "error" && <p className="sx-error">{nisar.message}</p>}
        {nisarData && (
          <>
            <p className="sx-text">
              {nisarData.count === 0
                ? "No NISAR scene covers this spot in that period."
                : `${plural(nisarData.count, "scene")}${nisarData.truncated ? " (first results)" : ""} on ${plural(nisarData.dates.length, "date")}, latest ${shortDate(nisarData.dates.at(-1))}.`}
            </p>
            {nisarData.count > 0 && (
              <p className="sx-note">
                {Object.entries(nisarData.byProduct).map(([p, n]) => `${p} ${n}`).join(" · ")}
                {nisarData.polarizations.length > 0 && ` · ${nisarData.polarizations.join("/")}`}
              </p>
            )}
            <button
              className="sx-action"
              onClick={trackArea}
              disabled={nisarData.count === 0 || busy !== ""}
            >
              {busy === "area" ? "Starting…" : "Track this area"}
            </button>{" "}
            <button
              className="sx-action sx-action-quiet"
              onClick={replayArea}
              disabled={withPreview(nisarData.scenes).length === 0 || busy !== ""}
            >
              ▶ Replay these scenes
            </button>
          </>
        )}

        {here.length > 0 && (
          <>
            <h3 className="sx-info-h">Events in this area</h3>
            <ul className="sx-scenes">
              {here.map((e) => (
                <li key={e.id}>
                  <button className="sx-scene" onClick={() => onOpenEvent(e.id)}>
                    <strong>{e.name}</strong>
                    <span className="sx-scene-status">
                      {e.type} · {plural(e.sceneCount ?? 0, "scene")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="sx-info-h">Earthquakes nearby (M4.5+) in this period</h3>
        {quakes.status === "loading" && <p className="sx-note">Searching…</p>}
        {quakes.status === "error" && <p className="sx-error">{quakes.message}</p>}
        {quakes.status === "done" && quakeList.length === 0 && <p className="sx-note">None found.</p>}
        {quakeList.length > 0 && (
          <ul className="sx-scenes">
            {quakeList.map((q) => (
              <li key={q.sourceId}>
                <button
                  className="sx-scene"
                  onClick={() => (q.registered ? onOpenEvent(q.suggested.eventId) : trackQuake(q))}
                  disabled={busy !== ""}
                >
                  <strong>M {q.magnitude.toFixed(1)}</strong> · {q.place ?? q.title}
                  <span className="sx-scene-status">
                    {shortDate(q.time)} · {busy === q.sourceId ? "starting…" : q.registered ? "tracked, open it" : "click to track"}
                  </span>
                </button>
                <button
                  className="sx-action sx-action-quiet sx-action-small"
                  onClick={() => replayQuake(q)}
                  disabled={busy !== ""}
                >
                  {busy === `replay-${q.sourceId}` ? "Finding scenes…" : "▶ Replay this quake"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3 className="sx-info-h">Other NASA data</h3>
        {context.status === "loading" && <p className="sx-note">Searching…</p>}
        {context.status === "error" && <p className="sx-error">{context.message}</p>}
        {context.status === "done" && (
          <ul className="sx-sources">
            {Object.entries(context.data.results).map(([source, r]) => (
              <li key={source}>
                <span>{DATASET_NAMES[source] ?? source}</span>
                <span className="sx-scene-status">
                  {r.ok ? `${r.result.total ?? r.result.count} records` : "unavailable"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {context.status === "done" && (
          <p className="sx-note">Most of these are catalog records showing what data exists, not measurements.</p>
        )}

        {notice && <p className="sx-note">{notice}</p>}
        {actionError && <p className="sx-error">{actionError}</p>}
        <p className="sx-credit">NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC. Earthquakes: USGS.</p>
      </div>
    </>
  );
}

export default AreaExplorer;
