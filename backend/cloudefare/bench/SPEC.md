# bench

## Purpose
Developer-only benchmark that runs the app's real AI prompts (caption, chat with consult, unanswerable question, summary, forecast) against outside LLM providers (Gemini via Vertex AI express, Groq) to compare pass rate, latency and token use. Not part of the deployed Worker.

## Contents
| File | Description |
| --- | --- |
| bench.mjs | Runs 5 task types x 2 reps per model/mode, applies automatic checks, prints a summary and writes results.json |
| e2e.mjs | Calls the real routing code (`generateTextDetailed`) once per use case with the wrangler.jsonc chains and live gateway/provider keys; Workers AI is stubbed. `node bench/e2e.mjs` |
| results-gateway.json, run-gw.log | Output of `node bench/bench.mjs gw` (gateway configs only) |
| cf-proxy/ | Throwaway dev Worker exposing the AI binding for `bench.mjs cf`. See [cf-proxy/SPEC.md](cf-proxy/SPEC.md) |
| results-workersai.json, run-cf.log | Output of `node bench/bench.mjs cf` |
| results.json | Output of the last run (generated) |
| run.log | Console log of the last run (generated) |

## Interfaces
- CLI: `node bench/bench.mjs [modelSubstring]` from `backend/cloudefare`.
- Reads `GEMINI_API_KEY` and `GROQ_API_KEY` from `../.dev.vars` (never printed). The Gemini key is a Vertex AI express key (`AQ.` prefix) and is sent to `aiplatform.googleapis.com`.
- Imports prompt builders from `../AI/AIManger.js`, `summary.js`, `forecast.js`, `agents.js`. The chat prompts mirror `AI/chat.js` (those builders are not exported).

## Dependencies
- Node 22 (global fetch), the `AI/` folder, external Gemini and Groq APIs. No Cloudflare bindings.

## Tests
No automated tests; this is a manual benchmark. Checks per task are heuristic (hedging words, invented numbers, scene-ID citation, five summary sections, forecast date present, refusal on unanswerable). Known gaps: no human grading, only 2 reps, one synthetic event, latency includes network from the dev machine, retries excluded from timing.

## Results (2026-11-14, 10 calls per row)
| Model | Mode | Pass | Chat turn | Notes |
| --- | --- | --- | --- | --- |
| gemini-3.1-flash-lite | default | 10/10 | 2.0 s | no thinking by default |
| gemini-3.1-flash-lite | thinking low | 6/10 | 2.4 s | thinking tokens cut answers off |
| gemini-3-flash-preview | both | 0/10 | 3.9 s | thinking uses the whole token budget |
| gemini-3.8-flash | default / thinking low | 2/10 / 10/10 | 5.8 s / 3.5 s | one default-mode call took 66 s |
| groq gpt-oss-20b | default / reasoning low | 2/10 / 8/10 | 1.2 s / 0.6 s | failures are answer-quality checks |
| groq gpt-oss-120b | default / reasoning low | 2/10 / 4/10 | 1.6 s / 1.3 s | |
| groq qwen3.8-27b | default / thinking off | 10/10 / 10/10 | 0.8 s / 1.1 s | fastest passing model |

### Through AI Gateway (what production uses), 10 calls per row
| Model | Pass | Chat turn | Notes |
| --- | --- | --- | --- |
| google-ai-studio/gemini-2.5-flash-lite | 0/2 | - | 404 "no longer available to new users" |
| google-ai-studio/gemini-3.1-flash-lite | 10/10 | 2.5 s | default settings |
| google-ai-studio/gemini-3.8-flash (low) | 10/10 | 3.9 s | slower, shorter chat answers |
| groq/qwen/qwen3.8-27b | 10/10 | 1.2 s | fastest passing |
| groq/openai/gpt-oss-20b (low) | 7/10 | 1.3 s | unreliable |

### Workers AI models on the Paid plan (via cf-proxy), 10 calls per row
| Model | Mode | Pass | Chat turn |
| --- | --- | --- | --- |
| llama-3.3-70b-instruct-fp8-fast | default | 10/10 | 2.2 s |
| mistral-small-3.1-24b | default | 9/10 | 2.6 s (rejects the thinking-off parameters) |
| qwen3.8-27b | thinking off | 10/10 | 6.7 s (default: 2/10, cut off) |
| glm-5.3-flash | thinking off | 10/10 | 3.6 s |
| deepseek-v4.1-flash | thinking off | 10/10 | 4.5 s |
| gemma-4-26b-a4b | thinking off | 10/10 | 4.0 s |
| inkling-2-small | thinking off | 9/10 | 2.8 s |
| nemotron-3-120b-a12b | thinking off | 8/10 | 1.4 s |
| kimi-k2.6 | both | 0/10 and 2/10 | 13 to 39 s |

## Status
Done for the 2026-11-14 run. `gemini-2.5-flash-lite` and other 2.x models return 404 for the current key, and Llama 3.3 70B is not offered on the Groq key, so neither was tested.

## Changelog
- 2026-11-14 - Benchmarked 9 Workers AI models on the Paid plan (`bench.mjs cf` with cf-proxy). Llama 3.3 remains the fastest reliable one; thinking models need thinking off.
- 2026-11-14 - Added gateway benchmark configs (`bench.mjs gw`); Gemini 3.1 Flash-Lite and Groq qwen3.8-27b both 10/10 through AI Gateway.
- 2026-11-14 - Added e2e.mjs; verified Groq through AI Gateway (200). Gemini via google-ai-studio is blocked (403 API_KEY_SERVICE_BLOCKED) because the key is a Vertex key, so Gemini steps fall back.
- 2026-11-14 - Added bench.mjs to compare Gemini and Groq models on the app's real prompts.
