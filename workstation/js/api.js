// api.js — the one place the workstation talks to the Earth Replay API
// (backend/cloudefare). No DOM. Imports nothing.
//
// Paths are relative: `npm run dev` (dev-server.mjs) proxies /api, /auth and
// /tiles to the Worker, so the browser sees one origin and the Auth0 session
// cookie travels with every request. A plain `python -m http.server` has no
// proxy, so every call fails with a clear 'network' / 404 error instead.
//
// Nothing here substitutes data on failure: callers get an ApiError and must
// show it. Mirrors Frontend/src/api.js (ported, not imported).

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const UNREACHABLE = 'Could not reach the API. Start it with `npm run dev` in backend/cloudefare and serve this page with `npm run dev`.';

// Only known public GETs are shared. Sessions, conversations, ingest progress
// and writes always use their own request and never enter either map.
const publicCache = new Map();
const inFlight = new Map();
let cacheGeneration = 0;

function publicTtl(path) {
  const pathname = path.split('?')[0];
  if (pathname === '/api/events') return 60_000;
  if (/^\/api\/events\/[^/]+$/.test(pathname)) return 30_000;
  if (pathname === '/api/nisar/search' || pathname === '/api/discover/earthquakes') return 60_000;
  if (pathname === '/api/datasets/context' || pathname === '/api/outlook'
    || /^\/api\/events\/[^/]+\/(context|media|predict|summary)$/.test(pathname)) return 300_000;
  return 0;
}

/** Clear public responses and detach pending reads from the next generation. */
export function clearApiCache() {
  cacheGeneration++;
  publicCache.clear();
  inFlight.clear();
}

/** Public GETs reuse results; fresh bypasses stored data, not an active read. */
export function request(path, { method = 'GET', body, fresh = false, timeoutMs = method === 'GET' ? 20_000 : 60_000 } = {}) {
  const ttl = method === 'GET' ? publicTtl(path) : 0;
  if (ttl) {
    const cached = publicCache.get(path);
    if (!fresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.data);
    if (cached && cached.expires <= Date.now()) publicCache.delete(path);
    if (inFlight.has(path)) return inFlight.get(path);
  }

  const generation = cacheGeneration;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(0, 'timeout', 'The API request timed out. The server may still be processing it.'));
      controller.abort();
    }, timeoutMs);
  });
  const operation = (async () => {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new ApiError(0, 'aborted', 'The API request was cancelled.');
      throw new ApiError(0, 'network', UNREACHABLE);
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      // The proxy answers 502 {error:'network'} when the Worker is down;
      // a static server with no proxy answers 404 with no JSON.
      const code = (data && data.error) || (response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'network' : response.status === 404 && !data ? 'no_proxy' : 'error');
      let message =
        (data && data.message) ||
        (data && Array.isArray(data.details) && data.details.join('; ')) ||
        (code === 'network'
          ? UNREACHABLE
          : code === 'no_proxy'
            ? 'No API proxy on this server. Serve the workstation with `npm run dev` (dev-server.mjs), not a plain static server.'
            : response.status === 429 ? 'API rate limit reached. Too many requests.' : `Request failed (${response.status})`);
      const retryAfter = response.headers.get('Retry-After');
      if (response.status === 429 && retryAfter) {
        message += /^\d+$/.test(retryAfter) ? ` Try again in ${retryAfter} seconds.` : ` Try again after ${retryAfter}.`;
      }
      const error = new ApiError(response.status, code, message);
      if (retryAfter) error.retryAfter = retryAfter;
      throw error;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(response.status, 'bad_json', 'The API returned a malformed or non-JSON response.');
    return data;
  })();

  // Race the entire operation, including body parsing. A stalled or aborted
  // fetch cannot retain a pending entry or populate the cache after timeout.
  const pending = Promise.race([operation, timeout]).then((data) => {
    if (ttl && generation === cacheGeneration) {
      publicCache.delete(path);
      publicCache.set(path, { data, expires: Date.now() + ttl });
      if (publicCache.size > 64) publicCache.delete(publicCache.keys().next().value);
    }
    return data;
  }).finally(() => {
    clearTimeout(timer);
    if (inFlight.get(path) === pending) inFlight.delete(path);
  });
  if (ttl) inFlight.set(path, pending);
  return pending;
}

const id = encodeURIComponent;
const q = (bbox) => bbox.join(',');

export const api = {
  // Auth0 session (401 when signed out)
  me: () => request('/api/auth/me'),

  // Catalog
  events: (options = {}) => request('/api/events', options),
  event: (eventId, options = {}) => request(`/api/events/${id(eventId)}`, options),
  context: (eventId) => request(`/api/events/${id(eventId)}/context`),

  // Discovery (bbox = [west, south, east, north], ≤ 5° a side)
  nisarSearch: (bbox, start, end, products = 'GCOV,GUNW,GOFF,SME2') =>
    request(`/api/nisar/search?bbox=${q(bbox)}&start=${start}&end=${end}&products=${products}`),
  quakes: (bbox, start, end, minMagnitude = 4.5) =>
    request(`/api/discover/earthquakes?minMagnitude=${minMagnitude}&start=${start}&end=${end}&bbox=${q(bbox)}`),
  datasetContext: (bbox, start, end, sources = 'gpm,smap,hls,terrain,grace') =>
    request(`/api/datasets/context?bbox=${q(bbox)}&start=${start}&end=${end}&sources=${sources}&limit=1`),

  // Tracking (signed-in users only)
  trackArea: (body) => request('/api/ingest', { method: 'POST', body }).then((data) => { clearApiCache(); return data; }),
  ingestStatus: (ingestId) => request(`/api/ingest/${id(ingestId)}`),
  trackQuake: (usgsId) => request('/api/events/earthquake', { method: 'POST', body: { usgsId } }).then((data) => { clearApiCache(); return data; }),

  // Modelled outputs — never observations; label them as such in the UI.
  outlook: (bbox, horizonDays = 30) => request(`/api/outlook?bbox=${q(bbox)}&horizonDays=${horizonDays}`),
  predict: (eventId) => request(`/api/events/${id(eventId)}/predict`),
  media: (eventId) => request(`/api/events/${id(eventId)}/media`),

  // AI
  summary: (eventId) => request(`/api/events/${id(eventId)}/summary`),
  ask: (eventId, question, chatId) => request('/api/ask', { method: 'POST', body: { eventId, question, chatId } }),

  // Saved conversations (signed-in users only)
  chats: () => request('/api/chats?limit=100'),
  createChat: (eventId, title) => request('/api/chats', { method: 'POST', body: { eventId, title } }),
  chatMessages: (chatId) => request(`/api/chats/${id(chatId)}/messages?limit=100`),
};

/**
 * Connection check used at boot: is the API reachable, how many events does
 * the catalog hold, and is anyone signed in? Never throws.
 * → { online: true, eventCount, events, user, auth, authMessage } | { online: false, error }
 *   auth: 'signed-in' | 'signed-out' (401) | 'unavailable' (Auth0 not configured / other failure)
 */
export async function probe() {
  let events;
  try {
    events = await api.events();
  } catch (err) {
    return { online: false, error: err && err.message ? err.message : UNREACHABLE };
  }
  let user = null;
  let auth = 'signed-out';
  let authMessage = '';
  try {
    const me = await api.me();
    user = me && (me.user || me);
    auth = user ? 'signed-in' : 'signed-out';
  } catch (err) {
    if (!(err && err.status === 401)) {
      auth = 'unavailable';
      authMessage = err && err.message ? err.message : 'Sign-in is unavailable.';
    }
  }
  const list = events && Array.isArray(events.events) ? events.events : [];
  return { online: true, eventCount: list.length, events: list, user, auth, authMessage };
}

// Sign-in and sign-out are full page navigations, not fetches: the API
// redirects to Auth0 and back to FRONTEND_URL (this page on :5173).
export const loginUrl = '/auth/login';
export const signupUrl = '/auth/login?screen_hint=signup';
export const logoutUrl = '/auth/logout';
