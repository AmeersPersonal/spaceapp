# migrations

## Purpose
The D1 schema for the Earth Replay catalog: events (areas of interest), NISAR scenes, processed tile layers, ingest runs and AI captions.

## Contents
| File | Description |
|---|---|
| `0001_init.sql` | Creates the `events`, `scenes`, `layers`, `ingests` and `captions` tables and their indexes. |
| `0002_chats.sql` | Creates Auth0-owned `chats` and ordered `chat_messages`, with ownership/order indexes, validation constraints and cascading message deletion. |

## Interfaces
- `events(id PK, name, type, description, aoi_wkt, bbox JSON, products JSON, start_date, end_date, watch, last_polled_at, created_at)`
- `scenes(id PK = ASF sceneName, event_id, product, acquired_at, acquired_end, polarizations JSON, flight_direction, path_number, frame_number, production_config, url, browse_url, status, error, ingest_id, source, created_at, updated_at)`. `status` is one of queued, processing, awaiting_processor, ready or failed.
- `layers(event_id, layer, date, scene_id, min_zoom, max_zoom, bounds JSON, units)` with PK `(event_id, layer, date)`.
- `ingests(id PK, event_id, date_start, date_end, trigger, status, scene_count, error, created_at, updated_at)`
- `captions(id PK, event_id, scene_id, text, model, created_at)`
- `chats(id PK, user_id Auth0 sub, event_id nullable FK, title, created_at, updated_at)`
- `chat_messages(sequence INTEGER PK AUTOINCREMENT, id UNIQUE, chat_id FK ON DELETE CASCADE, role user|assistant, content, metadata JSON, created_at)`
- Apply with `npm run db:migrate:local` or `npm run db:migrate:remote`. Tests apply the migrations automatically through `tests/setup.js`.

## Dependencies
D1 binding `DB` (database `earth-replay`). Queried by `../dataManger.js`.

## Tests
Every integration test in `../tests/` runs against this schema, since `applyD1Migrations` runs in the test setup.

## Status
Done. Migration 0002 applied locally; production application remains pending.

## Changelog
- 2026-11-14 - Added persistent owner-scoped chats and messages, indexed for listing/history pagination; local migration verified.
- 2026-11-14 - Initial schema.
