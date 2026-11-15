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
- `regionalContext` (optional, from `../eventContext.js` `promptContext`): stored supplementary NASA datasets for the event area. `buildEventContext`, `answerQuestion`, `runChat`, `summarizeEvent` accept it; `summaryCacheKey` includes its `fetchedAt`. `REGIONAL_CONTEXT_RULE` tells the model it is mostly catalog metadata and not NISAR data. The forecast prompt does not use it.
- `answerQuestion(env, {event, scenes, question, history=[], privateConversation=false, regionalContext=null})` returns `{eventId, question, answer, sources, sceneCount, model, aiGenerated, disclaimer, credit}`. Shared caption retrieval falls back to the latest event captions when semantic search has no matches or fails, including plain Vectorize binding errors in local development. With no stored captions, answers use event, scene and regional metadata. Private conversations include owner-scoped prior turns and skip generation gateway caching; no public KV answer cache is used for chat continuations.
- `validateAskRequest` accepts optional `chatId` (1–128 safe ID characters). The Worker verifies ownership and event matching before generating an answer or loading private history.
- `generateText` and `generateTextDetailed` forward optional `skipCache` through every fallback; external providers receive `cf-aig-skip-cache: true` for private generation.
- Env: `LLM_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), `EMBEDDING_MODEL` (default `@cf/baai/bge-base-en-v1.5`, 768-dim) and `AI_GATEWAY_ID`.
- `generateText(env, messages, {model, maxTokens, temperature, cacheTtl})` takes an optional `model`; it reads both `{response}` and OpenAI-style `choices` outputs.
- **Agents** (`agents.js`): each has `id, name, expertise, eventTypes, model, keywords, prompt`. The model is `AGENT_MODEL_<ID>` (e.g. `AGENT_MODEL_HYDROLOGIST`) if set, else the agent default: `LLM_MODEL` for seismologist/glaciologist/coordinator/forecaster, `@cf/mistralai/mistral-small-3.1-24b-instruct` for hydrologist/ecologist/soil_scientist.
- **Routing** (`routeMessage`): primary = explicit `agent` > best whole-word keyword match > the event type's specialist. Consulted (max 2) = the event's own specialist plus any other expert the message touches; the forecaster joins only for future-tense questions. Consults run in parallel on their own models and return notes of at most 80 words; a failed consult is skipped and listed in `consultsFailed`.
- **Shared thread**: D1 `conversations`/`messages`. All agents see the last 12 messages, with specialist turns tagged `[agent]`. Roles: `user`, `consult`, `assistant`. Nothing is stored if the primary model fails.
- **Summary**: written by the event type's specialist; `coverage` (counts, dates, layers) is computed in code. Cached in KV by scene count, ready count and latest caption id.
- **Forecast**: deterministic. Per `PRODUCT:metric` from `manifest.stats` (numeric, top level or one nested level), one value per day, at least 3 points, OLS line, projection at last scene date + `horizonDays` with a 1.96-sigma band, confidence `low` or `moderate` only (never high). Also the median revisit cadence and next expected acquisition. Fewer than 2 acquisition dates returns `status:'insufficient_data'` and makes no model call. The forecaster agent only narrates the computed numbers. Output always carries `modeled:true` and `PREDICTION_DISCLAIMER`.
- **Model routing** (`AIGateway.js`): `generateTextDetailed(env, messages, {useCase, model, pinned, maxTokens, temperature, cacheTtl})` returns `{text, model}`; `generateText` returns just the text. Chain = `MODEL_<USECASE>` (comma list; skipped when `pinned`) + caller `model` + `MODEL_FALLBACK` + `LLM_MODEL`, de-duplicated; the first model that answers wins and errors/empty answers fall through. Use cases: `caption`, `ask`, `chat`, `consult`, `summary`, `forecast`. `@cf/...` ids use `env.AI.run`; `groq/<model>` and `google-ai-studio/<model>` POST to `https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/<AI_GATEWAY_ID>/compat/chat/completions` with the provider key as Bearer (`GROQ_API_KEY`, `GEMINI_API_KEY`) and optional `cf-aig-authorization` (`CF_AIG_TOKEN`). Reasoning models get extra completion headroom and `reasoning_effort` (gpt-oss `low`, qwen3 `none`, gemini-3.x `low` except 3.1 Flash-Lite).
- Env: `MODEL_CAPTION|ASK|CHAT|CONSULT|SUMMARY|FORECAST`, `MODEL_FALLBACK`, `CF_ACCOUNT_ID`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `CF_AIG_TOKEN`, `LLM_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), `EMBEDDING_MODEL` (default `@cf/baai/bge-base-en-v1.5`, 768-dim) and `AI_GATEWAY_ID`.
- Prompts use only the supplied catalog facts and manifest stats, and they phrase drivers as hypotheses. All output is labeled `aiGenerated`.

## Dependencies
Bindings `AI`, `VECTORS`, `DB`; `../eventContext.js` (stored regional context); `../dataManger.js` (captions, conversations/messages, scene stats, `DATA_CREDIT`). Scene stats come from `manifest.stats`, stored by the queue consumer.

## Tests
`../tests/agents.test.js` covers routing, per-agent models, chat (consults, shared history, failures, foreign conversations), summary, forecast math, stats storage and the new routes. `../tests/ai.test.js` covers gateway routing, error wrapping, embedding shape validation, caption storage and indexing, the no-store-on-failure path, the event filter on search, and answers. The route-level cases (cache, 502) are in `../tests/api.test.js`. Run with `npm test` from `cloudefare/`. All AI and Vectorize calls use the fakes in `../tests/helpers.js`, so caption quality from the real models is untested.

## Status
Local Ask no longer fails with HTTP 500 when Vectorize is unavailable. The search failure is logged and the existing D1 caption fallback is used; this does not enable local semantic search or change authentication. Regression cases cover events with and without stored captions.
Verified on 2026-11-15: both regressions failed before the fix and passed afterward; all 266 backend tests passed with `npm.cmd test -- --maxWorkers=2`. The running local specialist endpoint, which shares caption retrieval, returned a real Workers AI answer with HTTP 200 after previously returning 500.

Merge resolved and verified by the 203-test combined suite. Shared event context, bounded private history, actual-model reporting and provider fallback coexist. `skipCache` propagates through Workers AI gateway options and external gateway headers. Private `/api/ask` history uses `chats`/`chat_messages`; public specialist `/api/chat` uses separate `conversations`/`messages` and has no owner isolation. Live deployed `/api/ask` browser E2E passed real AI turns, exact private history restoration after confirmed logout/re-login, and continued generation after reload; specialist chat, summary and forecast routes also returned 200. Limits: routing is keyword-based (no LLM router); trends are straight lines, so they only mean something with several scenes and stats from the processor (which does not exist yet); per-agent model ids are untested against real Workers AI. TODO: add supplementary context (USGS/FIRMS) to prompts once the processor emits `manifest.context`.

## Changelog
- 2026-11-15 - Handle plain Vectorize search errors in shared caption retrieval; Ask and specialist chat fall back to event-scoped D1 captions instead of returning HTTP 500 locally.
- 2026-11-14 - Ask, chat and summary prompts accept stored `regionalContext` (supplementary NASA datasets) and state it is not NISAR data; summary cache key includes its fetch time.
- 2026-11-14 - Verified real deployed AI conversations and private history persistence across Auth0 logout/re-login, plus specialist chat/summary/forecast smoke checks.
- 2026-11-14 - Resolved main/Auth0 merge while preserving owned chats and specialist conversations; combined suite passes 203 tests in 14 files.
- 2026-11-14 - Reconciled merged specifications and distinguished prior verification from pending merged-source and browser E2E checks.
- 2026-11-14 - Added bounded chat continuation context, optional chatId validation and private generation cache bypass; chat turn storage remains in chats.js.
- 2026-11-14 - Per-use-case model routing: `generateTextDetailed`/`generateText` take `useCase` and `pinned`, resolve a `MODEL_<USECASE>` chain (+ `MODEL_FALLBACK`, `LLM_MODEL`) and call outside providers (Groq, Google AI Studio) through the AI Gateway compat endpoint. Responses and stored rows now record the model that actually answered. New `agentPinned`.
- 2026-11-14 - Added the multi-agent chatbot, specialist roster with per-agent models, event summaries and predictive analysis; `generateText` takes a `model`; `retrieveCaptions` falls back to recent captions if search fails.
- 2026-11-14 - Initial AI Gateway wrapper, captions, Vectorize search and ask answers.
