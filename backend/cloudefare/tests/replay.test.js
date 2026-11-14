import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import worker from '../worker.js';

/** Open a WebSocket to a room through the Worker route and collect messages. */
async function connect(code) {
  const res = await worker.fetch(new Request(`https://api.test/api/room/${code}`, { headers: { upgrade: 'websocket' } }), env, createExecutionContext());
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  ws.accept();
  const next = (pred = () => true) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timed out waiting for message')), 3000);
    });
  };
  const send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  return { ws, next, send };
}

const ofType = (type, extra = () => true) => (m) => m.type === type && extra(m);

describe('WS /api/room/:code', () => {
  it('rejects bad codes and non-WebSocket requests', async () => {
    expect((await worker.fetch(new Request('https://api.test/api/room/ab'), env, createExecutionContext())).status).toBe(400);
    expect((await worker.fetch(new Request('https://api.test/api/room/ABCD'), env, createExecutionContext())).status).toBe(426);
  });

  it('sends state on join and broadcasts presence and playback changes to all members', async () => {
    const a = await connect('ROOM01');
    const first = await a.next(ofType('state'));
    expect(first.state).toMatchObject({ eventId: null, playing: false, frame: 0, version: 0 });
    expect(first.serverTime).toEqual(expect.any(Number));

    const b = await connect('room01'); // codes are case-insensitive
    await b.next(ofType('state'));
    expect((await a.next(ofType('presence', (m) => m.count === 2))).count).toBe(2);

    a.send({ type: 'load', eventId: 'baja-test', layer: 'vv-backscatter' });
    expect((await b.next(ofType('state', (m) => m.state.version === 1))).state).toMatchObject({ eventId: 'baja-test', layer: 'vv-backscatter' });
    b.send({ type: 'play' });
    expect((await a.next(ofType('state', (m) => m.state.version === 2))).state.playing).toBe(true);
    a.send({ type: 'seek', frame: 4 });
    expect((await b.next(ofType('state', (m) => m.state.version === 3))).state.frame).toBe(4);

    b.ws.close(1000, 'bye');
    expect((await a.next(ofType('presence', (m) => m.count === 1))).count).toBe(1);
    a.ws.close(1000, 'bye');
  });

  it('replies with errors for invalid messages without changing state, and answers sync/ping', async () => {
    const a = await connect('ROOM02');
    await a.next(ofType('state'));
    a.send('{bad json');
    expect((await a.next(ofType('error'))).error).toMatch(/JSON/);
    a.send({ type: 'play' });
    expect((await a.next(ofType('error'))).error).toMatch(/load an event/);
    a.send({ type: 'sync' });
    expect((await a.next(ofType('state'))).state.version).toBe(0);
    a.send({ type: 'ping' });
    expect(await a.next(ofType('pong'))).toEqual({ type: 'pong' });
    a.ws.close(1000);
  });

  it('persists state across reconnects and isolates rooms', async () => {
    const a = await connect('ROOM03');
    await a.next(ofType('state'));
    a.send({ type: 'load', eventId: 'evt-x' });
    await a.next(ofType('state', (m) => m.state.version === 1));
    a.ws.close(1000);

    const again = await connect('ROOM03');
    expect((await again.next(ofType('state'))).state.eventId).toBe('evt-x');
    const other = await connect('ROOM04');
    expect((await other.next(ofType('state'))).state.eventId).toBeNull();
    again.ws.close(1000);
    other.ws.close(1000);
  });

  it('clears an empty room when its cleanup alarm fires', async () => {
    const stub = env.REPLAY_ROOM.get(env.REPLAY_ROOM.idFromName('ROOM05'));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('state', { eventId: 'old', layer: null, frame: 2, playing: false, speed: 1, updatedAt: 0, version: 3 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.get('state')).toBeUndefined();
      expect(instance.state.eventId).toBeNull();
    });
  });
});
