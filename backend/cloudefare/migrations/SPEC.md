# migrations

## Purpose
The D1 schema for the Earth Replay catalog: events (areas of interest), NISAR scenes, processed tile layers, ingest runs, AI captions, Auth0-owned chats and specialist conversations.

## Contents
| File | Description |
|---|---|
| `0001_init.sql` | Creates the `events`, `scenes`, `layers`, `ingests` and `captions` tables and their indexes. |
| `0002_chats.sql` | Creates Auth0-owned `chats` and ordered `chat_messages`, with ownership/order indexes, validation constraints and cascading message deletion. |
| `0002_chat_stats.sql` | Adds `scenes.stats` and the `conversations` and `messages` tables. |

## Interfaces
- `events(id PK, name, type, description, aoi_wkt, bbox JSON, products JSON, start_date, end_date, watch, last_polled_at, created_at)`
- `scenes(id PK = ASF sceneName, event_id, product, acquired_at, acquired_end, polarizations JSON, flight_direction, path_number, frame_number, production_config, url, browse_url, status, error, ingest_id, source, created_at, updated_at)`. `status` is one of queued, processing, awaiting_processor, ready or failed.
- `layers(event_id, layer, date, scene_id, min_zoom, max_zoom, bounds JSON, units)` with PK `(event_id, layer, date)`.
- `ingests(id PK, event_id, date_start, date_end, trigger, status, scene_count, error, created_at, updated_at)`
- `captions(id PK, event_id, scene_id, text, model, created_at)`
- `chats(id PK, user_id Auth0 sub, event_id nullable FK, title, created_at, updated_at)`
- `chat_messages(sequence INTEGER PK AUTOINCREMENT, id UNIQUE, chat_id FK ON DELETE CASCADE, role user|assistant, content, metadata JSON, created_at)`
- `scenes.stats` JSON: the processor's `manifest.stats`, used by the forecast.
- `conversations(id PK 'conv_...', event_id, created_at, updated_at)`
- `messages(id PK autoincrement, conversation_id, role user|assistant|consult, agent, model, content, created_at)`
- Apply with `npm run db:migrate:local` or `npm run db:migrate:remote`. Tests apply the migrations automatically through `tests/setup.js`.

## Dependencies
D1 binding `DB` (database `earth-replay`). Queried by `../dataManger.js` and `../chats.js`.

## Tests
Every integration test in `../tests/` runs against this schema, since `applyD1Migrations` runs in the test setup.

## Status
Both `0002_chats.sql` (owned chats) and `0002_chat_stats.sql` (specialist threads and scene stats) are present with distinct filenames. The owned-chat migration was previously applied locally. Application of the specialist migration to this local database and the production migration state were not checked in this update. Inspect the migration ledger before rollout; no remote migration was performed here.

## Changelog
- 2026-11-14 - Resolved main/Auth0 merge while preserving owned chats and specialist conversations; combined suite passes 203 tests in 14 files.
- 2026-11-14 - Reconciled merged specifications and distinguished prior verification from pending merged-source and browser E2E checks.
- 2026-11-14 - Added persistent owner-scoped chats and messages, indexed for listing/history pagination; local migration verified.
- 2026-11-14 - Added 0002 (scene stats, conversations, messages).
- 2026-11-14 - Initial schema.
