# Cloudflare setup and deploy guide

Deploys the Earth Replay API (worker name `earth-replay-api`). Run every command from `backend/cloudefare`, the folder that holds `wrangler.jsonc`. Running them from anywhere else fails with "Required Worker name missing".

## 0. Prerequisites

- Node.js 20 or newer and npm.
- A Cloudflare account. Queues may need the Workers Paid plan ($5/month) on some accounts.
- A payment method on file, which R2 requires (the free tier is enough for development).

```
cd backend/cloudefare
npm install
```

## 1. Log in to the right account

```
npx wrangler login
npx wrangler whoami
```

Check that the account ID matches the account you mean to use. To switch accounts:

```
npx wrangler logout
npx wrangler login
```

Use an incognito window if the browser signs you straight back into the old account. If the login has several accounts, pin one with `$env:CLOUDFLARE_ACCOUNT_ID = "<id>"` (PowerShell) or `"account_id"` in `wrangler.jsonc`. Delete `backend/.wrangler/cache` after switching so the old account ID isn't reused.

For CI, skip the browser: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 2. Enable R2 in the dashboard

Wrangler cannot do this step. Open https://dash.cloudflare.com, go to **R2 object storage**, and click **Get started** or **Purchase R2 Plan**. Without it, bucket creation fails with error 10042.

## 3. Create the resources

Each resource must exist before deploy. An "already exists" or "already taken" error is fine; it means the resource is there.

```
npx wrangler d1 create earth-replay
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create earth-replay-tiles
npx wrangler queues create earth-replay-ingest
npx wrangler queues create earth-replay-ingest-dlq
npx wrangler vectorize create earth-replay-captions --dimensions=768 --metric=cosine
```

The Vectorize index must be 768 dimensions with cosine, to match `@cf/baai/bge-base-en-v1.5`.

If a command says the resource already exists, look up its ID:

```
npx wrangler d1 list --json          # "uuid" is the database_id
npx wrangler kv namespace list       # "id"
npx wrangler r2 bucket list
npx wrangler queues list
npx wrangler vectorize list
```

## 4. Put the IDs in `wrangler.jsonc`

Only D1 and KV need IDs. Replace whatever is there:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "earth-replay",
    "database_id": "<D1 uuid>", "migrations_dir": "migrations" }
],
"kv_namespaces": [{ "binding": "CACHE", "id": "<KV id>" }],
```

Keep exactly one binding each for `DB`, `CACHE` and `VECTORS`. Wrangler sometimes offers to add extra bindings (such as `earth_replay` or `VECTORIZE`) after a create command. Decline them. The code only reads `env.DB`, `env.CACHE` and `env.VECTORS`.

Leave the all-zeros placeholder IDs out of any deploy. They cause error 10041 (KV) or a similar D1 error.

## 5. Create the AI Gateway

In the dashboard go to **AI → AI Gateway → Create Gateway** and name it `earth-replay`. The name must match `AI_GATEWAY_ID` in `wrangler.jsonc`.

### Using the gateway for outside models (Groq, Gemini)

The Worker calls Workers AI models through the `AI` binding and every other model through the gateway's OpenAI-compatible endpoint, `https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/earth-replay/compat/chat/completions`. The gateway adds logging, caching and rate limits to both.

1. Create the gateway (above). Under **Settings** you can turn on **Authenticated Gateway**. If you do, create a token (**AI Gateway → your gateway → Create token**) and set it as `CF_AIG_TOKEN`; the Worker then sends it as `cf-aig-authorization`. An unauthenticated call to an authenticated gateway returns `401 {"code":2009}`.
2. Set the secrets (step 7): `CF_ACCOUNT_ID` (from `npx wrangler whoami`), `GROQ_API_KEY` (console.groq.com) and `GEMINI_API_KEY`. The Gemini key must be a Google AI Studio key (starts with `AIza`) from aistudio.google.com. A Vertex AI key (starts with `AQ.`) does not work with the `google-ai-studio` provider.
3. Pick a model per use case in `wrangler.jsonc`. Model ids are `@cf/...` for Workers AI or `<provider>/<model>` for outside models (`groq/qwen/qwen3.8-27b`, `google-ai-studio/gemini-3.1-flash-lite`). Each use case takes a comma-separated list: the first is tried first and the next ones are used if it errors or returns nothing; `MODEL_FALLBACK` and `LLM_MODEL` (Workers AI) are always the last resort.

| Use case | Setting | Default chain | Why |
|---|---|---|---|
| Scene captions | `MODEL_CAPTION` | Groq qwen3.8-27b | Short, runs once per scene at ingest, fastest model |
| Grounded answers (`/api/ask`) | `MODEL_ASK` | Llama 3.3 (Workers AI), then Gemini 3.1 Flash-Lite | Must refuse when the data has no answer; answers are cached for an hour |
| Chat reply | `MODEL_CHAT` | Gemini 3.1 Flash-Lite, then Groq qwen3.8-27b | Cites scene IDs, needs quality and enough rate limit for several users |
| Specialist consults | `MODEL_CONSULT` | Groq qwen3.8-27b | 80-word notes in parallel, so speed matters most |
| Event summary | `MODEL_SUMMARY` | Gemini 3.1 Flash-Lite | Five labelled sections; passed 10/10 in the bench |
| Forecast narrative | `MODEL_FORECAST` | Gemini 3.1 Flash-Lite, then Groq qwen3.8-27b | Only narrates computed numbers |

A single agent can still be pinned with `AGENT_MODEL_<ID>` (for example `AGENT_MODEL_HYDROLOGIST`); that wins over the use-case setting. Set a use case to an empty string to go back to `LLM_MODEL`.
4. Check it works: `npx wrangler tail` while calling `POST /api/chat`, then open **AI Gateway → earth-replay → Logs**. Each call shows its provider, model, tokens and latency. The `model` field in API responses and stored captions/messages is the model that actually answered, so a fallback shows up there.

Embeddings (`bge-base-en-v1.5`) stay on Workers AI because the Vectorize index is 768-dimensional.

## 6. Apply the database schema

```
npm run db:migrate:remote
```

This runs `migrations/0001_init.sql` against the remote D1 database. A new database shows `num_tables: 0` until you do. For local development use `npm run db:migrate:local`.

## 7. Get and set the secrets

| Secret | Required | How to get it |
|---|---|---|
| `EARTHDATA_TOKEN` | For `.h5` downloads | Log in at https://urs.earthdata.nasa.gov, open **Generate Token**, copy the `eyJ...` string. Approve the "Alaska Satellite Facility Data Access" app under **Applications → Authorized Apps → Approve More Applications**. Tokens expire after about 60 days. |
| `INGEST_API_KEY` | Optional | Generate a random string. If set, `POST /api/ingest` needs `Authorization: Bearer <key>`. |
| `PROCESSOR_TOKEN` | Optional | Generate a random string. Must match the value on the Python processor. |
| `GOOGLE_MAPS_API_KEY` | Optional | Google Cloud Console, enable the **Geocoding API**, then **Credentials → Create API key**. Restrict it to Geocoding. Without it `/api/geocode` returns 503. |

Generate a random value (run once per secret, use different values):

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set each one in production:

```
npx wrangler secret put EARTHDATA_TOKEN
npx wrangler secret put INGEST_API_KEY
npx wrangler secret put PROCESSOR_TOKEN
npx wrangler secret put GOOGLE_MAPS_API_KEY
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put CF_AIG_TOKEN   # only if the gateway is authenticated
```

If the worker doesn't exist yet, Wrangler may offer to create it. You can also deploy first (step 8) and set secrets afterwards.

Never put secrets in `wrangler.jsonc`. It is committed to git.

## 8. Deploy

```
npm run deploy
```

This publishes the worker, the Durable Object (`ReplayRoom`), the Workflow (`IngestWorkflow`), the queue producer and consumers, and the cron trigger (every 6 hours). The output ends with the URL:

```
https://earth-replay-api.<your-subdomain>.workers.dev
```

## 9. Verify

```
npx wrangler tail
```

In another terminal or the browser:

```
curl https://earth-replay-api.<your-subdomain>.workers.dev/api/events
```

An empty list `{"events":[], ...}` means the Worker, D1 and KV are working.

## 10. Local development

Local secrets go in `.env` or `.dev.vars` (both are gitignored; `.dev.vars` wins if both exist). Copy `.dev.vars.example` as a starting point.

```
npm run db:migrate:local
npm run dev
npm test
```

## Before you go to production

- `CORS_ORIGIN` is `"*"`. Set it to the frontend's origin.
- `PROCESSOR_URL` is empty. Until the Python processor is hosted and the URL set, scenes stay `awaiting_processor`.
- `worker.js` exports `scheduled` but no `queue` handler. Check that queue messages are consumed before relying on ingest.

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `Required Worker name missing` | Wrong folder. `cd backend/cloudefare`. |
| `KV namespace '0000…' not found` (10041) | KV `id` is still the placeholder. Use `npx wrangler kv namespace list`. |
| `R2 bucket not found` (10085) | Bucket not created. Run the R2 create command. |
| `Please enable R2 through the Cloudflare Dashboard` (10042) | Step 2. |
| `Queue name ... is already taken` (11009) | The queue exists. Nothing to do. |
| `vectorize.index.duplicate_name` (3002) | The index exists. Confirm 768 dims with `npx wrangler vectorize get earth-replay-captions`. |
| Wrangler uses the wrong account | Step 1. Check `wrangler whoami` and delete `backend/.wrangler/cache`. |
