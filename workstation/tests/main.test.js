import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as roomModule from '../js/room.js';

// Exercise the existing orchestration with a deterministic API and no DOM/network.
const source = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing orchestration section: ${start}`);
  return source.slice(a, b);
}

test('asking while saved history is loading does not create or overwrite a conversation', async () => {
  let calls = 0;
  const state = {
    api: { auth: 'signed-in' },
    live: { eventId: 'event', replay: null, ask: { turns: [], chatId: null, busy: false, history: 'loading' } },
  };
  const context = {
    state, liveSeq: 1, render() {}, markSignedOut() {}, COPY: { sessionEnded: 'ended' },
    el: { liveAskInput: { value: 'A new question' } },
    api: {
      createChat: async () => { calls++; return { chat: { id: 'new-chat' } }; },
      ask: async () => { calls++; return { answer: 'New answer', chatId: 'new-chat' }; },
    },
  };
  vm.createContext(context);
  vm.runInContext(section('async function askQuestion(', '\nfunction exploreAt('), context);
  await context.askQuestion('A new question');
  assert.equal(calls, 0);
  assert.equal(state.live.ask.chatId, null);
  assert.equal(state.live.ask.turns.length, 0);
});

test('a late room join uses elapsed server playback time rather than the stored frame', () => {
  const state = { source: 'live', playing: false, live: { eventId: 'event', idx: 0, replay: null, room: { status: 'open' } } };
  const context = {
    state, room: { open: true, send() {} }, liveView: () => ({ len: 10 }),
    startPlaying() { state.playing = true; }, stopPlaying() { state.playing = false; },
    render() {}, selectLiveEvent() {}, replayFrameAt: roomModule.replayFrameAt,
    Date, performance: { now: () => 100 },
  };
  vm.createContext(context);
  vm.runInContext(section('function applyRoomState(', '\nfunction leaveRoom('), context);
  context.applyRoomState({ eventId: 'event', frame: 1, playing: true, speed: 1, updatedAt: 1000 }, 4500);
  assert.equal(state.live.idx, 4);
  assert.equal(state.playing, true);
});

test('a pending history response cannot apply after the selected event changes', async () => {
  let resolveMessages;
  const state = { live: { ask: { turns: [], chatId: null } } };
  const context = {
    state, liveSeq: 1, render() {}, markSignedOut() {},
    api: {
      chats: async () => ({ chats: [{ id: 'old-chat', eventId: 'event' }] }),
      chatMessages: () => new Promise(resolve => { resolveMessages = resolve; }),
    },
  };
  vm.createContext(context);
  vm.runInContext(section('async function loadChatHistory(', '\nasync function askQuestion('), context);
  const pending = context.loadChatHistory('event', 1);
  await new Promise(setImmediate);
  context.liveSeq = 2;
  state.live.ask = { turns: [{ question: 'Current', answer: 'Keep this' }], chatId: 'current-chat' };
  resolveMessages({ messages: [{ role: 'user', content: 'Old' }, { role: 'assistant', content: 'Stale' }] });
  await pending;
  assert.equal(state.live.ask.chatId, 'current-chat');
  assert.equal(state.live.ask.turns[0].answer, 'Keep this');
});

test('rapid area changes issue one set of requests for the final selected area', async () => {
  const calls = [], timers = new Map();
  let serial = 0;
  const state = { source: 'live', live: { area: { id: 'first', bbox: [0, 0, 1, 1] }, range: { start: '2026-10-01', end: '2026-11-01' } } };
  const record = name => async bbox => { calls.push({ name, bbox }); return {}; };
  const context = {
    state, areaQueryTimer: null, render() {}, st: (status, extra) => ({ status, ...extra }),
    setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    api: { nisarSearch: record('nisar'), quakes: record('quakes'), datasetContext: record('context') },
  };
  vm.createContext(context);
  vm.runInContext(section('function runAreaQueries(', '\nasync function liveAction('), context);
  context.runAreaQueries();
  state.live.area = { id: 'last', bbox: [2, 2, 3, 3] };
  context.runAreaQueries();
  assert.equal(calls.length, 0, 'defer queries while the viewer changes the area');
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.bbox[0] === 2));
});

test('repeated refresh clicks share one catalog and detail refresh', async () => {
  let release, loads = 0, details = 0;
  const state = { live: { eventId: 'event', events: { status: 'done', list: [] }, detail: { status: 'done' }, idx: 0, ask: {}, replay: null } };
  const context = {
    state, liveSeq: 1, render() {}, clearApiCache() {},
    st: (status, extra) => ({ status, ...extra }), liveTimeline: () => ({ steps: [1, 2] }),
    loadLiveEvents: () => { loads++; return new Promise(resolve => { release = resolve; }); },
    api: { event: async () => { details++; return { event: { id: 'event' }, scenes: [], layers: [] }; } },
  };
  vm.createContext(context);
  vm.runInContext(section('async function refreshLiveCatalog(', '\nasync function selectLiveEvent('), context);
  const first = context.refreshLiveCatalog();
  const second = context.refreshLiveCatalog();
  assert.equal(loads, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(details, 1);
  assert.equal(state.live.refreshing, false);
});

test('preview loading is limited to neighbouring passes and releases evicted blobs', async () => {
  const calls = [], revoked = [];
  const timeline = { mode: 'preview', steps: Array.from({ length: 10 }, (_, i) => ({ scenes: [{ id: `s${i}`, browseUrl: `preview-${i}`, bounds: [0, 0, 1, 1] }] })) };
  const browse = new Map(Array.from({ length: 65 }, (_, i) => [`old-${i}`, { status: 'ready', url: `blob:old-${i}` }]));
  const context = {
    state: { source: 'live', live: { idx: 5 } }, cache: { browse }, sceneKey: s => s.id,
    loadBrowseImage: async url => { calls.push(url); return { url: `blob:${url}`, coordinates: [] }; },
    liveView: () => ({ tl: timeline, idx: 5 }), render() {}, URL: { revokeObjectURL: url => revoked.push(url) },
  };
  vm.createContext(context);
  vm.runInContext(section('function ensureBrowseImages(', '\nfunction fitLive('), context);
  context.ensureBrowseImages(timeline, 5);
  await new Promise(setImmediate);
  assert.deepEqual(calls.sort(), ['preview-4', 'preview-5', 'preview-6']);
  assert.ok(browse.size <= 64);
  assert.ok(revoked.length > 0);
  context.ensureBrowseImages(timeline, 5);
  assert.equal(calls.length, 3);
});
