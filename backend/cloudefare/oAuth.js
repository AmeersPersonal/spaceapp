// External service credentials and legacy ingest-key helpers. Browser login lives in auth0.js:
//  - Earthdata Login bearer token (EARTHDATA_TOKEN secret) for authenticated ASF requests,
//  - an optional shared key guarding POST /api/ingest (INGEST_API_KEY secret),
//  - a shared secret sent to the external processor (PROCESSOR_TOKEN secret).

/** Decode a JWT payload without verifying it (Earthdata tokens are JWTs). Returns null if malformed. */
export function decodeJwtPayload(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
  } catch {
    return null;
  }
}

/** true when the token is a JWT whose `exp` is in the past. Non-JWT tokens are treated as not expired. */
export function isTokenExpired(token, nowMs = Date.now()) {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === 'number' && payload.exp * 1000 <= nowMs;
}

export function earthdataHeaders(env, nowMs = Date.now()) {
  const token = env.EARTHDATA_TOKEN;
  if (!token || isTokenExpired(token, nowMs)) return {};
  return { authorization: `Bearer ${token}` };
}

export function processorHeaders(env) {
  return env.PROCESSOR_TOKEN ? { authorization: `Bearer ${env.PROCESSOR_TOKEN}` } : {};
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Hono middleware: when INGEST_API_KEY is set, require `Authorization: Bearer <key>`.
 * When unset (local dev / open demo) requests pass through.
 */
export function requireIngestKey() {
  return async (c, next) => {
    const expected = c.env.INGEST_API_KEY;
    if (!expected) return next();
    const header = c.req.header('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !safeEqual(given, expected)) {
      return c.json({ error: 'unauthorized', message: 'Missing or invalid ingest API key' }, 401);
    }
    return next();
  };
}
