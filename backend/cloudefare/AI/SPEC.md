# AI

## Purpose
Workers AI features for Earth Replay. It writes captions that hypothesize the physical driver of observed NISAR change, runs semantic search over those captions with Vectorize, and produces grounded answers for `POST /api/ask`. Every model call goes through AI Gateway.

## Contents
| File | Description |
|---|---|
| `AIGateway.js` | `runModel`, `generateText`, `embed` and `gatewayOptions`. Wraps `env.AI.run` with AI Gateway options and normalizes errors into `AIError`. |
| `AIManger.js` | `validateAskRequest`, `buildCaptionMessages`, `captionScene`, `searchCaptions`, `buildAnswerMessages`, `answerQuestion`, `hashQuestion` and `AI_DISCLAIMER`. |

## Interfaces
- `captionScene(env, {event, scene, manifest})` writes a row to the D1 `captions` table and upserts a Vectorize vector `{id: captionId, metadata:{eventId, sceneId, product}}`.
- `searchCaptions(env, eventId, query, topK=5)` queries Vectorize filtered by `eventId` and joins the D1 captions.
- `answerQuestion(env, {event, scenes, question, history=[], privateConversation=false})` returns `{eventId, question, answer, sources, sceneCount, model, aiGenerated, disclaimer, credit}`. It falls back to the latest captions when Vectorize has no matches. Private conversations include owner-scoped prior turns and skip generation gateway caching; no public KV answer cache is used for chat continuations.
- `validateAskRequest` accepts optional `chatId` (1–128 safe ID characters). The Worker verifies ownership and event matching before generating an answer or loading private history.
- `generateText` forwards optional `skipCache` to AI Gateway.
- Env: `LLM_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), `EMBEDDING_MODEL` (default `@cf/baai/bge-base-en-v1.5`, 768-dim) and `AI_GATEWAY_ID`.
- Prompts use only the supplied catalog facts and manifest stats, and they phrase drivers as hypotheses. All output is labeled `aiGenerated`.

## Dependencies
Bindings `AI`, `VECTORS`, `DB`; `../dataManger.js` (captions, `DATA_CREDIT`).

## Tests
`../tests/ai.test.js` covers gateway routing, error wrapping, embedding shape validation, caption storage and indexing, the no-store-on-failure path, the event filter on search, and answers. The route-level cases (cache, 502) are in `../tests/api.test.js`. Run with `npm test` from `cloudefare/`. All AI and Vectorize calls use the fakes in `../tests/helpers.js`, so caption quality from the real models is untested.

## Status
Done. TODO: add supplementary context (USGS/FIRMS) to prompts once the processor emits `manifest.context`.

## Changelog
- 2026-11-14 - Added bounded chat continuation context, optional chatId validation and private generation cache bypass; chat turn storage remains in chats.js.
- 2026-11-14 - Initial AI Gateway wrapper, captions, Vectorize search and ask answers.
