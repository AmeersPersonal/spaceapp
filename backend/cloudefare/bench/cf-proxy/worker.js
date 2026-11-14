// Dev-only proxy so bench.mjs can call Workers AI models (needs the AI binding, so it runs under `wrangler dev`).
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST {model, inputs}', { status: 405 });
    const { model, inputs } = await request.json();
    try {
      return Response.json(await env.AI.run(model, inputs));
    } catch (err) {
      return Response.json({ error: String(err?.message ?? err) }, { status: 502 });
    }
  },
};
