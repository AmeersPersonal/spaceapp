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

/** Text generation; returns the response string. */
export async function generateText(env, messages, { maxTokens = 400, temperature = 0.2, cacheTtl } = {}) {
  const out = await runModel(env, env.LLM_MODEL, { messages, max_tokens: maxTokens, temperature }, { cacheTtl });
  const text = typeof out === 'string' ? out : out?.response;
  if (typeof text !== 'string' || !text.trim()) throw new AIError('Model returned an empty response');
  return text.trim();
}

/** Embeddings for one or more strings; returns an array of vectors. */
export async function embed(env, texts) {
  const out = await runModel(env, env.EMBEDDING_MODEL, { text: texts }, { cacheTtl: 86400 });
  if (!Array.isArray(out?.data) || out.data.length !== texts.length) throw new AIError('Embedding model returned unexpected shape');
  return out.data;
}
