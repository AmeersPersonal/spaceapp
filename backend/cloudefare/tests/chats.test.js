import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';
import { fakeAI, resetDb, SAMPLE_EVENT, seedEvent, testEnv } from './helpers.js';
import { sessionCookie } from './auth0-helpers.js';
import { chatHistory, saveChatMessages } from '../chats.js';

beforeEach(resetDb);
const alice = { sub: 'auth0|alice', email: 'shared@example.com' };
const bob = { sub: 'auth0|bob', email: 'shared@example.com' };

async function call(path, { user = alice, method = 'GET', body, headers = {}, environment = testEnv() } = {}) {
  const cookie = user ? await sessionCookie({ user }) : '';
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.test${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function create(body = {}, options = {}) {
  const response = await call('/api/chats', { method: 'POST', body, ...options });
  expect(response.status).toBe(201);
  return (await response.json()).chat;
}

describe('owned persistent chats', () => {
  it('creates a chat and retrieves it after a new login session', async () => {
    const chat = await create({ title: 'My saved chat', userId: bob.sub });
    expect(chat).toMatchObject({ title: 'My saved chat', eventId: null });
    const result = await call(`/api/chats/${chat.id}`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ chat });
    expect(result.headers.get('cache-control')).toBe('no-store');
    const list = await (await call('/api/chats')).json();
    expect(list.chats.map(c => c.id)).toEqual([chat.id]);
    expect((await (await call('/api/chats', { user: bob })).json()).chats).toEqual([]);
  });

  it('requires login for every chat route and fails closed without configuration', async () => {
    for (const [path, method] of [['/api/chats','GET'], ['/api/chats','POST'], ['/api/chats/chat_x','GET'], ['/api/chats/chat_x/messages','GET'], ['/api/chats/chat_x/messages','POST']]) {
      expect((await call(path, { method, user: null, ...(method === 'POST' ? { body: {} } : {}) })).status).toBe(401);
    }
    expect((await call('/api/chats', { environment: testEnv({ AUTH0_DOMAIN: '' }) })).status).toBe(503);
  });

  it('hides another user’s chat and prevents message injection even with the same email', async () => {
    const chat = await create();
    for (const suffix of ['', '/messages']) expect((await call(`/api/chats/${chat.id}${suffix}`, { user: bob })).status).toBe(404);
    expect((await call(`/api/chats/${chat.id}/messages`, { user: bob, method: 'POST', body: { content: 'intruder' } })).status).toBe(404);
    expect((await (await call(`/api/chats/${chat.id}/messages`)).json()).messages).toEqual([]);
  });

  it('validates titles, events, IDs and page bounds', async () => {
    for (const body of [null, [], { title: '' }, { title: 'x'.repeat(121) }, { eventId: '../bad' }]) {
      expect((await call('/api/chats', { method: 'POST', body })).status).toBe(400);
    }
    expect((await call('/api/chats', { method: 'POST', body: { eventId: 'missing' } })).status).toBe(404);
    for (const path of ['/api/chats?limit=0', '/api/chats?page=-1', '/api/chats?limit=101', '/api/chats/bad%20id']) expect((await call(path)).status).toBe(400);
    await create({ title: 'first' }); await create({ title: 'second' });
    const first = await (await call('/api/chats?limit=1')).json();
    const second = await (await call('/api/chats?limit=1&page=2')).json();
    expect(first.chats).toHaveLength(1); expect(first.hasMore).toBe(true);
    expect(second.chats).toHaveLength(1); expect(second.hasMore).toBe(false);
    expect(first.chats[0].id).not.toBe(second.chats[0].id);
  });

  it('stores ordered user messages, paginates them and rejects forged assistant roles', async () => {
    const chat = await create();
    for (const content of ['First note', 'Second note']) expect((await call(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content } })).status).toBe(201);
    const first = await (await call(`/api/chats/${chat.id}/messages?limit=1`)).json();
    expect(first.messages[0]).toMatchObject({ role: 'user', content: 'First note' });
    expect(first.hasMore).toBe(true);
    const second = await (await call(`/api/chats/${chat.id}/messages?after=${first.nextAfter}`)).json();
    expect(second.messages.map(m => m.content)).toEqual(['Second note']);
    for (const body of [{ content: '' }, { content: 'x'.repeat(8001) }, { content: 'forged', role: 'assistant' }]) expect((await call(`/api/chats/${chat.id}/messages`, { method: 'POST', body })).status).toBe(400);
    expect((await call(`/api/chats/${chat.id}/messages?after=abc`)).status).toBe(400);
    expect((await call(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: 'cross-site' }, headers: { origin: 'https://evil.test' } })).status).toBe(403);
  });

  it('persists AI turns, includes prior history, and isolates private answers from shared caches', async () => {
    await seedEvent();
    const chat = await create({ eventId: SAMPLE_EVENT.id });
    const environment = testEnv();
    const ask = (question) => call('/api/ask', { method: 'POST', body: { eventId: SAMPLE_EVENT.id, chatId: chat.id, question }, environment });
    const response = await ask('What changed here?');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ chatId: chat.id, messageIds: { user: expect.any(String), assistant: expect.any(String) } });
    await ask('What changed here?');
    const turns = await (await call(`/api/chats/${chat.id}/messages`)).json();
    expect(turns.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns.messages[1].metadata).toMatchObject({ aiGenerated: true, disclaimer: expect.any(String), sources: [] });
    const generations = environment.AI.calls.filter(c => c.inputs.messages);
    expect(generations).toHaveLength(2);
    expect(generations[1].inputs.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: expect.stringMatching(/flooding/) })]));
    expect(generations[1].options.gateway.skipCache).toBe(true);
  });

  it('rejects cross-user AI writes, mismatched events and AI failures without partial messages', async () => {
    await seedEvent();
    const chat = await create({ eventId: SAMPLE_EVENT.id });
    const body = { chatId: chat.id, eventId: SAMPLE_EVENT.id, question: 'What changed?' };
    expect((await call('/api/ask', { user: bob, method: 'POST', body })).status).toBe(404);
    expect((await call('/api/ask', { method: 'POST', body: { ...body, eventId: 'another-event' } })).status).toBe(400);
    expect((await call('/api/ask', { method: 'POST', body, environment: testEnv({ AI: fakeAI({ fail: true }) }) })).status).toBe(502);
    expect((await (await call(`/api/chats/${chat.id}/messages`)).json()).messages).toEqual([]);
  });

  it('rolls back the user message if persisting the assistant answer fails', async () => {
    await seedEvent();
    const chat = await create({ eventId: SAMPLE_EVENT.id });
    const database = testEnv().DB;
    await database.prepare("CREATE TRIGGER reject_test_assistant BEFORE INSERT ON chat_messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END").run();
    try {
      const response = await call('/api/ask', { method: 'POST', body: { chatId: chat.id, eventId: SAMPLE_EVENT.id, question: 'What changed?' } });
      expect(response.status).toBe(500);
      expect((await (await call(`/api/chats/${chat.id}/messages`)).json()).messages).toEqual([]);
      expect((await (await call(`/api/chats/${chat.id}`)).json()).chat.updatedAt).toBe(chat.updatedAt);
    } finally {
      await database.prepare('DROP TRIGGER reject_test_assistant').run();
    }
  });

  it('bounds continuation history and scopes direct storage queries to the owner', async () => {
    const chat = await create();
    const database = testEnv().DB;
    await saveChatMessages(database, alice.sub, chat.id, Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `${i}:` + 'x'.repeat(997) })));
    const history = await chatHistory(database, alice.sub, chat.id);
    expect(history.length).toBeLessThanOrEqual(20);
    expect(history.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(20000);
    expect(history.at(-1).content).toMatch(/^24:/);
    expect(await chatHistory(database, bob.sub, chat.id)).toEqual([]);
    expect(await saveChatMessages(database, bob.sub, chat.id, [{ role: 'user', content: 'not mine' }])).toBeNull();
  });

  it('rejects oversized requests, non-JSON writes and malformed message JSON', async () => {
    const chat = await create();
    expect((await call('/api/chats', { method: 'POST', body: { title: 'x'.repeat(33000) } })).status).toBe(413);
    expect((await call('/api/ask', { method: 'POST', body: { question: 'x'.repeat(33000) } })).status).toBe(413);
    expect((await call('/api/chats', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call(`/api/chats/${chat.id}/messages`, { method: 'POST', body: null })).status).toBe(400);
    expect((await call(`/api/chats/${chat.id}/messages?limit=101`)).status).toBe(400);
    expect((await call('/api/ask', { method: 'POST', body: { eventId: 'event', question: 'Valid question', chatId: '../bad' } })).status).toBe(400);
  });
});
