// Benchmark of outside LLM providers (Gemini via Vertex AI express, Groq) on the app's real prompts.
// Usage: node bench/bench.mjs [modelFilter]     Keys are read from ../.dev.vars and never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAnswerMessages, buildCaptionMessages, buildEventContext } from '../AI/AIManger.js';
import { buildSummaryMessages, buildCoverage } from '../AI/summary.js';
import { buildForecastMessages } from '../AI/forecast.js';
import { AGENTS, agentForEventType, systemPromptFor } from '../AI/agents.js';

const here = dirname(fileURLToPath(import.meta.url));
const vars = {};
for (const line of readFileSync(join(here, '..', '.dev.vars'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) vars[m[1]] = m[2].trim();
}
const REPS = 2;

// ---------- fixtures ----------
const event = { id: 'evt_bench', name: 'Kaikoura-style M7.4 earthquake', type: 'earthquake', bbox: [172.5, -42.6, 174.5, -41.4], startDate: '2026-03-02', endDate: '2026-04-20' };
const scenes = [
  { id: 'NISAR_L2_GUNW_001', product: 'GUNW', acquiredAt: '2026-03-04T05:10:00Z', polarizations: ['HH'], flightDirection: 'ASCENDING', status: 'ready' },
  { id: 'NISAR_L2_GCOV_002', product: 'GCOV', acquiredAt: '2026-03-16T05:10:00Z', polarizations: ['HH', 'HV'], flightDirection: 'ASCENDING', status: 'ready' },
  { id: 'NISAR_L2_GCOV_003', product: 'GCOV', acquiredAt: '2026-03-28T05:10:00Z', polarizations: ['HH', 'HV'], flightDirection: 'ASCENDING', status: 'ready' },
  { id: 'NISAR_L2_GOFF_004', product: 'GOFF', acquiredAt: '2026-04-09T05:10:00Z', polarizations: ['HH'], flightDirection: 'ASCENDING', status: 'pending' },
];
const manifest = {
  layers: [{ layer: 'backscatter_change_db', date: '2026-03-16', units: 'dB' }],
  stats: { meanChangeDb: -1.8, pctPixelsDecreased: 22.4, maxLosDisplacementCm: 41.5 },
  context: null,
};
const captions = [
  { sceneId: 'NISAR_L2_GUNW_001', text: 'Interferogram shows up to 41.5 cm line-of-sight displacement consistent with coseismic slip.' },
  { sceneId: 'NISAR_L2_GCOV_002', text: 'Backscatter fell by about 1.8 dB on average, likely from landslide scarring and surface roughness change.' },
];
const forecast = {
  observations: { count: 3, nextAcquisitionDate: '2026-04-21', medianRevisitDays: 12 },
  metrics: [
    { metric: 'meanChangeDb', latest: { date: '2026-03-28', value: -1.8 }, projected: { date: '2026-05-04', value: -1.3, low: -2.1, high: -0.5 }, direction: 'recovering', confidence: 'low' },
  ],
  skipped: ['maxLosDisplacementCm'],
};
const coverage = buildCoverage(scenes, manifest.layers);
const agent = agentForEventType(event.type);
const context = buildEventContext(event, scenes, captions);

const chatConsult = [
  { role: 'system', content: `${systemPromptFor(AGENTS.forecaster ?? agent)} A colleague is answering the user and asked for your domain note. Reply with at most 80 words covering only what your expertise adds. If it adds nothing, say "No additional input."` },
  { role: 'user', content: `Context:\n${JSON.stringify(context)}\n\nConversation so far:\n(none)\n\nUser question: Why did backscatter drop after the quake?` },
];
const chatPrimary = (notes) => [
  { role: 'system', content: `${systemPromptFor(agent)} You are chatting with a user about one event. Cite scene IDs you rely on. Keep answers under 150 words. Earlier assistant turns are prefixed with the specialist who wrote them; do not add such a prefix yourself.` },
  { role: 'user', content: `Context:\n${JSON.stringify(context)}${notes ? `\n\nNotes from colleagues you consulted (use them, attribute them by role, do not repeat them verbatim):\n- Colleague: ${notes}` : ''}\n\nQuestion: Why did backscatter drop after the quake?` },
];

const inputText = (msgs) => msgs.map((m) => m.content).join('\n');
const words = (s) => s.trim().split(/\s+/).length;
const inventedNumbers = (out, input) => (out.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => Number(n) > 5 && !input.includes(n));
const REFUSAL = /(does not|doesn't|do not|don't|not)\b.{0,60}\b(contain|provide|include|available|mention|specif|say|state)|cannot|can't|unable|no information|not in the|outside/i;

const tasks = [
  {
    name: 'caption', maxTokens: 220, messages: () => buildCaptionMessages(event, scenes[1], manifest),
    check: (o, inp) => ({ ok: /likely|consistent with|suggest|hypothes/i.test(o) && inventedNumbers(o, inp).length === 0 && words(o) <= 90, note: `hedged=${/likely|consistent with|suggest/i.test(o)} badNums=${inventedNumbers(o, inp).join(',')} words=${words(o)}` }),
  },
  {
    name: 'chat', maxTokens: 350, chat: true,
    check: (o, inp) => ({ ok: /NISAR_L2_\w+/.test(o) && words(o) <= 170 && inventedNumbers(o, inp).length === 0, note: `cites=${/NISAR_L2_\w+/.test(o)} words=${words(o)} badNums=${inventedNumbers(o, inp).join(',')}` }),
  },
  {
    name: 'unanswerable', maxTokens: 350, messages: () => buildAnswerMessages(event, scenes, captions, 'How many people died and what was the insured economic loss?'),
    check: (o) => ({ ok: REFUSAL.test(o) && !/\b\d{2,}\s*(people|deaths|dead)/i.test(o), note: `refused=${REFUSAL.test(o)}` }),
  },
  {
    name: 'summary', maxTokens: 450, messages: () => buildSummaryMessages(agent, event, scenes, captions, coverage),
    check: (o, inp) => {
      const parts = ['What happened', 'What NISAR sees', 'Likely drivers', 'Data coverage', 'Caveats'].filter((p) => o.includes(p));
      return { ok: parts.length === 5 && words(o) <= 230 && inventedNumbers(o, inp).length === 0, note: `sections=${parts.length}/5 words=${words(o)} badNums=${inventedNumbers(o, inp).join(',')}` };
    },
  },
  {
    name: 'forecast', maxTokens: 300, messages: () => buildForecastMessages(AGENTS.forecaster ?? agent, event, forecast, captions, 30),
    check: (o, inp) => ({ ok: o.includes('2026-04-21') && /projection|projected/i.test(o) && inventedNumbers(o, inp).length === 0, note: `date=${o.includes('2026-04-21')} projWord=${/project/i.test(o)} badNums=${inventedNumbers(o, inp).join(',')}` }),
  },
];

// ---------- providers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gemKey = vars.GEMINI_API_KEY;
const groqKey = vars.GROQ_API_KEY;

async function callGemini(model, messages, maxTokens, tuned) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const body = {
    contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2, ...(tuned ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) },
  };
  const res = await fetch(`https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${gemKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${json?.error?.message?.slice(0, 120) ?? ''}`), { status: res.status, retryAfter: 20 });
  const c = json.candidates?.[0];
  return { text: (c?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim(), finish: c?.finishReason, inTok: json.usageMetadata?.promptTokenCount, outTok: json.usageMetadata?.candidatesTokenCount, thinkTok: json.usageMetadata?.thoughtsTokenCount ?? 0 };
}

async function callGroq(model, messages, maxTokens, tuned, effort) {
  const body = { model, messages, max_tokens: maxTokens, temperature: 0.2, ...(tuned ? { reasoning_effort: effort } : {}) };
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${groqKey}` }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${json?.error?.message?.slice(0, 120) ?? ''}`), { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 15 });
  const c = json.choices?.[0];
  return { text: (c?.message?.content ?? '').trim(), finish: c?.finish_reason, inTok: json.usage?.prompt_tokens, outTok: json.usage?.completion_tokens, thinkTok: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0 };
}

async function callGateway(model, messages, maxTokens, extra = {}, headroom = 0) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${model.startsWith('groq/') ? groqKey : gemKey}`, 'cf-aig-authorization': `Bearer ${vars.CF_AIG_TOKEN}`, 'cf-aig-skip-cache': 'true' };
  const res = await fetch(`https://gateway.ai.cloudflare.com/v1/${vars.CF_ACCOUNT_ID}/earth-replay/compat/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages, max_tokens: maxTokens + headroom, temperature: 0.2, ...extra }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json).slice(0, 140)}`), { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 15 });
  const c = json.choices?.[0];
  return { text: (c?.message?.content ?? '').trim(), finish: c?.finish_reason, inTok: json.usage?.prompt_tokens, outTok: json.usage?.completion_tokens, thinkTok: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0 };
}

async function callCF(model, messages, maxTokens, extra = {}, headroom = 0) {
  const res = await fetch('http://localhost:8799/', { method: 'POST', body: JSON.stringify({ model, inputs: { messages, max_tokens: maxTokens + headroom, temperature: 0.2, ...extra } }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json).slice(0, 140)}`), { status: res.status === 502 ? 400 : res.status });
  const c = json.choices?.[0];
  const text = typeof json === 'string' ? json : (json.response ?? c?.message?.content ?? '');
  const u = json.usage ?? {};
  return { text: String(text ?? '').trim(), finish: c?.finish_reason, inTok: u.prompt_tokens, outTok: u.completion_tokens, thinkTok: u.completion_tokens_details?.reasoning_tokens ?? 0 };
}
const CF_MODELS = ['llama-3.3-70b-instruct-fp8-fast', 'qwen/qwen3.8-27b', 'mistralai/mistral-small-3.1-24b-instruct', 'moonshotai/kimi-k2.6', 'zai-org/glm-5.3-flash', 'deepseek-ai/deepseek-v4.1-flash-1017', 'nvidia/nemotron-3-120b-a12b', 'thinkingmachines/inkling-2-small', 'google/gemma-4-26b-a4b-it'];
const cfPrefix = (n) => (n.startsWith('llama') ? '@cf/meta/' : '@cf/') + n;
const cfConfigs = CF_MODELS.flatMap((n) => [
  { id: 'cf:' + cfPrefix(n), mode: 'as-is', call: (m, t) => callCF(cfPrefix(n), m, t) },
  { id: 'cf:' + cfPrefix(n), mode: 'no-think', call: (m, t) => callCF(cfPrefix(n), m, t, { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' }, 1024) },
]);

const configs = [
  { id: 'gw:google-ai-studio/gemini-2.5-flash-lite', mode: 'gateway', call: (m, t) => callGateway('google-ai-studio/gemini-2.5-flash-lite', m, t) },
  { id: 'gw:google-ai-studio/gemini-3.1-flash-lite', mode: 'gateway', call: (m, t) => callGateway('google-ai-studio/gemini-3.1-flash-lite', m, t, {}, 1024) },
  { id: 'gw:google-ai-studio/gemini-3.8-flash', mode: 'gateway low', call: (m, t) => callGateway('google-ai-studio/gemini-3.8-flash', m, t, { reasoning_effort: 'low' }, 1024) },
  { id: 'gw:groq/qwen/qwen3.8-27b', mode: 'gateway', call: (m, t) => callGateway('groq/qwen/qwen3.8-27b', m, t, { reasoning_effort: 'none' }) },
  { id: 'gw:groq/openai/gpt-oss-20b', mode: 'gateway low', call: (m, t) => callGateway('groq/openai/gpt-oss-20b', m, t, { reasoning_effort: 'low' }, 1024) },
  { id: 'gemini-3.1-flash-lite', mode: 'as-is', call: (m, t) => callGemini('gemini-3.1-flash-lite', m, t, false) },
  { id: 'gemini-3.1-flash-lite', mode: 'low-thinking', call: (m, t) => callGemini('gemini-3.1-flash-lite', m, t, true) },
  { id: 'gemini-3-flash-preview', mode: 'as-is', call: (m, t) => callGemini('gemini-3-flash-preview', m, t, false) },
  { id: 'gemini-3-flash-preview', mode: 'low-thinking', call: (m, t) => callGemini('gemini-3-flash-preview', m, t, true) },
  { id: 'gemini-3.8-flash', mode: 'as-is', call: (m, t) => callGemini('gemini-3.8-flash', m, t, false) },
  { id: 'gemini-3.8-flash', mode: 'low-thinking', call: (m, t) => callGemini('gemini-3.8-flash', m, t, true) },
  { id: 'openai/gpt-oss-20b', mode: 'as-is', call: (m, t) => callGroq('openai/gpt-oss-20b', m, t, false) },
  { id: 'openai/gpt-oss-20b', mode: 'low-thinking', call: (m, t) => callGroq('openai/gpt-oss-20b', m, t, true, 'low') },
  { id: 'openai/gpt-oss-120b', mode: 'as-is', call: (m, t) => callGroq('openai/gpt-oss-120b', m, t, false) },
  { id: 'openai/gpt-oss-120b', mode: 'low-thinking', call: (m, t) => callGroq('openai/gpt-oss-120b', m, t, true, 'low') },
  { id: 'qwen/qwen3.8-27b', mode: 'as-is', call: (m, t) => callGroq('qwen/qwen3.8-27b', m, t, false) },
  { id: 'qwen/qwen3.8-27b', mode: 'thinking-off', call: (m, t) => callGroq('qwen/qwen3.8-27b', m, t, true, 'none') },
];

async function timed(cfg, messages, maxTokens) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = performance.now();
    try {
      const r = await cfg.call(messages, maxTokens);
      return { ...r, ms: performance.now() - t0 };
    } catch (e) {
      if (e.status === 429 || e.status === 503) { await sleep((e.retryAfter ?? 15) * 1000 + 500); continue; }
      throw e;
    }
  }
  throw new Error('rate-limited after 5 retries');
}

async function runTask(cfg, task) {
  const t0 = performance.now();
  let calls = [];
  let finalText;
  let inp;
  if (task.chat) {
    const consult = await timed(cfg, chatConsult, 160); // production chat does a consult, then the primary answer
    const prim = chatPrimary(consult.text);
    const final = await timed(cfg, prim, task.maxTokens);
    calls = [consult, final]; finalText = final.text; inp = inputText(prim);
  } else {
    const msgs = task.messages();
    const r = await timed(cfg, msgs, task.maxTokens);
    calls = [r]; finalText = r.text; inp = inputText(msgs);
  }
  const wall = calls.reduce((s, c) => s + c.ms, 0); // sequential API time only, retries/waits excluded
  const truncated = calls.some((c) => /length|MAX_TOKENS/i.test(c.finish ?? ''));
  const empty = !finalText;
  const chk = empty ? { ok: false, note: 'empty' } : task.check(finalText, inp);
  return { task: task.name, ms: wall, ok: chk.ok && !truncated, truncated, empty, note: chk.note, inTok: calls.reduce((s, c) => s + (c.inTok ?? 0), 0), outTok: calls.reduce((s, c) => s + (c.outTok ?? 0), 0), thinkTok: calls.reduce((s, c) => s + (c.thinkTok ?? 0), 0), sample: finalText?.slice(0, 400) };
}

const filter = process.argv[2];
if (filter === 'cf') configs.splice(0, configs.length, ...cfConfigs);
if (filter === 'gw') configs.splice(5); // gateway configs only (the first five)
const results = [];
for (const cfg of configs.filter((c) => !filter || filter === 'gw' || filter === 'cf' || c.id.includes(filter))) {
  const isGroq = cfg.id.includes('groq/') || (!cfg.id.startsWith('gw:') && !cfg.id.startsWith('cf:') && cfg.id.includes('/'));
  const rows = [];
  console.log(`\n== ${cfg.id} [${cfg.mode}]`);
  for (let rep = 0; rep < REPS; rep++) {
    for (const task of tasks) {
      try {
        const r = await runTask(cfg, task);
        rows.push(r);
        console.log(`  ${task.name.padEnd(12)} ${r.ok ? 'PASS' : 'FAIL'} ${(r.ms / 1000).toFixed(1)}s out=${r.outTok} think=${r.thinkTok} ${r.truncated ? 'TRUNCATED ' : ''}${r.note}`);
      } catch (e) {
        rows.push({ task: task.name, ok: false, error: e.message });
        console.log(`  ${task.name.padEnd(12)} ERROR ${e.message}`);
        if (/^(401|403|404)/.test(e.message)) break;
      }
      if (isGroq) await sleep(14000); // stay under the free ~8K tokens/min limit
    }
  }
  results.push({ id: cfg.id, mode: cfg.mode, rows });
}

writeFileSync(join(here, filter === 'cf' ? 'results-workersai.json' : filter === 'gw' ? 'results-gateway.json' : 'results.json'), JSON.stringify(results, null, 2));

console.log('\n=== SUMMARY (per model/mode) ===');
console.log('model'.padEnd(28), 'mode'.padEnd(13), 'pass'.padEnd(7), 'chat s'.padEnd(8), 'avg s'.padEnd(7), 'trunc', 'think tok/call');
for (const r of results) {
  const ok = r.rows.filter((x) => x.ok).length;
  const timedRows = r.rows.filter((x) => x.ms);
  const chat = timedRows.filter((x) => x.task === 'chat');
  const avg = (a) => (a.length ? (a.reduce((s, x) => s + x.ms, 0) / a.length / 1000).toFixed(1) : '-');
  const trunc = r.rows.filter((x) => x.truncated).length;
  const think = timedRows.length ? Math.round(timedRows.reduce((s, x) => s + x.thinkTok, 0) / timedRows.length) : '-';
  console.log(r.id.padEnd(28), r.mode.padEnd(13), `${ok}/${r.rows.length}`.padEnd(7), avg(chat).padEnd(8), avg(timedRows).padEnd(7), String(trunc).padEnd(5), think);
}
