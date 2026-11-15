# tests

## Purpose
Vitest suites for the Cloudflare Worker. They run inside workerd through `@cloudflare/vitest-plugin`, using local D1, R2, KV, Queues, Durable Objects and Workflows.

## Contents
| File | Description |
|---|---|
| `setup.js` | Applies the D1 migrations before the suites run. |
| `auth0.test.js` | Auth0 login/callback/logout/profile, signed-token callback exchange, real encrypted cookies, missing/forged/expired sessions, fail-closed configuration, CORS, CSRF and protected write routes. |
| `auth0-helpers.js` | Test-only Auth0 configuration and encrypted session-cookie fixtures using the official server SDK. |
| `chats.test.js` | Persistent chats/messages, new login retrieval, owner isolation, bounds, pagination, role spoofing, authenticated AI history/cache bypass, failure and atomic rollback. |
| `helpers.js` | Fake Workers AI and Vectorize, `testEnv()`, `resetDb()` (clears D1, KV and R2), and seed helpers. |
| `api.test.js` | Every HTTP route: events, event detail, tiles (304/404/400), ingest create/status/validation/auth, ask (cache/400/404/502), root. |
| `ingest.test.js` | AOI and ingest validation, `IngestWorkflow` happy path and ASF failure, failure to create the workflow, queue consumer (dispatch, retry backoff, 4xx, manifest→ready+caption, idempotency, invalid manifests), DLQ, cron. |
| `main.test.js` | `backend/main.js` re-exports the Worker handlers, `IngestWorkflow` and `ReplayRoom`. |
| `replay.test.js` | `ReplayRoom` over real WebSockets: join state, presence, broadcast, errors, sync/ping, persistence, room isolation, cleanup alarm. |
| `events.test.js` | USGS parsing/fetching, quake→ingest request, NISAR preview, Google geocoding (incl. key never leaked), event/batch/queue handlers, and the four discovery routes. |
| `agents.test.js` | Agent routing and models, chat (consults, shared thread, failure and foreign-conversation paths), summary, forecast math, scene stats, and the `/api/agents`, `/api/chat`, summary and predict routes. |
| `routing.test.js` | Per-use-case model chains, outside-provider calls through the AI Gateway (mocked fetch), fallback on errors/empty answers/missing keys, reasoning settings. |
| `datasets.test.js` | Seven NASA source adapters, query validation, CMR pagination, FIRMS CSV parsing and key handling, GEOS initialization/valid-time filtering, response limits, partial context, generic event integration and API routes. Provider calls are mocked. |
| `eventContext.test.js` | Context window, refresh/store (partial failures, FIRMS key and five-day window, good data kept over failures), freshness and throttling, `EVENT_CONTEXT=off`, prompt compaction, prompt/cache-key inclusion, `GET /api/events/:id/context`, and ask using stored context. Providers are mocked. |
| `sceneBounds.test.js` | Footprint bounding boxes from ASF geometry (including missing/invalid/antimeridian), storage on ingest, backfill on re-discovery, and `scenes[].bounds` in `GET /api/events/:id`. |
| `ai.test.js` | AI Gateway wrapper and AIManger: captions, search, answers and failure paths. |
| `asf.test.js` | ASF URL building, normalizing the recorded NISAR response, and upstream error classification. |
| `oAuth.test.js` | JWT expiry, Earthdata headers, the ingest key middleware and constant-time compare. |
| `sessionManger.test.js` | Room codes, the replay reducer and message parsing. |
| `fixtures/` | Recorded ASF and USGS responses. See [fixtures/SPEC.md](fixtures/SPEC.md). |

## Interfaces
Run `npm test` from `backend/cloudefare/`. The vitest config blanks local service credentials and all Auth0 bindings. `testEnv()` provides test-only Auth0 configuration, and write-route tests attach genuine encrypted session fixtures. Auth0 discovery/token/JWKS calls are mocked. `ASF_SEARCH_URL` points at `asf.test`; tests do not use live provider credentials.

## Dependencies
`../vitest.config.js`, `../wrangler.jsonc` and `../migrations/`.

## Tests
The merged suite passed 203 tests across 14 files on 2026-11-14. It covers both storage schemas and private cache bypass across provider fallback. Known gaps:
- The `getQueueResult()` helper does not record `delaySeconds`, so the backoff check spies on `msg.retry`.
- `mockStepError` makes the Workflows engine log "uncaught exception" lines. This is expected.
- Automated tests mock Workers AI, Vectorize and external providers; historical live checks are separate evidence.
- A separate live browser check passed real Auth0 login, two owned conversations, confirmed logout, rejected protected access, re-login, exact history restoration and continued generation. This is deployment evidence, not part of the mocked automated suite; see [../DEPLOYMENT_VERIFICATION.md](../DEPLOYMENT_VERIFICATION.md).

## Status
Merge resolved; all 203 automated tests pass. `resetDb()` clears `chat_messages`/`chats` and `messages`/`conversations` before parent catalog tables. The deployed Worker browser E2E also passed; frontend integration remains separate.

## Changelog
- 2026-11-14 - Added `sceneBounds.test.js` for scene footprint bounds.
- 2026-11-14 - Added `eventContext.test.js` (15 tests); `resetDb()` clears `event_context`; vitest config sets `EVENT_CONTEXT=off` so other suites never query NASA providers.
- 2026-11-14 - Added two `auth0.test.js` cases for `FRONTEND_URL`: post-login return and `screen_hint`, write-origin allowlist (including an invalid URL), and the browser redirect on `/`. Suite is 205 tests.
- 2026-11-14 - Fresh deployment run passed all 203 tests; recorded separate successful real Auth0/AI persistence browser checks.
- 2026-11-14 - Resolved main/Auth0 merge while preserving owned chats and specialist conversations; combined suite passes 203 tests in 14 files.
- 2026-11-14 - Reconciled merged specifications and distinguished prior verification from pending merged-source and browser E2E checks.
- 2026-11-14 - Added ten persistent-chat tests plus session access-policy coverage; reset chat tables before parent events to preserve foreign keys.
- 2026-11-14 - Added 14 Auth0 security/integration tests and authenticated existing write-route tests without adding a production bypass.
- 2026-11-14 - Added routing.test.js (13 tests); vitest.config.js blanks MODEL_* and provider keys so tests never route to outside providers unless a test opts in.
- 2026-11-14 - Added agents.test.js (30 tests) and a stats assertion in ingest.test.js; `resetDb` also clears messages and conversations.
- 2026-11-14 - Added main.test.js (entry-point re-exports).
- 2026-11-14 - Removed the unshipped processor bridge test file at user request.
- 2026-11-14 - Explicitly blank FIRMS and Google keys in the test environment after local credentials caused two missing-key tests to call real providers and fail.
- 2026-11-14 - Added supplementary NASA adapter and route tests; live checks are separate from automated suites and recorded in ../DATASET_ACCESS.md.
- 2026-11-14 - Added events.test.js (35 tests).
- 2026-11-14 - Initial suites for all Worker features.
