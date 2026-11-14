// D1 chat storage. Every read/write is scoped to the verified Auth0 subject.
import { bodyLimit } from 'hono/body-limit';
import { getEvent } from './dataManger.js';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const chatFields = 'id, event_id AS eventId, title, created_at AS createdAt, updated_at AS updatedAt';
const messageFields = 'm.id, m.sequence, m.role, m.content, m.metadata, m.created_at AS createdAt';
const invalid = (c, message) => c.json({ error: 'invalid_request', message }, 400);
const notFound = (c) => c.json({ error: 'not_found', message: 'Chat not found' }, 404);

export const limitChatBody = bodyLimit({ maxSize: 32768, onError: (c) => c.json({ error: 'request_too_large' }, 413) });

function integer(value, fallback, min, max) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

async function readBody(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

export async function getChat(db, owner, id) {
  return db.prepare(`SELECT ${chatFields} FROM chats WHERE id = ? AND user_id = ?`).bind(id, owner).first();
}

function messageFromRow(row) {
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

export async function chatHistory(db, owner, id) {
  const { results } = await db.prepare(`SELECT ${messageFields} FROM chat_messages m JOIN chats c ON c.id = m.chat_id
    WHERE c.id = ? AND c.user_id = ? ORDER BY m.sequence DESC LIMIT 20`).bind(id, owner).all();
  let remaining = 20000;
  const history = [];
  for (const message of results) {
    if (message.content.length > remaining) break;
    history.push({ role: message.role, content: message.content });
    remaining -= message.content.length;
  }
  return history.reverse();
}

/** A D1 batch commits the complete turn atomically, rechecking ownership in each statement. */
export async function saveChatMessages(db, owner, chatId, messages) {
  const now = new Date().toISOString();
  const stored = messages.map(message => ({ id: `msg_${crypto.randomUUID()}`, ...message, createdAt: now }));
  const statements = stored.map(message => db.prepare(`INSERT INTO chat_messages (id, chat_id, role, content, metadata, created_at)
    SELECT ?, id, ?, ?, ?, ? FROM chats WHERE id = ? AND user_id = ?`).bind(
      message.id, message.role, message.content, message.metadata ? JSON.stringify(message.metadata) : null, now, chatId, owner,
    ));
  statements.push(db.prepare('UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?').bind(now, chatId, owner));
  const result = await db.batch(statements);
  if (!result[0].meta.changes) return null;
  const { results } = await db.prepare(`SELECT ${messageFields} FROM chat_messages m JOIN chats c ON c.id = m.chat_id
    WHERE c.id = ? AND c.user_id = ? AND m.id IN (${stored.map(() => '?').join(',')}) ORDER BY m.sequence`).bind(chatId, owner, ...stored.map(m => m.id)).all();
  return results.map(messageFromRow);
}

export function mountChatRoutes(app) {
  app.use('/api/chats', limitChatBody);
  app.use('/api/chats/*', limitChatBody);
  app.post('/api/chats', async (c) => {
    const body = await readBody(c);
    if (!body) return invalid(c, 'Body must be a JSON object');
    const title = body.title === undefined ? 'New chat' : typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 120) return invalid(c, 'title must be 1–120 characters');
    if (body.eventId !== undefined && (typeof body.eventId !== 'string' || !ID_RE.test(body.eventId))) return invalid(c, 'Invalid eventId');
    if (body.eventId && !await getEvent(c.env.DB, body.eventId)) return c.json({ error: 'not_found', message: 'Event not found' }, 404);
    const id = `chat_${crypto.randomUUID()}`;
    const owner = c.get('auth0User').sub;
    const now = new Date().toISOString();
    await c.env.DB.prepare('INSERT INTO chats (id, user_id, event_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, owner, body.eventId ?? null, title, now, now).run();
    return c.json({ chat: await getChat(c.env.DB, owner, id) }, 201);
  });

  app.get('/api/chats', async (c) => {
    const limit = integer(c.req.query('limit'), 20, 1, 100);
    const page = integer(c.req.query('page'), 1, 1, 10000);
    if (limit === null || page === null) return invalid(c, 'limit must be 1–100 and page 1–10000');
    const { results } = await c.env.DB.prepare(`SELECT ${chatFields} FROM chats WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .bind(c.get('auth0User').sub, limit + 1, (page - 1) * limit).all();
    return c.json({ chats: results.slice(0, limit), hasMore: results.length > limit });
  });

  app.use('/api/chats/:id/*', async (c, next) => {
    if (!ID_RE.test(c.req.param('id'))) return invalid(c, 'Invalid chat id');
    const chat = await getChat(c.env.DB, c.get('auth0User').sub, c.req.param('id'));
    if (!chat) return notFound(c);
    c.set('chat', chat);
    return next();
  });
  app.get('/api/chats/:id', async (c) => {
    if (!ID_RE.test(c.req.param('id'))) return invalid(c, 'Invalid chat id');
    const chat = await getChat(c.env.DB, c.get('auth0User').sub, c.req.param('id'));
    return chat ? c.json({ chat }) : notFound(c);
  });
  app.get('/api/chats/:id/messages', async (c) => {
    const limit = integer(c.req.query('limit'), 50, 1, 100);
    const after = integer(c.req.query('after'), 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || after === null) return invalid(c, 'Invalid message pagination');
    const { results } = await c.env.DB.prepare(`SELECT ${messageFields} FROM chat_messages m JOIN chats c ON c.id = m.chat_id
      WHERE c.id = ? AND c.user_id = ? AND m.sequence > ? ORDER BY m.sequence LIMIT ?`)
      .bind(c.req.param('id'), c.get('auth0User').sub, after, limit + 1).all();
    const messages = results.slice(0, limit).map(messageFromRow);
    return c.json({ messages, nextAfter: messages.at(-1)?.sequence ?? after, hasMore: results.length > limit });
  });
  app.post('/api/chats/:id/messages', async (c) => {
    const body = await readBody(c);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content || content.length > 8000 || (body.role !== undefined && body.role !== 'user')) return invalid(c, 'content must be 1–8000 characters; only user messages may be submitted');
    const messages = await saveChatMessages(c.env.DB, c.get('auth0User').sub, c.req.param('id'), [{ role: 'user', content }]);
    return messages?.length ? c.json({ message: messages[0] }, 201) : notFound(c);
  });
}
