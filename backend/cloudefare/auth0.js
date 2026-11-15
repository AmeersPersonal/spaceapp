import { auth, callback, login, logout } from '@auth0/auth0-hono';
import { sessionAccess } from './sessionManger.js';

const middlewareByEnv = new WeakMap();

/** Origin of the optional FRONTEND_URL (the browser app that proxies or calls this API), or null. */
export function frontendOrigin(env) {
  try { return env.FRONTEND_URL ? new URL(env.FRONTEND_URL).origin : null; } catch { return null; }
}

/** Only these operations require a user; catalog, tiles and replay remain public. */
export async function authenticate(c, next) {
  const access = sessionAccess(c.req.method, c.req.path);
  const protectedRequest = access.required;
  const authRequest = c.req.path.startsWith('/auth/') || c.req.path === '/api/auth/me';
  if (!protectedRequest && !authRequest) return next();
  c.header('Cache-Control', 'no-store');

  const env = c.env;
  if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET ||
      env.AUTH0_SESSION_ENCRYPTION_KEY?.length < 32 || !env.AUTH0_SESSION_ENCRYPTION_KEY || !env.APP_BASE_URL) {
    return c.json({ error: 'auth_not_configured', message: 'Auth0 login is not configured' }, 503);
  }
  let middleware = middlewareByEnv.get(env);
  if (!middleware) {
    middleware = auth({
      domain: env.AUTH0_DOMAIN,
      clientID: env.AUTH0_CLIENT_ID,
      clientSecret: env.AUTH0_CLIENT_SECRET,
      baseURL: env.APP_BASE_URL,
      authRequired: false,
      idpLogout: true,
      customRoutes: ['login', 'callback', 'logout', 'backchannelLogout'],
      authorizationParams: { response_type: 'code', response_mode: 'query', scope: 'openid profile email' },
      session: {
        secret: env.AUTH0_SESSION_ENCRYPTION_KEY,
        rolling: false,
        absoluteDuration: 3600,
        cookie: { name: 'earthReplaySession', sameSite: 'lax', secure: env.APP_BASE_URL.startsWith('https:') },
      },
    });
    middlewareByEnv.set(env, middleware);
  }
  const response = await middleware(c, async () => {
    const session = await c.var.auth0Client.getSession(c);
    c.set('auth0User', session?.user ?? null);
    if (protectedRequest) {
      if (!session?.user?.sub) return c.json({ error: 'unauthorized', message: 'Log in at /auth/login' }, 401);
    }
    if (protectedRequest && access.write) {
      // JSON plus an exact origin allowlist prevents cross-site form/cookie requests.
      const origin = c.req.header('origin');
      const allowed = [new URL(env.APP_BASE_URL).origin, frontendOrigin(env), ...((env.CORS_ORIGIN || '').split(',').map(s => s.trim()))];
      if ((origin && !allowed.includes(origin)) || (!origin && c.req.header('sec-fetch-site') === 'cross-site')) {
        return c.json({ error: 'forbidden', message: 'Request origin is not allowed' }, 403);
      }
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return c.json({ error: 'invalid_request', message: 'Content-Type must be application/json' }, 415);
      }
    }
    return next();
  });
  // SDK 1.2.x omits Secure on its transaction cookie, even with secure sessions.
  // Enforce it for every auth cookie when the configured app uses HTTPS.
  const result = response ?? c.res;
  if (env.APP_BASE_URL.startsWith('https:')) {
    const cookies = result.headers.getSetCookie();
    result.headers.delete('set-cookie');
    for (const cookie of cookies) result.headers.append('set-cookie', /;\s*secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
  }
  return result;
}

export function mountAuthRoutes(app) {
  // With FRONTEND_URL set, a finished login lands on the frontend instead of the profile JSON.
  // The SDK only honours it on the API's own hostname (localhost dev); otherwise it falls back
  // to "/", which the API root forwards to FRONTEND_URL for browsers. `screen_hint=signup`
  // opens Auth0's sign-up screen. Without FRONTEND_URL, a Worker that hosts the frontend
  // itself (ASSETS binding) returns to its own root.
  app.get('/auth/login', (c, next) => login({
    redirectAfterLogin: frontendOrigin(c.env) ? c.env.FRONTEND_URL : c.env.ASSETS ? '/' : '/api/auth/me',
    forwardAuthorizationParams: ['screen_hint'],
  })(c, next));
  app.get('/auth/callback', callback());
  app.get('/auth/logout', logout());
  app.get('/api/auth/me', (c) => {
    const user = c.get('auth0User');
    if (!user) return c.json({ error: 'unauthorized', message: 'Log in at /auth/login' }, 401);
    // Never expose access/refresh/ID tokens or the encrypted session itself.
    return c.json({ user: { sub: user.sub, name: user.name, email: user.email, picture: user.picture } });
  });
}
