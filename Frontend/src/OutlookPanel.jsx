// The earthquake outlook shown in the map's card: where earthquakes were frequent in the past
// year, the chance that implies for the coming days, and AI-worded scenarios for the busiest
// cells. Everything here is modeled (see backend outlook.js) and is labeled that way.

const HORIZONS = [7, 30, 90];
// Never "0%" or "100%": the model cannot be that sure.
const percent = (p) => (p < 0.01 ? "<1%" : p > 0.99 ? ">99%" : `${Math.round(p * 100)}%`);
const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function OutlookPanel({ state, horizon, onHorizon, selectedId, onSelect, onClose, onUseView }) {
  const data = state.status === "done" ? state.data : null;
  const selected = data?.cells.find((c) => c.id === selectedId) ?? null;

  return (
    <>
      <div className="sx-info-head sx-info-head-static">
        <span className="sx-info-title">Earthquake outlook</span>
        <span className="sx-info-sub">
          Modeled, not observed{data ? ` · ${shortDate(data.window.start)} – ${shortDate(data.window.end)}` : ""}
        </span>
        <button className="sx-close-x" onClick={onClose} aria-label="Close the outlook">×</button>
      </div>

      <div className="sx-info-body">
        <div className="dr-chips sx-outlook-chips" role="group" aria-label="How far ahead">
          {HORIZONS.map((days) => (
            <button
              key={days}
              type="button"
              className={`dr-chip${days === horizon ? " dr-chip-on" : ""}`}
              aria-pressed={days === horizon}
              onClick={() => onHorizon(days)}
            >
              Next {days} days
            </button>
          ))}
        </div>
        {onUseView && (
          <button className="sx-action sx-action-quiet sx-action-small" onClick={onUseView}>
            Use the current map view
          </button>
        )}

        {state.status === "loading" && <p className="sx-note">Working out the outlook…</p>}
        {state.status === "error" && <p className="sx-error">{state.message}</p>}

        {data && (
          <>
            <div className="sx-outlook-legend" aria-hidden="true">
              <div className="sx-outlook-ramp" />
              <div className="sx-ramp-labels">
                <span>lower chance</span>
                <span>higher chance</span>
              </div>
            </div>
            <p className="sx-note">
              Each shaded square shows the chance of at least one M{data.basis.minMagnitude}+ earthquake there in the
              next {data.horizonDays} days, from {data.basis.count} earthquakes in the past {data.basis.lookbackDays} days.
            </p>

            {data.cells.length === 0 && (
              <p className="sx-text">No M{data.basis.minMagnitude}+ earthquakes were recorded here in the past year, so there is nothing to project.</p>
            )}

            {selected && (
              <div className="sx-cta sx-cta-attn">
                <strong>{selected.label}</strong>
                <span>
                  {percent(selected.probability)} chance of an M{data.basis.minMagnitude}+ earthquake · {percent(selected.probabilityM6)} for M6+
                </span>
                <span>
                  {selected.count} in the past year, largest M{selected.maxMagnitude.toFixed(1)}; latest M
                  {selected.latest.magnitude.toFixed(1)} on {shortDate(selected.latest.time.slice(0, 10))}.
                </span>
              </div>
            )}

            {data.scenarios.length > 0 && (
              <>
                <h3 className="sx-info-h">Possible future events</h3>
                <ul className="sx-scenes">
                  {data.scenarios.map((s) => (
                    <li key={s.id}>
                      <button
                        className={`sx-scene${s.cellId === selectedId ? " sx-scene-active" : ""}`}
                        onClick={() => onSelect(s.cellId)}
                      >
                        <span className={`sx-pill sx-pill-${s.likelihood === "elevated" ? "high" : s.likelihood === "moderate" ? "medium" : "low"}`}>
                          {s.likelihood} · {percent(s.probability)}
                        </span>{" "}
                        <strong>{s.title}</strong>
                        <span className="sx-scenario-text">{s.summary}</span>
                        <span className="sx-scene-status">
                          {s.aiGenerated ? "AI-generated scenario" : "Computed summary"} · {s.basis}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {data.cells.length > 0 && (
              <>
                <h3 className="sx-info-h">Most active areas</h3>
                <ul className="sx-sources">
                  {data.cells.slice(0, 8).map((c) => (
                    <li key={c.id}>
                      <button className="sx-outlook-row" onClick={() => onSelect(c.id)}>
                        <span>{c.label}</span>
                        <strong>{percent(c.probability)}</strong>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <p className="sx-credit">{data.disclaimer}</p>
            <p className="sx-credit">Method: {data.method} Earthquake catalog: USGS.</p>
          </>
        )}
      </div>
    </>
  );
}

export default OutlookPanel;
