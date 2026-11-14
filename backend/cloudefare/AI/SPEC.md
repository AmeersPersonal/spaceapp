# AI

## Purpose
Workers AI features for Earth Replay. It writes captions that hypothesize the physical driver of observed NISAR change, runs semantic search over those captions with Vectorize, and produces grounded answers for `POST /api/ask`. On top of that sit a multi-agent chatbot (specialists that share one thread and consult each other), per-event summaries, and a predictive analysis. Every model call goes through AI Gateway.

## Contents
| File | Description |
|---|---|
| `AIGateway.js` | `runModel`, `generateText`, `embed` and `gatewayOptions`. Wraps `env.AI.run` with AI Gateway options and normalizes errors into `AIError`. |
| `AIManger.js` | `validateAskRequest`, `buildCaptionMessages`, `captionScene`, `searchCaptions`, `buildAnswerMessages`, `answerQuestion`, `hashQuestion` and `AI_DISCLAIMER`. Also `retrieveCaptions` and `buildEventContext`. |
| `agents.js` | The specialist roster (seismologist, hydrologist, ecologist, glaciologist, soil_scientist, coordinator, forecaster): prompts, routing keywords, per-agent models, and `routeMessage`. |
| `chat.js` | `validateChatRequest`, `runChat` (route, consult, answer, store the shared thread) and `getThread`. |
| `summary.js` | `summarizeEvent`, `buildCoverage` (deterministic) and `summaryCacheKey`. |
| `forecast.js` | `forecastEvent`, `buildForecast` (OLS trends + revisit cadence), `linearFit`, `flattenStats`, `parseHorizon`. |

## Interfaces
- `captionScene(env, {event, scene, manifest})` writes a row to the D1 `captions` table and upserts a Vectorize vector `{id: captionId, metadata:{eventId, sceneId, product}}`.
- `searchCaptions(env, eventId, query, topK=5)` queries Vectorize filtered by `eventId` and joins the D1 captions.
- `answerQuestion(env, {event, scenes, question})` returns `{eventId, question, answer, sources, sceneCount, model, aiGenerated, disclaimer, credit}`. It falls back to the latest captions when Vectorize has no matches.
- `generateText(env, messages, {model, maxTokens, temperature, cacheTtl})` takes an optional `model`; it reads both `{response}` and OpenAI-style `choices` outputs.
- **Agents** (`agents.js`): each has `id, name, expertise, eventTypes, model, keywords, prompt`. The model is `AGENT_MODEL_<ID>` (e.g. `AGENT_MODEL_HYDROLOGIST`) if set, else the agent default: `LLM_MODEL` for seismologist/glaciologist/coordinator/forecaster, `@cf/mistralai/mistral-small-3.1-24b-instruct` for hydrologist/ecologist/soil_scientist.
- **Routing** (`routeMessage`): primary = explicit `agent` > best whole-word keyword match > the event type's specialist. Consulted (max 2) = the event's own specialist plus any other expert the message touches; the forecaster joins only for future-tense questions. Consults run in parallel on their own models and return notes of at most 80 words; a failed consult is skipped and listed in `consultsFailed`.
- **Shared thread**: D1 `conversations`/`messages`. All agents see the last 12 messages, with specialist turns tagged `[agent]`. Roles: `user`, `consult`, `assistant`. Nothing is stored if the primary model fails.
- **Summary**: written by the event type's specialist; `coverage` (counts, dates, layers) is computed in code. Cached in KV by scene count, ready count and latest caption id.
- **Forecast**: deterministic. Per `PRODUCT:metric` from `manifest.stats` (numeric, top level or one nested level), one value per day, at least 3 points, OLS line, projection at last scene date + `horizonDays` with a 1.96-sigma band, confidence `low` or `moderate` only (never high). Also the median revisit cadence and next expected acquisition. Fewer than 2 acquisition dates returns `status:'insufficient_data'` and makes no model call. The forecaster agent only narrates the computed numbers. Output always carries `modeled:true` and `PREDICTION_DISCLAIMER`.
- Env: `LLM_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), `EMBEDDING_MODEL` (default `@cf/baai/bge-base-en-v1.5`, 768-dim) and `AI_GATEWAY_ID`.
- Prompts use only the supplied catalog facts and manifest stats, and they phrase drivers as hypotheses. All output is labeled `aiGenerated`.

## Dependencies
Bindings `AI`, `VECTORS`, `DB`; `../dataManger.js` (captions, conversations/messages, scene stats, `DATA_CREDIT`). Scene stats come from `manifest.stats`, stored by the queue consumer.

## Tests
`../tests/agents.test.js` covers routing, per-agent models, chat (consults, shared history, failures, foreign conversations), summary, forecast math, stats storage and the new routes. `../tests/ai.test.js` covers gateway routing, error wrapping, embedding shape validation, caption storage and indexing, the no-store-on-failure path, the event filter on search, and answers. The route-level cases (cache, 502) are in `../tests/api.test.js`. Run with `npm test` from `cloudefare/`. All AI and Vectorize calls use the fakes in `../tests/helpers.js`, so caption quality from the real models is untested.

## Status
Done. Limits: routing is keyword-based (no LLM router); trends are straight lines, so they only mean something with several scenes and stats from the processor (which does not exist yet); per-agent model ids are untested against real Workers AI. TODO: add supplementary context (USGS/FIRMS) to prompts once the processor emits `manifest.context`.

## Changelog
- 2026-11-14 - Added the multi-agent chatbot, specialist roster with per-agent models, event summaries and predictive analysis; `generateText` takes a `model`; `retrieveCaptions` falls back to recent captions if search fails.
- 2026-11-14 - Initial AI Gateway wrapper, captions, Vectorize search and ask answers.
