import { StatelessStateStore } from '@auth0/auth0-server-js';

export const authEnv = {
  AUTH0_DOMAIN: 'tenant.auth0.test',
  AUTH0_CLIENT_ID: 'test-client',
  AUTH0_CLIENT_SECRET: 'test-client-secret',
  AUTH0_SESSION_ENCRYPTION_KEY: 'test-only-session-secret-at-least-32-characters',
  APP_BASE_URL: 'https://api.test',
};

/** Use Auth0's actual cookie encryption, never a production authentication bypass. */
export async function sessionCookie({ user = { sub: 'auth0|test-user', name: 'Test User', email: 'test@example.com' }, expired = false } = {}) {
  const cookies = {};
  const store = new StatelessStateStore({ secret: authEnv.AUTH0_SESSION_ENCRYPTION_KEY }, {
    getCookies: () => cookies,
    getCookie: (name) => cookies[name],
    setCookie: (name, value) => { cookies[name] = value; },
    deleteCookie: (name) => { delete cookies[name]; },
  });
  await store.set('earthReplaySession', {
    user,
    tokenSets: [],
    idToken: 'never-return-this-token',
    refreshToken: 'never-return-this-refresh-token',
    internal: { createdAt: Math.floor(Date.now() / 1000), sid: 'test-session' },
    ...(expired ? { sessionExpiresAt: Math.floor(Date.now() / 1000) - 60 } : {}),
  });
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}
