# tests

## Purpose
Vitest suites for the Cloudflare Worker. They run inside workerd through `@cloudflare/vitest-plugin`, using local D1, R2, KV, Queues, Durable Objects and Workflows.

## Contents
| File | Description |
|---|---|
| `setup.js` | Applies the D1 migrations before the suites run. |
| `helpers.js` | Fake Workers AI and Vectorize, `testEnv()`, `resetDb()` (clears D1, KV and R2), and seed helpers. |
| `api.test.js` | Every HTTP route: events, event detail, tiles (304/404/400), ingest create/status/validation/auth, ask (cache/400/404/502), root. |
| `ingest.test.js` | AOI and ingest validation, `IngestWorkflow` happy path and ASF failure, failure to create the workflow, queue consumer (dispatch, retry backoff, 4xx, manifest→ready+caption, idempotency, invalid manifests), DLQ, cron. |
| `replay.test.js` | `ReplayRoom` over real WebSockets: join state, presence, broadcast, errors, sync/ping, persistence, room isolation, cleanup alarm. |
| `events.test.js` | USGS parsing/fetching, quake→ingest request, NISAR preview, Google geocoding (incl. key never leaked), event/batch/queue handlers, and the four discovery routes. |
| `datasets.test.js` | Seven NASA source adapters, query validation, CMR pagination, FIRMS CSV parsing and key handling, GEOS initialization/valid-time filtering, response limits, partial context, generic event integration and API routes. Provider calls are mocked. |
| `ai.test.js` | AI Gateway wrapper and AIManger: captions, search, answers and failure paths. |
| `asf.test.js` | ASF URL building, normalizing the recorded NISAR response, and upstream error classification. |
| `oAuth.test.js` | JWT expiry, Earthdata headers, the ingest key middleware and constant-time compare. |
| `sessionManger.test.js` | Room codes, the replay reducer and message parsing. |
| `fixtures/` | Recorded ASF and USGS responses. See [fixtures/SPEC.md](fixtures/SPEC.md). |

## Interfaces
Run `npm test` from `backend/cloudefare/`. The vitest config forces `EARTHDATA_TOKEN`, `INGEST_API_KEY` and `PROCESSOR_URL` to be empty and points `ASF_SEARCH_URL` at `asf.test`, so no test can reach a real service.

## Dependencies
`../vitest.config.js`, `../wrangler.jsonc` and `../migrations/`.

## Tests
On 2026-11-14 all 132 tests passed in 9 files. Known gaps:
- The `getQueueResult()` helper does not record `delaySeconds`, so the backoff check spies on `msg.retry`.
- `mockStepError` makes the Workflows engine log "uncaught exception" lines. This is expected.
- Real Workers AI, Vectorize and R2 notification delivery are untested.

## Status
Done.

## Changelog
- 2026-11-14 - Removed the unshipped processor bridge test file at user request.
- 2026-11-14 - Explicitly blank FIRMS and Google keys in the test environment after local credentials caused two missing-key tests to call real providers and fail.
- 2026-11-14 - Added supplementary NASA adapter and route tests; live checks are separate from automated suites and recorded in ../DATASET_ACCESS.md.
- 2026-11-14 - Added events.test.js (35 tests).
- 2026-11-14 - Initial suites for all Worker features.
