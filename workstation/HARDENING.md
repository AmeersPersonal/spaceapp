# Workstation hardening implementation plan

Goal: prepare the native workstation for deployment against the existing Earth
Replay Worker, with real catalog data and restrained API usage.

Architecture: retain the existing ES modules and same-origin API/session
contract. Public reads get a bounded, short-lived in-memory cache and shared
in-flight requests. Authenticated history and writes stay uncached. Tests use
local fixtures and Node's built-in test runner; no new runtime dependencies.

Branch: `workstation-frontend`. Do not commit, push or publish during preparation.
Keep `Frontend/` unchanged and preserve the current production processor/secrets.

## Tasks

- [ ] Harden `js/api.js`: preserve facade/payloads; cache public catalog for 60 s,
  event detail for 30 s, discovery for 60 s, context/media/model outputs for 5 min;
  bound cache to 64 entries; deduplicate reads; time out requests; never retry writes.
  Tests: `tests/api.test.js`, mocked request counts, privacy, expiry, errors and invalidation.
- [ ] Fix `js/liveMap.js` templates and add `replayFrameAt(snapshot, count, serverNow)`
  in `js/room.js`; preserve server clock in `onState(state, serverTime)`.
  Tests: `tests/liveMap.test.js`, `tests/room.test.js`.
- [ ] Harden `js/main.js`: live default, protected history restoration, fresh manual
  refresh, bounded post-ingest checks, stale-response guards and timestamp-based
  replay synchronization, including delayed event loads. Keep synthetic frames
  explicitly separate and modelled forecasts outside the observed timeline.
  Tests: `tests/main.test.js` and browser checks using a local mock API.
- [ ] Build a minimal static artifact in `dist/` using `build.mjs`, excluding
  development servers, docs and tests. Add separate backend workstation deploy
  and dry-run commands that reuse production bindings and preserve Containers.
  Tests: `tests/build.test.js`; local production-artifact browser checks.
- [ ] Update owning specs and setup/deployment documentation. Review the complete
  diff; run native tests, desktop/mobile browser checks, and deployment dry run.

## Verification focus

Slow/missing/malformed providers must produce a usable error state. Switching
events must not apply old responses. Restoring history must not overwrite a new
answer. Duplicate actions must not start duplicate writes. Live-data failures
must never substitute synthetic observations. Room playback must use the server
clock, including clock skew and async event loading. Production preparation must
leave the currently deployed site unchanged.
