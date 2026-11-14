// Thin wrapper over the Workers AI binding that routes every call through AI Gateway
// (caching, rate limiting, logging) when AI_GATEWAY_ID is configured.

export class AIError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'AIError';
    this.cause = cause;
  }
}

export function gatewayOptions(env, { cacheTtl, skipCache } = {}) {
  if (!env.AI_GATEWAY_ID) return {};
  const gateway = { id: env.AI_GATEWAY_ID };
  if (cacheTtl !== undefined) gateway.cacheTtl = cacheTtl;
  if (skipCache !== undefined) gateway.skipCache = skipCache;
  return { gateway };
}

export async function runModel(env, model, inputs, options) {
  if (!env.AI) throw new AIError('AI binding is not configured');
  try {
    return await env.AI.run(model, inputs, gatewayOptions(env, options));
  } catch (err) {
    throw new AIError(`Workers AI call to ${model} failed: ${err?.message ?? err}`, { cause: err });
  }
}

// ---- Model routing -------------------------------------------------------------------------
// A model id is either a Workers AI id ("@cf/...") or "<provider>/<model>" for an outside provider
// reached through AI Gateway's OpenAI-compatible endpoint: "groq/openai/gpt-oss-20b",
// "google-ai-studio/gemini-3.1-flash-lite". Each use case can set MODEL_<USECASE> to a comma-separated
// chain (first = preferred); MODEL_FALLBACK and LLM_MODEL are appended as last resorts.

export const USE_CASES = Object.freeze(['caption', 'ask', 'chat', 'consult', 'summary', 'forecast']);
const PROVIDER_KEYS = { groq: 'GROQ_API_KEY', 'google-ai-studio': 'GEMINI_API_KEY' };
// Reasoning models spend completion tokens on hidden thinking; give them room so the answer is not cut off.
const REASONING_HEADROOM = 1024;

const list = (v) => (typeof v === 'string' ? v.split(',').map((m) => m.trim()).filter(Boolean) : []);

export function isWorkersAiModel(model) {
  return model.startsWith('@cf/') || model.startsWith('@hf/');
}

/** "groq/openai/gpt-oss-20b" -> { provider: 'groq', name: 'openai/gpt-oss-20b' }. */
export function parseProviderModel(model) {
  const i = model.indexOf('/');
  return { provider: model.slice(0, i), name: model.slice(i + 1) };
}

/** Ordered, de-duplicated list of models to try for one call. */
export function modelChain(env, { useCase, model, pinned = false } = {}) {
  const configured = pinned ? [] : list(env?.[`MODEL_${String(useCase ?? '').toUpperCase()}`]);
  const chain = [...(pinned && model ? [model] : []), ...configured, ...(model ? [model] : []), ...list(env?.MODEL_FALLBACK), env?.LLM_MODEL].filter(Boolean);
  return [...new Set(chain)];
}

function reasoningParams(name) {
  if (/gpt-oss/.test(name)) return { body: { reasoning_effort: 'low' }, headroom: REASONING_HEADROOM };
  if (/qwen3/.test(name)) return { body: { reasoning_effort: 'none' }, headroom: 0 };
  if (/gemini-3.1-flash-lite/.test(name)) return { body: {}, headroom: REASONING_HEADROOM }; // answered best with its default (no thinking)
  if (/gemini-3/.test(name)) return { body: { reasoning_effort: 'low' }, headroom: REASONING_HEADROOM };
  return { body: {}, headroom: 0 };
}

function extractText(out) {
  return typeof out === 'string' ? out : (out?.response ?? out?.choices?.[0]?.message?.content);
}

async function callExternal(env, model, messages, { maxTokens, temperature, cacheTtl, skipCache }) {
  const { provider, name } = parseProviderModel(model);
  const keyName = PROVIDER_KEYS[provider];
  if (!keyName) throw new AIError(`Unknown AI provider "${provider}" in model ${model}`);
  if (!env[keyName]) throw new AIError(`${keyName} is not configured for ${model}`);
  if (!env.CF_ACCOUNT_ID || !env.AI_GATEWAY_ID) throw new AIError('CF_ACCOUNT_ID and AI_GATEWAY_ID are required for outside providers');
  const extra = reasoningParams(name);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env[keyName]}` };
  if (env.CF_AIG_TOKEN) headers['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
  if (skipCache) headers['cf-aig-skip-cache'] = 'true';
  else if (cacheTtl) headers['cf-aig-cache-ttl'] = String(cacheTtl);
  let res;
  try {
    res = await fetch(`https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/compat/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens + extra.headroom, temperature, ...extra.body }),
    });
  } catch (err) {
    throw new AIError(`${model} call failed: ${err?.message ?? err}`, { cause: err });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AIError(`${model} returned ${res.status}: ${String(json?.error?.message ?? json?.message ?? '').slice(0, 160)}`);
  return json;
}

/**
 * Text generation with per-use-case routing and fallback. Returns { text, model } where model is the id
 * that actually answered. `model` is the caller's default (e.g. the agent's); `pinned` makes it win over
 * MODEL_<USECASE> (used for an explicit AGENT_MODEL_<ID> override).
 */
export async function generateTextDetailed(env, messages, { maxTokens = 400, temperature = 0.2, cacheTtl, skipCache, model, useCase, pinned } = {}) {
  const chain = modelChain(env, { useCase, model, pinned });
  if (!chain.length) throw new AIError('No model configured');
  let lastErr;
  for (const m of chain) {
    try {
      const out = isWorkersAiModel(m)
        ? await runModel(env, m, { messages, max_tokens: maxTokens, temperature }, { cacheTtl, skipCache })
        : await callExternal(env, m, messages, { maxTokens, temperature, cacheTtl, skipCache });
      const text = extractText(out);
      if (typeof text !== 'string' || !text.trim()) throw new AIError('Model returned an empty response');
      return { text: text.trim(), model: m };
    } catch (err) {
      lastErr = err instanceof AIError ? err : new AIError(`${m} failed: ${err?.message ?? err}`, { cause: err });
    }
  }
  throw lastErr;
}

/** Text generation; returns the response string. */
export async function generateText(env, messages, opts) {
  return (await generateTextDetailed(env, messages, opts)).text;
}

/** Embeddings for one or more strings; returns an array of vectors. */
export async function embed(env, texts) {
  const out = await runModel(env, env.EMBEDDING_MODEL, { text: texts }, { cacheTtl: 86400 });
  if (!Array.isArray(out?.data) || out.data.length !== texts.length) throw new AIError('Embedding model returned unexpected shape');
  return out.data;
}
