// Test-only envelopes follow backend/cloudefare/SPEC.md. No upstream fetches.
import { deflateSync } from 'node:zlib';

export const dates = ['2026-10-02', '2026-10-14', '2026-10-26'];
export const credit = 'OFFLINE TEST FIXTURE — NOT SATELLITE DATA';
const bbox = [130.98, 32.79, 131.23, 32.97];
const events = [
  { id: 'fixture-ready', name: 'TEST ONLY · Ready event', type: 'earthquake' },
  { id: 'fixture-awaiting', name: 'TEST ONLY · Awaiting processor', type: 'flood' },
].map(event => ({ ...event, bbox, products: ['GCOV'], startDate: dates[0], endDate: dates[2], watch: false, sceneCount: 3, description: credit }));

function detail(event) {
  const ready = event.id === 'fixture-ready';
  return {
    event,
    scenes: dates.map((date, index) => ({
      id: `${event.id}-scene-${index}`, eventId: event.id, product: 'GCOV',
      acquiredAt: `${date}T00:00:00Z`, polarization: 'HH', status: ready ? 'ready' : 'awaiting_processor',
      browseUrl: `/__fixture/preview/${event.id}/${date}.png`, bounds: bbox,
      url: null, error: null, stats: null,
    })),
    dates, polarizations: ['HH'], captions: [], credit,
    layers: ready ? dates.map(date => ({
      layer: 'gcov_hh_db', date, minZoom: 0, maxZoom: 12, bounds: bbox, units: 'dB',
      tiles: `/tiles/${event.id}/gcov_hh_db/${date}/{z}/{x}/{y}.png`,
    })) : [],
  };
}

// A tiny opaque PNG generated with Node only, used for both previews and tiles.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const header = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, checksum]);
}
const size = 32;
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = (x + y) % 8 < 4 ? 180 : 70;
  pixels[offset + 3] = 255;
}
export const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);

export function createFixtures() {
  const requests = [];
  const held = [];
  const chats = [{ id: 'fixture-saved-chat', eventId: events[0].id, title: 'TEST ONLY · Saved conversation', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' }];
  const messages = new Map([[chats[0].id, [
    { id: 'fixture-user-1', sequence: 1, role: 'user', content: 'TEST ONLY · Saved question', metadata: null, createdAt: '2026-10-26T00:00:00Z' },
    { id: 'fixture-assistant-1', sequence: 2, role: 'assistant', content: 'TEST ONLY · Restored answer', metadata: null, createdAt: '2026-10-26T00:00:01Z' },
  ]]]);
  const state = {
    mode: 'normal', holdHistory: true, rateLimitAsk: false, requests,
    releaseHistory() { state.holdHistory = false; for (const resume of held.splice(0)) resume(); },
    count(method, path) { return requests.filter(row => row.method === method && row.path === path).length; },
    async route(req, res) {
      const url = new URL(req.url, 'http://fixture.invalid');
      const path = url.pathname;
      if (!/^\/(api|auth|tiles|__fixture\/preview)(\/|$)/.test(path)) return false;
      let body;
      if (req.method === 'POST') {
        let raw = '';
        for await (const part of req) raw += part;
        body = JSON.parse(raw);
      }
      requests.push({ method: req.method, path, query: url.search, body });
      const send = (data, status = 200, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(data));
      };
      if (path.startsWith('/tiles/') || path.startsWith('/__fixture/preview/')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(png); return true;
      }
      if (path.startsWith('/auth/')) { send({ error: 'fixture_auth', message: 'TEST ONLY · Authentication navigation intercepted' }, 401); return true; }
      if (path === '/api/events') {
        if (state.mode === 'offline') send({ error: 'fixture_unavailable', message: 'TEST ONLY · Catalog unavailable (503)' }, 503);
        else if (state.mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end('<html>TEST ONLY · Wrong server</html>'); }
        else send({ events, credit });
        return true;
      }
      if (path === '/api/auth/me') { send({ user: { sub: 'fixture-user', name: 'TEST ONLY · Local user', email: 'fixture@example.invalid' } }); return true; }
      const match = /^\/api\/events\/([^/]+)(?:\/(context|media))?$/.exec(path);
      if (match) {
        const event = events.find(item => item.id === match[1]);
        if (!event) send({ error: 'not_found' }, 404);
        else if (match[2] === 'context') send({ eventId: event.id, fetchedAt: '2026-10-26T00:00:00Z', sources: [], credit });
        else if (match[2] === 'media') send({ eventId: event.id, images: [], photos: [], photoQuery: 'TEST ONLY', links: [], note: credit, credit });
        else send(detail(event));
        return true;
      }
      if (path === '/api/chats' && req.method === 'GET') {
        if (state.holdHistory) await new Promise(resolve => held.push(resolve));
        send({ chats, hasMore: false }); return true;
      }
      if (path === '/api/chats' && req.method === 'POST') {
        const chat = { id: 'fixture-created-chat', ...body, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
        chats.push(chat); messages.set(chat.id, []); send({ chat }, 201); return true;
      }
      const messageMatch = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
      if (messageMatch) { send({ messages: messages.get(messageMatch[1]) || [], nextAfter: null, hasMore: false }); return true; }
      if (path === '/api/ask') {
        if (state.rateLimitAsk) send({ error: 'rate_limited', message: 'TEST ONLY · AI rate limit reached' }, 429, { 'Retry-After': '42' });
        else {
          const answer = 'TEST ONLY · Saved fixture answer';
          const list = messages.get(body.chatId);
          if (list) list.push({ id: 'fixture-user-2', sequence: list.length + 1, role: 'user', content: body.question, metadata: null, createdAt: '2026-10-26T00:00:02Z' }, { id: 'fixture-assistant-2', sequence: list.length + 2, role: 'assistant', content: answer, metadata: null, createdAt: '2026-10-26T00:00:03Z' });
          send({ answer, chatId: body.chatId, messageIds: ['fixture-user-2', 'fixture-assistant-2'], sources: [], sceneCount: 3, model: 'fixture-only', aiGenerated: true, disclaimer: credit, credit });
        }
        return true;
      }
      send({ error: 'unexpected_fixture_request', message: `Unhandled offline fixture: ${req.method} ${path}` }, 404);
      return true;
    },
  };
  return state;
}
