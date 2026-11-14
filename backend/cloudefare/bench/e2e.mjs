// Calls generateTextDetailed for each use case with the real wrangler.jsonc MODEL_* chains and real gateway/provider keys.
// Workers AI is stubbed (it needs a Worker runtime), so a "stub-workers-ai" result means every outside model in the chain failed.
import { readFileSync } from 'node:fs';
import { generateTextDetailed, USE_CASES } from '../AI/AIGateway.js';
const vars = {};
for (const l of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) vars[m[1]] = m[2].trim(); }
const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')).vars;
const env = { ...cfg, ...vars, AI: { run: async () => ({ response: 'stub-workers-ai' }) } };
for (const useCase of USE_CASES) {
  const t0 = performance.now();
  try {
    const r = await generateTextDetailed(env, [{ role: 'user', content: 'Reply with one short sentence about radar.' }], { useCase, maxTokens: 60 });
    console.log(useCase.padEnd(9), r.model.padEnd(42), `${((performance.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(r.text.slice(0, 60)));
  } catch (e) { console.log(useCase.padEnd(9), 'FAILED', e.message); }
}
