# cf-proxy

## Purpose
Throwaway dev Worker that exposes the Workers AI binding over HTTP so `bench/bench.mjs cf` can benchmark `@cf/...` models. Never deployed.

## Contents
| File | Description |
| --- | --- |
| worker.js | `POST {model, inputs}` -> `env.AI.run(model, inputs)`; errors return 502 `{error}` |
| wrangler.jsonc | Worker config with only the `AI` binding |

## Interfaces
- Run with `npx wrangler dev --port 8799` from this folder. `POST http://localhost:8799/` with `{model, inputs}`.
- Workers AI calls made this way use the real account (billed on the Workers Paid plan beyond the free neurons).

## Dependencies
- Wrangler login and the `AI` binding. No other bindings.

## Tests
None; dev tool.

## Status
Done. Not for deployment.

## Changelog
- 2026-11-14 - Added to benchmark Workers AI models on the Paid plan.
