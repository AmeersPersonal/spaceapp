-- Supplementary NASA dataset results (GPM, SMAP, HLS, terrain, GRACE, FIRMS) fetched for an event's
-- area and stored so the API and AI prompts reuse them instead of querying providers every time.
-- One row per (event, source): the latest successful result, or the latest failure if none succeeded.

CREATE TABLE IF NOT EXISTS event_context (
  event_id TEXT NOT NULL REFERENCES events(id),
  source TEXT NOT NULL,            -- gpm | smap | hls | terrain | grace | firms
  window_start TEXT NOT NULL,      -- YYYY-MM-DD queried range
  window_end TEXT NOT NULL,
  ok INTEGER NOT NULL,             -- 1 = result holds provider data, 0 = error holds the reason
  result TEXT,                     -- JSON fetchDataset() result (bounded: a few records)
  error TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (event_id, source)
);
