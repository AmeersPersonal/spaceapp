import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../js/api.js';

const { api, ApiError } = client;
const bbox = [130, 32, 131, 33];
const start = '2026-01-01';
const end = '2026-02-01';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mockFetch(t, respond = () => json({ ok: true })) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', (path, options) => {
    calls.push({ path, options });
    return respond(path, options, calls.length);
  });
  return calls;
}

function mockTimers(t) {
  const timers = new Map();
  let next = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const handle = ++next;
    timers.set(handle, { callback, delay });
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => timers.delete(handle));
  return timers;
}

beforeEach(() => client.clearApiCache?.());

const publicReads = [
  ['catalog', () => api.events(), 60_000],
  ['event detail', () => api.event('quake/1'), 30_000],
  ['NISAR discovery', () => api.nisarSearch(bbox, start, end), 60_000],
  ['earthquake discovery', () => api.quakes(bbox, start, end), 60_000],
  ['event context', () => api.context('quake/1'), 300_000],
  ['dataset context', () => api.datasetContext(bbox, start, end), 300_000],
  ['outlook', () => api.outlook(bbox), 300_000],
  ['projection', () => api.predict('quake/1'), 300_000],
  ['media', () => api.media('quake/1'), 300_000],
  ['AI summary GET', () => api.summary('quake/1'), 300_000],
];

for (const [name, read, ttl] of publicReads) {
  test(`${name} reuses public results until its TTL expires`, async (t) => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
    assert.deepEqual(await read(), { revision: 1 });
    now += ttl - 1;
    assert.deepEqual(await read(), { revision: 1 });
    assert.equal(calls.length, 1, 'a cached public read must not use another Worker request');
    now++;
    assert.deepEqual(await read(), { revision: 2 });
    assert.equal(calls.length, 2);
  });
}

test('concurrent public reads share one in-flight HTTP request', async (t) => {
  const pending = deferred();
  const calls = mockFetch(t, () => pending.promise);
  const first = api.event('one');
  const second = api.event('one');
  assert.equal(calls.length, 1);
  pending.resolve(json({ event: { id: 'one' }, scenes: [] }));
  assert.deepEqual(await first, await second);
});

test('discovery cache keys include the full query', async (t) => {
  const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
  assert.deepEqual(await api.quakes(bbox, start, end, 4.5), { revision: 1 });
  assert.deepEqual(await api.quakes(bbox, start, end, 5), { revision: 2 });
  assert.deepEqual(await api.quakes(bbox, start, end, 4.5), { revision: 1 });
  assert.equal(calls.length, 2);
});

test('catalog and detail allow explicit fresh reads', async (t) => {
  const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
  assert.deepEqual(await api.events(), { revision: 1 });
  assert.deepEqual(await api.events({ fresh: true }), { revision: 2 });
  assert.deepEqual(await api.events(), { revision: 2 });
  assert.deepEqual(await api.event('one'), { revision: 3 });
  assert.deepEqual(await api.event('one', { fresh: true }), { revision: 4 });
  assert.deepEqual(await api.event('one'), { revision: 4 });
  assert.equal(calls.length, 4);
});

test('public cache retains at most 64 response entries', async (t) => {
  const calls = mockFetch(t);
  for (let n = 0; n < 65; n++) await api.event(`event-${n}`);
  await api.event('event-64');
  assert.equal(calls.length, 65);
  await api.event('event-0');
  assert.equal(calls.length, 66, 'the oldest public response must have been evicted');
});

test('session, owned chat, and ingest reads are neither cached nor deduplicated', async (t) => {
  const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
  const privateReads = [() => api.me(), () => api.chats(), () => api.chatMessages('mine'), () => api.ingestStatus('running')];
  for (const read of privateReads) {
    const before = calls.length;
    const [first, second] = await Promise.all([read(), read()]);
    assert.notDeepEqual(first, second);
    await read();
    assert.equal(calls.length - before, 3);
  }
});

test('POST requests keep their payloads and are never cached or deduplicated', async (t) => {
  const calls = mockFetch(t);
  const area = { aoi: bbox, dateRange: { start, end }, name: 'Area', type: 'other' };
  const writes = [
    [() => api.trackArea(area), '/api/ingest', area],
    [() => api.trackQuake('us123'), '/api/events/earthquake', { usgsId: 'us123' }],
    [() => api.ask('event', 'What changed?', 'chat'), '/api/ask', { eventId: 'event', question: 'What changed?', chatId: 'chat' }],
    [() => api.createChat('event', 'Title'), '/api/chats', { eventId: 'event', title: 'Title' }],
  ];
  for (const [write, path, body] of writes) {
    const before = calls.length;
    await Promise.all([write(), write()]);
    assert.equal(calls.length - before, 2);
    for (const call of calls.slice(before)) {
      assert.equal(call.path, path);
      assert.equal(call.options.method, 'POST');
      assert.deepEqual(JSON.parse(call.options.body), body);
      assert.equal(call.options.credentials, 'include');
      assert.equal(call.options.headers['Content-Type'], 'application/json');
    }
  }
});

for (const [name, write] of [
  ['trackArea', () => api.trackArea({ aoi: bbox })],
  ['trackQuake', () => api.trackQuake('us123')],
]) {
  test(`${name} invalidates catalog and public evidence`, async (t) => {
    const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
    await api.events();
    await api.event('one');
    await api.context('one');
    await write();
    assert.deepEqual(await api.events(), { revision: 5 });
    assert.deepEqual(await api.event('one'), { revision: 6 });
    assert.deepEqual(await api.context('one'), { revision: 7 });
    assert.equal(calls.length, 7);
  });
}

test('tracking invalidation prevents old pending reads from restoring stale public data', async (t) => {
  const pending = deferred();
  const current = deferred();
  const calls = mockFetch(t, (path, options, count) => count === 1 ? pending.promise : count === 3 ? current.promise : json({ revision: count }));
  const oldRead = api.events();
  await api.trackQuake('us123');
  const currentRead = api.events();
  assert.equal(calls.length, 3, 'new reads must not join the invalidated in-flight request');
  pending.resolve(json({ revision: 1 }));
  assert.deepEqual(await oldRead, { revision: 1 });
  const duplicateRead = api.events();
  assert.equal(calls.length, 3, 'old cleanup must not remove a newer pending request');
  current.resolve(json({ revision: 3 }));
  assert.deepEqual(await currentRead, { revision: 3 });
  assert.deepEqual(await duplicateRead, { revision: 3 });
  assert.deepEqual(await api.events(), { revision: 3 });
  assert.equal(calls.length, 3);
});

test('manual refresh clears every public response without changing the API facade', async (t) => {
  const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
  await api.events();
  await api.context('one');
  client.clearApiCache();
  assert.deepEqual(await api.events(), { revision: 3 });
  assert.deepEqual(await api.context('one'), { revision: 4 });
  assert.equal(calls.length, 4);
});

test('unlisted GET routes are private by default', async (t) => {
  const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
  for (const path of ['/api/profile', '/api/account', '/api/events/one/private']) {
    const before = calls.length;
    await Promise.all([client.request(path), client.request(path)]);
    await client.request(path);
    assert.equal(calls.length - before, 3);
  }
});

test('Ask and chat writes preserve the public catalog cache', async (t) => {
  const calls = mockFetch(t, (path, options, count) => json({ revision: count }));
  await api.events();
  await api.ask('one', 'Question');
  await api.createChat('one', 'Title');
  assert.deepEqual(await api.events(), { revision: 1 });
  assert.equal(calls.length, 3);
});

test('GETs include session credentials and an explicit JSON accept header', async (t) => {
  const calls = mockFetch(t);
  await api.events();
  assert.equal(calls[0].path, '/api/events');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers.accept, 'application/json');
});

test('failed public requests are not cached and release their in-flight entry', async (t) => {
  const calls = mockFetch(t, (path, options, count) => count === 1
    ? json({ error: 'unavailable', message: 'Catalog temporarily unavailable' }, 503)
    : json({ events: [] }));
  await assert.rejects(api.events(), (error) => error instanceof ApiError && error.status === 503 && error.message === 'Catalog temporarily unavailable');
  assert.equal(calls.length, 1, 'failed requests must not automatically retry');
  assert.deepEqual(await api.events(), { events: [] });
  assert.equal(calls.length, 2);
});

test('rate limits report Retry-After and never automatically retry writes', async (t) => {
  const calls = mockFetch(t, () => json({ error: 'rate_limited' }, 429, { 'Retry-After': '42' }));
  await assert.rejects(api.ask('one', 'Question'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'rate_limited');
    assert.match(error.message, /rate limit|too many requests/i);
    assert.match(error.message, /42/);
    assert.equal(error.retryAfter, '42');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('a non-JSON rate-limit response still gives a helpful Retry-After error', async (t) => {
  mockFetch(t, () => new Response('<html>Slow down</html>', { status: 429, headers: { 'Retry-After': 'Sun, 15 Nov 2026 15:00:00 GMT' } }));
  await assert.rejects(api.events(), (error) => error.status === 429 && /rate limit|too many requests/i.test(error.message) && /15:00:00/.test(error.message));
});

test('malformed successful responses are errors and do not poison later reads', async (t) => {
  const calls = mockFetch(t, (path, options, count) => count === 1
    ? new Response('<html>Wrong server</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    : json({ events: [] }));
  await assert.rejects(api.events(), (error) => error instanceof ApiError && error.code === 'bad_json');
  assert.deepEqual(await api.events(), { events: [] });
  assert.equal(calls.length, 2);
});

test('successful JSON primitives and arrays are rejected instead of cached as API envelopes', async (t) => {
  const payloads = [null, false, 42, 'Wrong server', [], [{ events: [] }]];
  const calls = mockFetch(t, (path, options, count) => json(payloads[count - 1]));
  for (const value of payloads) {
    await assert.rejects(api.events(), (error) => error instanceof ApiError && error.code === 'bad_json', `invalid API envelope: ${value}`);
  }
  assert.equal(calls.length, 6);
});

test('network aborts release deduplication so the next request can succeed', async (t) => {
  const calls = mockFetch(t, (path, options, count) => count === 1
    ? Promise.reject(new DOMException('Aborted', 'AbortError'))
    : json({ events: [] }));
  await assert.rejects(api.events(), (error) => error instanceof ApiError && error.code === 'aborted');
  assert.deepEqual(await api.events(), { events: [] });
  assert.equal(calls.length, 2);
});

test('a network timeout aborts the HTTP request and releases the pending read', async (t) => {
  const timers = mockTimers(t);
  const calls = mockFetch(t, (path, options, count) => count === 1 ? new Promise(() => {}) : json({ events: [] }));
  const read = api.events({ timeoutMs: 25 });
  const rejection = assert.rejects(read, (error) => error instanceof ApiError && error.code === 'timeout');
  assert.equal(timers.size, 1, 'every HTTP request must have a timeout');
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 25);
  timer.callback();
  await rejection;
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.deepEqual(await api.events(), { events: [] });
  assert.equal(calls.length, 2);
});

test('the timeout also covers a stalled response JSON body', async (t) => {
  const timers = mockTimers(t);
  mockFetch(t, () => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) }));
  const read = api.event('slow-body', { timeoutMs: 50 });
  const rejection = assert.rejects(read, (error) => error instanceof ApiError && error.code === 'timeout');
  await Promise.resolve();
  assert.equal(timers.size, 1, 'the timeout must remain active while parsing the response');
  [...timers.values()][0].callback();
  await rejection;
  assert.equal(timers.size, 0);
});

test('a late response after timeout cannot replace a newer cached result', async (t) => {
  const timers = mockTimers(t);
  const late = deferred();
  const calls = mockFetch(t, (path, options, count) => count === 1 ? late.promise : json({ revision: count }));
  const timedOut = assert.rejects(api.events({ timeoutMs: 25 }), (error) => error.code === 'timeout');
  [...timers.values()][0].callback();
  await timedOut;
  assert.deepEqual(await api.events(), { revision: 2 });
  late.resolve(json({ revision: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await api.events(), { revision: 2 });
  assert.equal(calls.length, 2);
  assert.equal(timers.size, 0);
});

test('GET and POST requests use bounded default timeouts and clean up their timers', async (t) => {
  const timers = mockTimers(t);
  const pendingRead = deferred();
  const pendingWrite = deferred();
  mockFetch(t, (path, options) => options.method === 'GET' ? pendingRead.promise : pendingWrite.promise);
  const read = api.events();
  const write = api.ask('one', 'Question');
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [20_000, 60_000]);
  pendingRead.resolve(json({ events: [] }));
  pendingWrite.resolve(json({ answer: 'AI-generated fixture' }));
  assert.deepEqual(await Promise.all([read, write]), [{ events: [] }, { answer: 'AI-generated fixture' }]);
  assert.equal(timers.size, 0);
});
