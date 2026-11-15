# migrations

## Purpose
The D1 schema for the Earth Replay catalog: events (areas of interest), NISAR scenes, processed tile layers, ingest runs, AI captions, Auth0-owned chats and specialist conversations.

## Contents
| File | Description |
|---|---|
| `0001_init.sql` | Creates the `events`, `scenes`, `layers`, `ingests` and `captions` tables and their indexes. |
| `0002_chats.sql` | Creates Auth0-owned `chats` and ordered `chat_messages`, with ownership/order indexes, validation constraints and cascading message deletion. |
| `0002_chat_stats.sql` | Adds `scenes.stats` and the `conversations` and `messages` tables. |
| `0004_scene_bounds.sql` | Adds `scenes.bounds`, the footprint bounding box used to place ASF browse images on the map. |
| `0003_event_context.sql` | Creates `event_context`, the stored supplementary NASA dataset results per event and source. |

## Interfaces
- `events(id PK, name, type, description, aoi_wkt, bbox JSON, products JSON, start_date, end_date, watch, last_polled_at, created_at)`
- `scenes(id PK = ASF sceneName, event_id, product, acquired_at, acquired_end, polarizations JSON, flight_direction, path_number, frame_number, production_config, url, browse_url, status, error, ingest_id, source, created_at, updated_at)`. `status` is one of queued, processing, awaiting_processor, ready or failed.
- `layers(event_id, layer, date, scene_id, min_zoom, max_zoom, bounds JSON, units)` with PK `(event_id, layer, date)`.
- `ingests(id PK, event_id, date_start, date_end, trigger, status, scene_count, error, created_at, updated_at)`
- `captions(id PK, event_id, scene_id, text, model, created_at)`
- `chats(id PK, user_id Auth0 sub, event_id nullable FK, title, created_at, updated_at)`
- `chat_messages(sequence INTEGER PK AUTOINCREMENT, id UNIQUE, chat_id FK ON DELETE CASCADE, role user|assistant, content, metadata JSON, created_at)`
- `event_context(event_id FK, source, window_start, window_end, ok, result JSON, error, fetched_at)` with PK `(event_id, source)`. `result` is the bounded `fetchDataset()` output (a few records); a good result is never overwritten by a later failure.
- `scenes.bounds` JSON `[west,south,east,north]` of the ASF footprint, or null. Re-discovering a scene fills it in; a null never erases a stored value.
- `scenes.stats` JSON: the processor's `manifest.stats`, used by the forecast.
- `conversations(id PK 'conv_...', event_id, created_at, updated_at)`
- `messages(id PK autoincrement, conversation_id, role user|assistant|consult, agent, model, content, created_at)`
- Apply with `npm run db:migrate:local` or `npm run db:migrate:remote`. Tests apply the migrations automatically through `tests/setup.js`.

## Dependencies
D1 binding `DB` (database `earth-replay`). Queried by `../dataManger.js` and `../chats.js`.

## Tests
Every integration test in `../tests/` runs against this schema, since `applyD1Migrations` runs in the test setup.

## Status
Both `0002_chats.sql` (owned chats) and `0002_chat_stats.sql` (specialist threads and scene stats) applied successfully to production D1 on 2026-11-14. The remote ledger and schema were inspected first: only `0001_init.sql` was previously applied. Existing catalog data was preserved.

## Changelog
- 2026-11-14 - Added `0004_scene_bounds.sql` (`scenes.bounds`). Applied by the test setup; not yet applied to production D1.
- 2026-11-14 - Added `0003_event_context.sql` (`event_context`). Applied locally by the test setup; not yet applied to production D1 (`npm run db:migrate:remote`).
- 2026-11-14 - Inspected production schema and applied both pending chat migrations with Wrangler.
- 2026-11-14 - Resolved main/Auth0 merge while preserving owned chats and specialist conversations; combined suite passes 203 tests in 14 files.
- 2026-11-14 - Reconciled merged specifications and distinguished prior verification from pending merged-source and browser E2E checks.
- 2026-11-14 - Added persistent owner-scoped chats and messages, indexed for listing/history pagination; local migration verified.
- 2026-11-14 - Added 0002 (scene stats, conversations, messages).
- 2026-11-14 - Initial schema.
