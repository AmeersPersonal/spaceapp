// Multi-agent chatbot. One conversation per event thread; every specialist reads and writes the
// same thread, and the answering agent can consult colleagues whose expertise the question touches.

import { AGENT_IDS, agentModel, agentPinned, getAgent, routeMessage, systemPromptFor } from './agents.js';
import { generateTextDetailed } from './AIGateway.js';
import { AI_DISCLAIMER, buildEventContext, retrieveCaptions } from './AIManger.js';
import { DATA_CREDIT, addMessages, createConversation, getConversation, listMessages } from '../dataManger.js';

export const HISTORY_WINDOW = 12;
export const MAX_MESSAGE_CHARS = 1000;
const CONVERSATION_ID_RE = /^conv_[A-Za-z0-9-]{8,64}$/;

export class ChatError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.status = status;
  }
}

export function validateChatRequest(body) {
  if (!body || typeof body !== 'object') return { errors: ['body must be a JSON object'] };
  const errors = [];
  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!eventId) errors.push('eventId is required');
  if (message.length < 2) errors.push('message must be at least 2 characters');
  if (message.length > MAX_MESSAGE_CHARS) errors.push(`message must be at most ${MAX_MESSAGE_CHARS} characters`);
  let conversationId;
  if (body.conversationId !== undefined && body.conversationId !== null) {
    if (typeof body.conversationId !== 'string' || !CONVERSATION_ID_RE.test(body.conversationId)) errors.push('conversationId is invalid');
    else conversationId = body.conversationId;
  }
  let agent;
  if (body.agent !== undefined && body.agent !== null) {
    if (typeof body.agent !== 'string' || !getAgent(body.agent)) errors.push(`agent must be one of: ${AGENT_IDS.join(', ')}`);
    else agent = body.agent;
  }
  return errors.length ? { errors } : { value: { eventId, message, conversationId, agent } };
}

const label = (m) => (m.role === 'user' ? 'user' : `${m.agent ?? 'assistant'}${m.role === 'consult' ? ' (consulted)' : ''}`);

/** The shared thread as chat messages. Specialist turns are tagged with who spoke. */
export function historyToMessages(history) {
  return history.map((m) =>
    m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: `[${label(m)}] ${m.content}` },
  );
}

function consultMessages(agent, context, history, message) {
  return [
    {
      role: 'system',
      content:
        `${systemPromptFor(agent)} A colleague is answering the user and asked for your domain note. ` +
        'Reply with at most 80 words covering only what your expertise adds. If it adds nothing, say "No additional input."',
    },
    {
      role: 'user',
      content: `Context:\n${JSON.stringify(context)}\n\nConversation so far:\n${history.map((m) => `[${label(m)}] ${m.content}`).join('\n') || '(none)'}\n\nUser question: ${message}`,
    },
  ];
}

function primaryMessages(agent, context, history, message, notes) {
  const colleagues = notes.length
    ? `\n\nNotes from colleagues you consulted (use them, attribute them by role, do not repeat them verbatim):\n${notes.map((n) => `- ${n.name}: ${n.text}`).join('\n')}`
    : '';
  return [
    {
      role: 'system',
      content:
        `${systemPromptFor(agent)} You are chatting with a user about one event. Cite scene IDs you rely on. Keep answers under 150 words. ` +
        'Earlier assistant turns are prefixed with the specialist who wrote them; do not add such a prefix yourself.',
    },
    ...historyToMessages(history),
    { role: 'user', content: `Context:\n${JSON.stringify(context)}${colleagues}\n\nQuestion: ${message}` },
  ];
}

/**
 * Handle one chat turn. Throws ChatError (unknown/foreign conversation) or AIError (primary model failed;
 * nothing is stored in that case). Failed consultations are skipped and reported in `consultsFailed`.
 */
export async function runChat(env, { event, scenes, message, conversationId, requestedAgent }) {
  let history = [];
  if (conversationId) {
    const conv = await getConversation(env.DB, conversationId);
    if (!conv || conv.eventId !== event.id) throw new ChatError('conversation_not_found', `conversation ${conversationId} not found for this event`, 404);
    history = await listMessages(env.DB, conversationId, HISTORY_WINDOW);
  }

  const { primary, consults } = routeMessage({ message, eventType: event.type, requestedAgent });
  const captions = await retrieveCaptions(env, event.id, message);
  const context = buildEventContext(event, scenes, captions);

  const settled = await Promise.allSettled(
    consults.map((a) =>
      generateTextDetailed(env, consultMessages(a, context, history, message), { model: agentModel(env, a), pinned: agentPinned(env, a), useCase: 'consult', maxTokens: 160 }),
    ),
  );
  const notes = [];
  const consultsFailed = [];
  settled.forEach((r, i) => {
    const a = consults[i];
    if (r.status === 'fulfilled') notes.push({ agent: a.id, name: a.name, model: r.value.model, text: r.value.text });
    else consultsFailed.push(a.id);
  });

  const { text, model } = await generateTextDetailed(env, primaryMessages(primary, context, history, message, notes), {
    model: agentModel(env, primary),
    pinned: agentPinned(env, primary),
    useCase: 'chat',
    maxTokens: 350,
  });

  const id = conversationId ?? `conv_${crypto.randomUUID()}`;
  if (!conversationId) await createConversation(env.DB, { id, eventId: event.id });
  await addMessages(env.DB, id, [
    { role: 'user', content: message },
    ...notes.map((n) => ({ role: 'consult', agent: n.agent, model: n.model, content: n.text })),
    { role: 'assistant', agent: primary.id, model, content: text },
  ]);

  return {
    conversationId: id,
    eventId: event.id,
    reply: { agent: primary.id, name: primary.name, model, text },
    consults: notes.map((n) => ({ agent: n.agent, name: n.name, model: n.model, text: n.text })),
    consultsFailed,
    sources: captions.map((c) => ({ captionId: c.id, sceneId: c.sceneId, score: c.score ?? null })),
    aiGenerated: true,
    disclaimer: AI_DISCLAIMER,
    credit: DATA_CREDIT,
  };
}

/** Full stored thread for GET /api/chat/:conversationId, or null. */
export async function getThread(env, conversationId) {
  const conv = await getConversation(env.DB, conversationId);
  if (!conv) return null;
  const messages = await listMessages(env.DB, conversationId, 500);
  return { conversationId, eventId: conv.eventId, createdAt: conv.createdAt, updatedAt: conv.updatedAt, messages, credit: DATA_CREDIT };
}
