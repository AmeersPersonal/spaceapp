// api.js — the one place the frontend talks to the Earth Replay API.
// Paths are relative: in development Vite forwards them to the Worker
// (see vite.config.js), so the session cookie travels with every request.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the API. Is the backend running?')
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    // The dev proxy answers 500/502 with no JSON when the Worker is down.
    const code = data?.error ?? (response.status >= 500 ? 'network' : 'error')
    const message =
      data?.message ??
      data?.details?.join('; ') ??
      (code === 'network'
        ? 'Could not reach the API. Is the backend running?'
        : `Request failed (${response.status})`)
    throw new ApiError(response.status, code, message)
  }
  return data
}

const id = encodeURIComponent

export const api = {
  // Auth0 session
  me: () => request('/api/auth/me'),

  // Catalog
  events: () => request('/api/events'),
  event: (eventId) => request(`/api/events/${id(eventId)}`),
  // Supplementary NASA datasets for the event's area (stored by the backend, also used by the AI)
  context: (eventId) => request(`/api/events/${id(eventId)}/context`),

  // Ask about any place: what NISAR, quakes and other NASA datasets have for a box.
  // `bbox` is [west, south, east, north]; the backend allows at most 5 degrees a side.
  nisarSearch: (bbox, start, end) =>
    request(`/api/nisar/search?bbox=${bbox.join(',')}&start=${start}&end=${end}&products=GCOV,GUNW,GOFF,SME2`),
  quakes: (bbox, start, end) =>
    request(`/api/discover/earthquakes?minMagnitude=4.5&start=${start}&end=${end}&bbox=${bbox.join(',')}`),
  datasetContext: (bbox, start, end) =>
    request(
      `/api/datasets/context?bbox=${bbox.join(',')}&start=${start}&end=${end}&sources=gpm,smap,hls,terrain,grace&limit=1`,
    ),

  // Start tracking (signed-in users only)
  trackArea: (body) => request('/api/ingest', { method: 'POST', body }),
  trackQuake: (usgsId) => request('/api/events/earthquake', { method: 'POST', body: { usgsId } }),

  // Modeled earthquake outlook for a region, with AI-worded scenarios (never an observation)
  outlook: (bbox, horizonDays = 30) => request(`/api/outlook?bbox=${bbox.join(',')}&horizonDays=${horizonDays}`),
  // USGS impact maps, related NASA photos and photo links for an event
  media: (eventId) => request(`/api/events/${id(eventId)}/media`),
  // Modeled projection from the event's own NISAR time series
  predict: (eventId) => request(`/api/events/${id(eventId)}/predict`),

  // AI
  summary: (eventId) => request(`/api/events/${id(eventId)}/summary`),
  ask: (eventId, question, chatId) =>
    request('/api/ask', { method: 'POST', body: { eventId, question, chatId } }),

  // Saved conversations (signed-in users only)
  chats: () => request('/api/chats'),
  createChat: (eventId, title) =>
    request('/api/chats', { method: 'POST', body: { eventId, title } }),
  chatMessages: (chatId) => request(`/api/chats/${id(chatId)}/messages?limit=100`),
}

// Sign-in and sign-out are full page navigations, not fetches: the API
// redirects to Auth0 and back, then returns the browser to this app.
export const loginUrl = '/auth/login'
export const signupUrl = '/auth/login?screen_hint=signup'
export const logoutUrl = '/auth/logout'
