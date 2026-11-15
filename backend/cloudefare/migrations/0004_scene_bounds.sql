-- Footprint bounding box of each NISAR scene, so the frontend can place ASF browse images on the map
-- before any tiles are processed. JSON [west, south, east, north]; null when ASF sent no geometry.
-- Scenes ingested earlier get it the next time an ingest or the watch poll re-discovers them.

ALTER TABLE scenes ADD COLUMN bounds TEXT;
