CLAUDE.md — Earth Replay Backend (NASA Space Apps 2026: "Dancing with the SARs")
Project scope

Goal: The backend for an open-source app that uses radar data from the NASA-ISRO NISAR mission to track real surface change at locations around the world. It ingests, processes, stores and serves NISAR-derived data and explanations through a Cloudflare-based API.

Challenge: NASA Space Apps 2026, "Dancing with the SARs". The brief asks for an application that tracks and visualizes one or more types of surface change (earthquake deformation, flooding/wetlands, forest/crop change, glacier movement, soil moisture) using NISAR data. Hackathon runs Nov 14-15, 2026. This repo covers the backend only; the frontend is owned separately.

In scope

Searching and downloading NISAR scenes from ASF DAAC.
Processing scenes into cloud-friendly outputs (COGs/tiles) and storing them.
A catalog of events, areas of interest, scenes, polarizations and dates.
A REST API and tile endpoints for the frontend to consume.
Auth0-managed browser login/logout and user sessions for ingest and AI write operations; catalog browsing remains public.
Persistent, owner-scoped D1 chats and message history, tied to the verified Auth0 subject across login sessions.
AI-generated captions that hypothesize the physical driver of observed change, plus semantic search over them.
Shared replay sessions: synchronized playback state over WebSockets.
Scheduled polling for newly published NISAR scenes.
Heavy use of Cloudflare where feasible, unique and justified (see Stack).
Public repo, open-source license, README and architecture diagram.

Out of scope

Frontend/UI work of any kind.
Synthetic or modeled data presented as observations. Everything served must trace to real NISAR (or clearly labeled supplementary) data.
Locally managed user accounts, payments, custom SAR processing algorithms beyond tile/COG generation.
Anything not demoable by the end of the hackathon. Cut features before cutting stability.

Success criteria: The frontend can list events, fetch scene metadata and tiles, ask for an AI explanation, trigger and track an ingest, and join a shared replay session, all through documented endpoints, and each of those features has passing tests.

Stack
API: Cloudflare Worker (Hono).
Cloudflare services: Workers, Workflows (durable ingest pipeline), Queues + DLQ (per-scene processing), Durable Objects (shared replay rooms over WebSockets), R2 (COGs/tiles), D1 (event/scene/caption catalog), KV (manifests/cache), Workers AI + Vectorize (captions, semantic search) behind AI Gateway; per-use-case chat models can also be Groq or Google AI Studio models called through AI Gateway (see cloudefare/AI/SPEC.md), Cron Triggers (poll for new NISAR scenes), Containers (Python h5py/rasterio processing, if enabled).
Data: NISAR L2 GCOV, GUNW, GOFF, L3 SME2 via ASF DAAC (asf_search, earthaccess, Earthdata Login token). Supplementary context: Sentinel-1/2, USGS earthquakes, NASA FIRMS, JRC Surface Water, ESA WorldCover, WorldPop.
Constraint: Do not parse NISAR HDF5 inside a Worker (memory/CPU limits). Precompute tiles with Python (local or Container) and serve from R2.
API surface (contract with the frontend)
GET /auth/login (redirect to Auth0)
GET /auth/callback (Auth0 authorization-code callback)
GET /auth/logout (clear session and sign out through Auth0)
GET /api/auth/me (signed-in profile; 401 when logged out)
POST /api/chats {title?, eventId?} (create an owned chat; requires login)
GET /api/chats?limit&page (list the signed-in user's chats)
GET /api/chats/:id (owned chat metadata)
GET /api/chats/:id/messages?limit&after (ordered owned message history)
POST /api/chats/:id/messages {content} (append a user message; requires login and JSON)
GET /api/events
GET /api/events/:id (scenes, dates, polarizations)
GET /api/events/:id/context (stored supplementary NASA datasets for the event area; refreshed when older than 6 h and given to the AI as context)
GET /tiles/:event/:layer/:date/:z/:x/:y.png
GET /api/discover/earthquakes?minMagnitude&days&start&end&bbox (USGS quakes for the last `days` or a start/end period + suggested ingest)
POST /api/events/earthquake {usgsId} (requires Auth0 session and JSON; register a quake as an event and start an ingest)
GET /api/nisar/search?bbox&start&end&products (preview NISAR scenes, no ingest)
GET /api/geocode?q (place name to AOI, needs GOOGLE_MAPS_API_KEY)
GET /api/datasets (supplementary NASA source list and credential configuration status)
GET /api/datasets/:source?bbox&start&end&limit&page&runDate&cycle (CMR granule references, GEOS forecast file references, or FIRMS fire detections)
GET /api/datasets/context?bbox&start&end&sources&limit&page&runDate&cycle (combined regional queries with per-source successes/errors)
POST /api/ingest {aoi, dateRange, eventId?, name?, type?, products?, description?, watch?} (requires Auth0 session and JSON; starts a Workflow, returns an id; full payload in cloudefare/SPEC.md)
GET /api/ingest/:id (status)
POST /api/ask {eventId, question, chatId?} (requires Auth0 session and JSON; optionally continue an owned, event-bound chat and persist the question/answer)
GET /api/agents (specialist roster)
POST /api/chat {eventId, message, conversationId?, agent?} (multi-agent chat; specialists share one thread and consult each other)
GET /api/chat/:conversationId (stored thread)
GET /api/events/:id/summary (AI briefing per event)
GET /api/events/:id/predict?horizonDays (modeled projection from NISAR-derived stats)
GET /api/outlook?bbox&horizonDays (modeled seismic outlook per grid cell from the USGS catalog, with AI-worded scenarios; never an observation)
GET /api/events/:id/media (USGS impact maps, related NASA photos and photo links for an event)
WS /api/room/:code (replay sync)

Changing any route or payload shape requires updating the owning folder's spec and this list in the same turn.

Rule 1: Every folder gets a SPEC.md

Whenever you create a folder, immediately create SPEC.md inside it. This applies to every folder you create, at any depth, except node_modules/, .git/, .wrangler/, dist/, build/, __pycache__/, and other generated/vendored directories.

Each SPEC.md must contain these sections:

markdown
# <folder name>

## Purpose
One or two sentences: what this folder is for and how it fits the project scope above.

## Contents
Table of files/subfolders, each with a one-line description.

## Interfaces
Public functions, API routes, queue message shapes, DB tables, bindings, env vars, or CLI commands this folder exposes or consumes.

## Dependencies
Other folders, Cloudflare bindings, external datasets/APIs this folder relies on.

## Tests
Test files covering this folder, how to run them, and any known gaps.

## Status
Done / in progress / planned, plus known issues or TODOs.

## Changelog
Newest first. One line per change: `YYYY-MM-DD - what changed and why`.

Keep specs short and factual. Describe what exists, not what you hope to build, except under Status.

Rule 2: Update the SPEC.md after every change

After every edit that touches a folder (adding, modifying, renaming or deleting files), update that folder's SPEC.md in the same turn, before reporting the work as done:

Update Contents, Interfaces and Dependencies if they changed.
Update Status.
Add a Changelog line.
If a change affects a parent folder's role, contents or interfaces, update the parent SPEC.md too.
If a folder has no SPEC.md (e.g. it pre-dates these rules), create one first.

A change is not finished until the spec matches the code. If you rename or move a folder, move its SPEC.md with it and fix references in other specs.

Rule 3: Every feature ships with tests

Every feature you add or change must include tests in the same turn. A feature is not done until its tests exist and pass.

Cover what was built. Each new route, Workflow step, Queue consumer, Durable Object, cron handler, data-processing function, or AI/Vectorize call gets tests for the happy path, at least one failure or edge case (bad input, missing data, upstream error, retry/DLQ path), and any input validation.
Use the right level. Unit tests for pure logic (tile math, parsing, payload validation). Integration tests for Workers with bindings, using Vitest with @cloudflare/vitest-pool-workers (local D1, R2, KV, Queues, Durable Objects). Python processing code gets pytest.
Mock external services. Never call ASF DAAC, Earthdata, or Workers AI in tests. Use small fixtures or recorded responses stored under the folder's tests/ or fixtures/ directory.
Run them. Run the relevant tests before reporting the work as done, and fix failures. If a test cannot run in the current environment, say so explicitly and why. Never claim tests pass without running them.
Bug fixes get a regression test that fails before the fix and passes after.
Keep tests next to the code. Put them in a tests/ folder (or *.test.ts beside the file). That folder follows Rule 1 and gets its own SPEC.md. Record test locations and run commands in the owning folder's ## Tests section.
Do not weaken or delete tests to make them pass. If a test is wrong, fix it and say why.
Root-level docs
The root SPEC.md mirrors the scope above, lists top-level folders with links to their specs, and holds the architecture overview.
If project scope changes, update this file's "Project scope" section and the root SPEC.md together.
Working conventions
Prefer small, working vertical slices over broad scaffolding. The demo path matters most.
Never commit secrets. Earthdata tokens and Cloudflare credentials go in .dev.vars / Wrangler secrets; keep .dev.vars in .gitignore.
Name Cloudflare bindings consistently (DB, TILES, CACHE, INGEST_QUEUE, INGEST_WORKFLOW, REPLAY_ROOM, AI, VECTORS) and document them in the owning folder's spec.
Validate any NISAR product/scene assumption against ASF metadata before relying on it. Coverage is still being reprocessed through 2026.
Credit data sources (NASA/JPL/ISRO, ASF DAAC) in API responses where relevant and in the README.
