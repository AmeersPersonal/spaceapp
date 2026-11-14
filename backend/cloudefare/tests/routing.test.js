// Per-use-case model routing: Workers AI vs outside providers through AI Gateway, fallback chains.
// Outside calls are mocked with a fake global fetch; no real service is contacted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIError, generateText, generateTextDetailed, modelChain, parseProviderModel } from '../AI/AIGateway.js';
import { agentPinned } from '../AI/agents.js';
import { fakeAI } from './helpers.js';

const base = {
  LLM_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  AI_GATEWAY_ID: 'earth-replay',
  CF_ACCOUNT_ID: 'acct123',
  GROQ_API_KEY: 'gsk_test',
  GEMINI_API_KEY: 'aistudio_test',
};
const msgs = [{ role: 'user', content: 'hi' }];

function mockFetch(handler) {
  const calls = [];
  vi.stubGlobal('fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return handler(body, calls.length);
  });
  return calls;
}
const ok = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('modelChain', () => {
  it('uses LLM_MODEL when nothing is configured', () => {
    expect(modelChain(base, { useCase: 'chat' })).toEqual([base.LLM_MODEL]);
  });

  it('puts MODEL_<USECASE> first, then the caller default, MODEL_FALLBACK and LLM_MODEL without duplicates', () => {
    const env = { ...base, MODEL_CHAT: 'groq/openai/gpt-oss-20b, google-ai-studio/gemini-3.1-flash-lite', MODEL_FALLBACK: '@cf/mistralai/mistral-small-3.1-24b-instruct' };
    expect(modelChain(env, { useCase: 'chat', model: base.LLM_MODEL })).toEqual([
      'groq/openai/gpt-oss-20b',
      'google-ai-studio/gemini-3.1-flash-lite',
      base.LLM_MODEL,
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
    ]);
  });

  it('lets a pinned agent model beat the use-case setting', () => {
    const env = { ...base, MODEL_CHAT: 'groq/openai/gpt-oss-20b' };
    expect(modelChain(env, { useCase: 'chat', model: '@cf/x/y', pinned: true })[0]).toBe('@cf/x/y');
    expect(modelChain(env, { useCase: 'chat', model: '@cf/x/y', pinned: true })).not.toContain('groq/openai/gpt-oss-20b');
  });

  it('leaves other use cases unaffected by a use-case setting', () => {
    expect(modelChain({ ...base, MODEL_CHAT: 'groq/a/b' }, { useCase: 'caption' })).toEqual([base.LLM_MODEL]);
  });

  it('parses provider ids and detects pinned agents', () => {
    expect(parseProviderModel('groq/openai/gpt-oss-20b')).toEqual({ provider: 'groq', name: 'openai/gpt-oss-20b' });
    expect(agentPinned({ AGENT_MODEL_HYDROLOGIST: 'x' }, { id: 'hydrologist' })).toBe(true);
    expect(agentPinned({}, { id: 'hydrologist' })).toBe(false);
  });
});

describe('generateTextDetailed', () => {
  it('calls an outside provider through the AI Gateway compat endpoint with the right key and reasoning settings', async () => {
    const calls = mockFetch(() => ok('  from groq  '));
    const env = { ...base, MODEL_CHAT: 'groq/openai/gpt-oss-20b', CF_AIG_TOKEN: 'aig_tok', AI: fakeAI() };
    const out = await generateTextDetailed(env, msgs, { useCase: 'chat', maxTokens: 350, cacheTtl: 60 });
    expect(out).toEqual({ text: 'from groq', model: 'groq/openai/gpt-oss-20b' });
    expect(calls[0].url).toBe('https://gateway.ai.cloudflare.com/v1/acct123/earth-replay/compat/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer gsk_test');
    expect(calls[0].headers['cf-aig-authorization']).toBe('Bearer aig_tok');
    expect(calls[0].headers['cf-aig-cache-ttl']).toBe('60');
    expect(calls[0].body).toMatchObject({ model: 'groq/openai/gpt-oss-20b', reasoning_effort: 'low' });
    expect(calls[0].body.max_tokens).toBeGreaterThan(350); // headroom for hidden reasoning tokens
    expect(env.AI.calls).toHaveLength(0);
  });

  it('bypasses gateway caches for private generations across provider fallback', async () => {
    const calls = mockFetch(() => new Response('{}', { status: 503 }));
    const ai = fakeAI();
    const out = await generateTextDetailed({ ...base, AI: ai, MODEL_ASK: 'groq/openai/gpt-oss-20b' }, msgs, {
      useCase: 'ask', skipCache: true,
    });
    expect(calls[0].headers['cf-aig-skip-cache']).toBe('true');
    expect(calls[0].headers['cf-aig-cache-ttl']).toBeUndefined();
    expect(out.model).toBe(base.LLM_MODEL);
    expect(ai.calls[0].options.gateway.skipCache).toBe(true);
  });

  it('uses the Gemini key for google-ai-studio models', async () => {
    const calls = mockFetch(() => ok('hello'));
    await generateText({ ...base, MODEL_SUMMARY: 'google-ai-studio/gemini-3.1-flash-lite' }, msgs, { useCase: 'summary' });
    expect(calls[0].headers.authorization).toBe('Bearer aistudio_test');
  });

  it('falls back to Workers AI when the outside provider fails', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));
    const ai = fakeAI({ response: 'from workers ai' });
    const out = await generateTextDetailed({ ...base, AI: ai, MODEL_CHAT: 'groq/openai/gpt-oss-20b' }, msgs, { useCase: 'chat' });
    expect(out).toEqual({ text: 'from workers ai', model: base.LLM_MODEL });
    expect(ai.calls).toHaveLength(1);
  });

  it('falls back when the outside provider returns an empty answer or the network fails', async () => {
    mockFetch(() => ok('   '));
    const empty = await generateTextDetailed({ ...base, AI: fakeAI(), MODEL_ASK: 'groq/openai/gpt-oss-20b' }, msgs, { useCase: 'ask' });
    expect(empty.model).toBe(base.LLM_MODEL);
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    const down = await generateTextDetailed({ ...base, AI: fakeAI(), MODEL_ASK: 'groq/openai/gpt-oss-20b' }, msgs, { useCase: 'ask' });
    expect(down.model).toBe(base.LLM_MODEL);
  });

  it('skips a provider whose key is missing and reports a clear error when every model fails', async () => {
    const calls = mockFetch(() => ok('x'));
    const env = { ...base, GROQ_API_KEY: undefined, AI: fakeAI({ fail: true }), MODEL_CHAT: 'groq/openai/gpt-oss-20b' };
    await expect(generateText(env, msgs, { useCase: 'chat' })).rejects.toBeInstanceOf(AIError);
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown providers and missing gateway settings instead of calling out', async () => {
    const calls = mockFetch(() => ok('x'));
    const ai = fakeAI();
    await expect(generateText({ ...base, AI: ai, LLM_MODEL: undefined, MODEL_CHAT: 'mystery/model' }, msgs, { useCase: 'chat' })).rejects.toThrow(/Unknown AI provider/);
    await expect(
      generateText({ ...base, CF_ACCOUNT_ID: undefined, LLM_MODEL: undefined, MODEL_CHAT: 'groq/openai/gpt-oss-20b' }, msgs, { useCase: 'chat' }),
    ).rejects.toThrow(/CF_ACCOUNT_ID/);
    expect(calls).toHaveLength(0);
  });

  it('keeps Workers AI behavior unchanged when no routing is configured', async () => {
    const ai = fakeAI({ response: 'plain' });
    const out = await generateTextDetailed({ ...base, AI: ai }, msgs, { useCase: 'caption', maxTokens: 220 });
    expect(out).toEqual({ text: 'plain', model: base.LLM_MODEL });
    expect(ai.calls[0].inputs.max_tokens).toBe(220);
  });
});

describe('reasoning settings per model family', () => {
  it('sends no reasoning_effort to gemini-3.1-flash-lite but reserves headroom, and "none" to qwen3', async () => {
    const calls = mockFetch(() => ok('ok'));
    await generateText({ ...base, MODEL_CHAT: 'google-ai-studio/gemini-3.1-flash-lite' }, msgs, { useCase: 'chat', maxTokens: 100 });
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    expect(calls[0].body.max_tokens).toBeGreaterThan(100);
    await generateText({ ...base, MODEL_CHAT: 'groq/qwen/qwen3.8-27b' }, msgs, { useCase: 'chat', maxTokens: 100 });
    expect(calls[1].body).toMatchObject({ reasoning_effort: 'none', max_tokens: 100 });
  });
});
