import assert from 'node:assert/strict';
import test from 'node:test';
import * as roomModule from '../js/room.js';

const { RoomClient } = roomModule;
const replayFrameAt = (...args) => {
  assert.equal(typeof roomModule.replayFrameAt, 'function', 'room.js exports replayFrameAt');
  return roomModule.replayFrameAt(...args);
};

test('late room joins advance from the snapshot using the explicit server clock', () => {
  const snapshot = { frame: 2, playing: true, speed: 1, updatedAt: 100000 };
  assert.equal(replayFrameAt(snapshot, 10, 103999), 5);
  assert.equal(replayFrameAt(snapshot, 10, 104000), 6);
  assert.equal(replayFrameAt(snapshot, 10, 99000), 2);
  assert.deepEqual(snapshot, { frame: 2, playing: true, speed: 1, updatedAt: 100000 });
});

test('playing room frames wrap and respect fractional or accelerated speed', () => {
  const cases = [
    { frame: 8, speed: 1, now: 103500, expected: 1 },
    { frame: 8, speed: 2, now: 103500, expected: 5 },
    { frame: 8, speed: 0.5, now: 103500, expected: 9 },
    { frame: 0, speed: 1, now: 130999, expected: 0 },
    { frame: 12, speed: 1, now: 100000, expected: 2 },
  ];
  for (const { frame, speed, now, expected } of cases) {
    assert.equal(replayFrameAt({ frame, speed, playing: true, updatedAt: 100000 }, 10, now), expected);
  }
});

test('paused room frames clamp to available observations without using elapsed time', () => {
  assert.equal(replayFrameAt({ frame: 20, playing: false, updatedAt: 100000 }, 10, 200000), 9);
  assert.equal(replayFrameAt({ frame: -3, playing: false }, 10, 200000), 0);
  assert.equal(replayFrameAt({ frame: 3.9 }, 10, 200000), 3);
});

test('replay frames have finite defaults for empty timelines and malformed snapshot fields', () => {
  for (const count of [0, -1, NaN, Infinity, undefined, '10', 0.5]) {
    assert.equal(replayFrameAt({ frame: 4, playing: true, updatedAt: 1000 }, count, 9000), 0);
  }
  for (const snapshot of [undefined, null, {}, { frame: NaN }, { frame: Infinity }, { frame: '3' }]) {
    assert.equal(replayFrameAt(snapshot, 5, 9000), 0);
  }
  for (const speed of [undefined, NaN, Infinity, 0, -1, '2']) {
    assert.equal(replayFrameAt({ frame: 1, playing: true, speed, updatedAt: 1000 }, 5, 3000), 3);
  }
  for (const updatedAt of [undefined, NaN, Infinity, '1000']) {
    assert.equal(replayFrameAt({ frame: 2, playing: true, updatedAt }, 5, 9000), 2);
  }
  for (const now of [undefined, NaN, Infinity, '9000']) {
    assert.equal(replayFrameAt({ frame: 2, playing: true, updatedAt: 1000 }, 5, now), 2);
  }
  assert.equal(replayFrameAt({ frame: 1, playing: 'true', updatedAt: 1000 }, 5, 9000), 1);
  assert.equal(replayFrameAt({ frame: Number.MAX_VALUE, playing: true, speed: Number.MAX_VALUE, updatedAt: 0 }, 5, Number.MAX_VALUE), 3);
});

function socketEnvironment(t) {
  const keys = ['window', 'WebSocket', 'setInterval', 'clearInterval'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const sockets = [];
  const timers = new Map();
  let nextTimer = 0;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    message(raw) { this.onmessage({ data: raw }); }
  }
  Object.assign(globalThis, {
    window: { location: { protocol: 'https:', host: 'workstation.example.test:8443' } },
    WebSocket: FakeWebSocket,
    setInterval(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { sockets, timers };
}

test('room state forwards the server timestamp over a same-origin session WebSocket', (t) => {
  const { sockets, timers } = socketEnvironment(t);
  const received = [];
  const client = new RoomClient({ onState: (...args) => received.push(args) });
  t.after(() => client.close());
  client.connect(' ab12 ');
  const ws = sockets[0];
  assert.equal(ws.url, 'wss://workstation.example.test:8443/api/room/AB12');
  assert.equal(client.send({ type: 'sync' }), false);
  ws.open();
  assert.equal(client.send({ type: 'seek', frame: 2 }), true);
  assert.deepEqual(ws.sent, [{ type: 'seek', frame: 2 }]);
  const snapshot = { eventId: 'event', layer: null, frame: 2, playing: true, speed: 1, updatedAt: 100000, version: 1 };
  ws.message(JSON.stringify({ type: 'state', state: snapshot, serverTime: 103500 }));
  assert.deepEqual(received, [[snapshot, 103500]]);
  const [{ fn, delay }] = timers.values();
  assert.equal(delay, 25000);
  fn();
  assert.deepEqual(ws.sent.at(-1), { type: 'ping' });
});

test('malformed room messages are ignored without breaking later state updates', (t) => {
  const { sockets } = socketEnvironment(t);
  const received = [];
  const client = new RoomClient({ onState: (...args) => received.push(args) });
  t.after(() => client.close());
  client.connect('AB12');
  const ws = sockets[0];
  for (const raw of ['{', 'null', 'false', '0', '"state"', '[]', '{}', '{"type":"state","state":[]}', '{"type":"state","state":"bad"}']) {
    assert.doesNotThrow(() => ws.message(raw));
  }
  assert.deepEqual(received, []);
  ws.message('{"type":"state","state":{"frame":1},"serverTime":1234}');
  assert.deepEqual(received, [[{ frame: 1 }, 1234]]);
});

test('socket errors and closes stop heartbeat timers without reconnecting', (t) => {
  const { sockets, timers } = socketEnvironment(t);
  const statuses = [];
  const client = new RoomClient({ onStatus: (status) => statuses.push(status) });
  t.after(() => client.close());
  client.connect('AB12');
  sockets[0].open();
  assert.equal(timers.size, 1);
  sockets[0].onerror();
  assert.equal(timers.size, 0);
  assert.equal(statuses.at(-1), 'error');
  sockets[0].onclose();
  assert.equal(client.open, false);
  assert.equal(statuses.at(-1), 'closed');
  assert.equal(sockets.length, 1);

  client.connect('CD34');
  sockets[1].open();
  assert.equal(timers.size, 1);
  sockets[1].onclose();
  assert.equal(timers.size, 0);
  assert.equal(sockets.length, 2);
});

test('late events and queued heartbeats from an old socket cannot affect a new room', (t) => {
  const { sockets, timers } = socketEnvironment(t);
  const received = [];
  const statuses = [];
  const client = new RoomClient({ onState: (...args) => received.push(args), onStatus: (status) => statuses.push(status) });
  t.after(() => client.close());
  client.connect('AB12');
  const old = sockets[0];
  old.open();
  const stalePing = [...timers.values()][0].fn;
  client.connect('CD34');
  const current = sockets[1];
  current.open();
  const statusCount = statuses.length;
  old.onopen();
  old.message('{"type":"state","state":{"frame":9},"serverTime":1}');
  old.onerror();
  old.onclose();
  stalePing();
  assert.equal(client.open, true);
  assert.equal(timers.size, 1);
  assert.equal(statuses.length, statusCount);
  assert.deepEqual(received, []);
  assert.deepEqual(current.sent, []);
  current.message('{"type":"state","state":{"frame":2},"serverTime":2}');
  assert.deepEqual(received, [[{ frame: 2 }, 2]]);
  client.close();
  assert.equal(timers.size, 0);
});

test('closing from an open-status handler does not leave a heartbeat running', (t) => {
  const { sockets, timers } = socketEnvironment(t);
  const client = new RoomClient({ onStatus(status) { if (status === 'open') client.close(); } });
  t.after(() => client.close());
  client.connect('AB12');
  sockets[0].open();
  assert.equal(client.open, false);
  assert.equal(timers.size, 0);
});
