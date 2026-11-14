// User-session access policy and replay-room state. Auth0 verifies identity; D1 persists
// owned chats across login sessions. Replay playback state remains independent.

/** Pure route policy shared by authentication and tests. Unknown chat subroutes stay private. */
export function sessionAccess(method, path) {
  const chat = path === '/api/chats' || path.startsWith('/api/chats/');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return {
    required: chat || (method === 'POST' && ['/api/ingest', '/api/events/earthquake', '/api/ask'].includes(path)),
    write,
  };
}

export const ROOM_CODE_RE = /^[A-Z0-9]{4,12}$/;
export const MAX_MESSAGE_BYTES = 4096;
export const SPEED_LIMITS = Object.freeze({ min: 0.25, max: 8 });
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function normalizeRoomCode(code) {
  const upper = String(code ?? '').trim().toUpperCase();
  return ROOM_CODE_RE.test(upper) ? upper : null;
}

export function generateRoomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function initialState(now = Date.now()) {
  return { eventId: null, layer: null, frame: 0, playing: false, speed: 1, updatedAt: now, version: 0 };
}

/**
 * Apply a client message to the room state.
 * Returns { state, broadcast } on success or { error } for invalid input.
 * `broadcast: false` means the reply goes only to the sender (sync/ping).
 */
export function applyMessage(state, msg, now = Date.now()) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return { error: 'message must be an object with a string "type"' };
  const next = (patch) => ({ state: { ...state, ...patch, updatedAt: now, version: state.version + 1 }, broadcast: true });

  switch (msg.type) {
    case 'load':
      if (!ID_RE.test(msg.eventId ?? '')) return { error: 'load requires a valid eventId' };
      if (msg.layer != null && !ID_RE.test(msg.layer)) return { error: 'invalid layer' };
      return next({ eventId: msg.eventId, layer: msg.layer ?? null, frame: 0, playing: false });
    case 'play':
      if (!state.eventId) return { error: 'load an event before playing' };
      return next({ playing: true });
    case 'pause':
      return next({ playing: false, frame: Number.isInteger(msg.frame) && msg.frame >= 0 ? msg.frame : state.frame });
    case 'seek':
      if (!Number.isInteger(msg.frame) || msg.frame < 0 || msg.frame > 100000) return { error: 'seek requires a non-negative integer frame' };
      return next({ frame: msg.frame });
    case 'speed':
      if (typeof msg.speed !== 'number' || msg.speed < SPEED_LIMITS.min || msg.speed > SPEED_LIMITS.max)
        return { error: `speed must be between ${SPEED_LIMITS.min} and ${SPEED_LIMITS.max}` };
      return next({ speed: msg.speed });
    case 'layer':
      if (!ID_RE.test(msg.layer ?? '')) return { error: 'layer requires a valid layer id' };
      return next({ layer: msg.layer });
    case 'sync':
    case 'ping':
      return { state, broadcast: false };
    default:
      return { error: `unknown message type "${msg.type}"` };
  }
}

export function parseClientMessage(raw) {
  if (typeof raw !== 'string') return { error: 'binary messages are not supported' };
  if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) return { error: 'message too large' };
  try {
    return { msg: JSON.parse(raw) };
  } catch {
    return { error: 'message is not valid JSON' };
  }
}
