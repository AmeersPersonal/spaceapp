-- Earth Replay catalog: events (areas of interest), NISAR scenes, processed tile layers,
-- ingest runs and AI captions.

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  description TEXT,
  aoi_wkt TEXT NOT NULL,
  bbox TEXT NOT NULL,              -- JSON [west, south, east, north]
  products TEXT NOT NULL,          -- JSON array of NISAR processing levels, e.g. ["GCOV"]
  start_date TEXT,
  end_date TEXT,
  watch INTEGER NOT NULL DEFAULT 0, -- 1 = cron polls ASF for new scenes
  last_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,             -- ASF sceneName (granule ID)
  event_id TEXT NOT NULL REFERENCES events(id),
  product TEXT NOT NULL,           -- GCOV | GUNW | GOFF | SME2
  acquired_at TEXT NOT NULL,
  acquired_end TEXT,
  polarizations TEXT NOT NULL DEFAULT '[]',
  flight_direction TEXT,
  path_number INTEGER,
  frame_number INTEGER,
  production_config TEXT,          -- ASF productionConfiguration, e.g. UR / PR
  url TEXT NOT NULL,
  browse_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | processing | awaiting_processor | ready | failed
  error TEXT,
  ingest_id TEXT,
  source TEXT NOT NULL DEFAULT 'ASF DAAC',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_scenes_event ON scenes(event_id, acquired_at);
CREATE INDEX IF NOT EXISTS idx_scenes_ingest ON scenes(ingest_id);

CREATE TABLE IF NOT EXISTS layers (
  event_id TEXT NOT NULL REFERENCES events(id),
  layer TEXT NOT NULL,             -- e.g. hh-backscatter, unwrapped-phase, soil-moisture
  date TEXT NOT NULL,              -- YYYY-MM-DD
  scene_id TEXT NOT NULL,
  min_zoom INTEGER NOT NULL DEFAULT 0,
  max_zoom INTEGER NOT NULL DEFAULT 12,
  bounds TEXT,                     -- JSON [west, south, east, north]
  units TEXT,
  PRIMARY KEY (event_id, layer, date)
);

CREATE TABLE IF NOT EXISTS ingests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'api', -- api | cron
  status TEXT NOT NULL DEFAULT 'queued', -- queued | searching | dispatched | complete | failed
  scene_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS captions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  scene_id TEXT,
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_captions_event ON captions(event_id);
