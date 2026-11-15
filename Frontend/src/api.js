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
