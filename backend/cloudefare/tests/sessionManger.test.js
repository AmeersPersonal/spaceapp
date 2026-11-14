import { describe, expect, it } from 'vitest';
import { applyMessage, generateRoomCode, initialState, normalizeRoomCode, parseClientMessage } from '../sessionManger.js';

describe('room codes', () => {
  it('normalizes valid codes and rejects bad ones', () => {
    expect(normalizeRoomCode(' abcd12 ')).toBe('ABCD12');
    expect(normalizeRoomCode('abc')).toBeNull();
    expect(normalizeRoomCode('ABCDEFGHIJKLM')).toBeNull();
    expect(normalizeRoomCode('AB-CD')).toBeNull();
    expect(normalizeRoomCode(undefined)).toBeNull();
  });
  it('generates valid codes', () => {
    for (let i = 0; i < 20; i++) expect(normalizeRoomCode(generateRoomCode())).not.toBeNull();
  });
});

describe('applyMessage', () => {
  const s0 = initialState(0);

  it('loads an event and resets playback', () => {
    const { state, broadcast } = applyMessage({ ...s0, frame: 9, playing: true }, { type: 'load', eventId: 'evt-1', layer: 'hh' }, 5);
    expect(broadcast).toBe(true);
    expect(state).toMatchObject({ eventId: 'evt-1', layer: 'hh', frame: 0, playing: false, updatedAt: 5, version: 1 });
  });

  it('plays, pauses at a frame, seeks and changes speed', () => {
    let { state } = applyMessage(s0, { type: 'load', eventId: 'e' });
    ({ state } = applyMessage(state, { type: 'play' }));
    expect(state.playing).toBe(true);
    ({ state } = applyMessage(state, { type: 'pause', frame: 3 }));
    expect(state).toMatchObject({ playing: false, frame: 3 });
    ({ state } = applyMessage(state, { type: 'seek', frame: 7 }));
    expect(state.frame).toBe(7);
    ({ state } = applyMessage(state, { type: 'speed', speed: 2 }));
    expect(state.speed).toBe(2);
    expect(state.version).toBe(5);
  });

  it('rejects invalid messages', () => {
    expect(applyMessage(s0, null).error).toBeTruthy();
    expect(applyMessage(s0, { type: 'play' }).error).toMatch(/load an event/);
    expect(applyMessage(s0, { type: 'seek', frame: -1 }).error).toBeTruthy();
    expect(applyMessage(s0, { type: 'seek', frame: 1.5 }).error).toBeTruthy();
    expect(applyMessage(s0, { type: 'speed', speed: 100 }).error).toBeTruthy();
    expect(applyMessage(s0, { type: 'load', eventId: '../etc' }).error).toBeTruthy();
    expect(applyMessage(s0, { type: 'nope' }).error).toMatch(/unknown/);
  });

  it('sync/ping reply only to the sender without changing state', () => {
    const r = applyMessage(s0, { type: 'sync' });
    expect(r).toEqual({ state: s0, broadcast: false });
  });
});

describe('parseClientMessage', () => {
  it('parses JSON and rejects binary, oversized or invalid input', () => {
    expect(parseClientMessage('{"type":"play"}').msg).toEqual({ type: 'play' });
    expect(parseClientMessage(new ArrayBuffer(2)).error).toMatch(/binary/);
    expect(parseClientMessage('x'.repeat(5000)).error).toMatch(/too large/);
    expect(parseClientMessage('{oops').error).toMatch(/JSON/);
  });
});
