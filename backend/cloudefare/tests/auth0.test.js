import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';
import { testEnv } from './helpers.js';
import { sessionCookie } from './auth0-helpers.js';

afterEach(() => vi.unstubAllGlobals());

function mockDiscovery({ jwks, tokenResponse } = {}) {
  return vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json({
      issuer: 'https://tenant.auth0.test/',
      authorization_endpoint: 'https://tenant.auth0.test/authorize',
      token_endpoint: 'https://tenant.auth0.test/oauth/token',
      jwks_uri: 'https://tenant.auth0.test/.well-known/jwks.json',
      end_session_endpoint: 'https://tenant.auth0.test/oidc/logout',
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'],
    });
    if (String(url).endsWith('/.well-known/jwks.json') && jwks) return Response.json(jwks);
    if (String(url).endsWith('/oauth/token') && tokenResponse) return Response.json(tokenResponse);
    throw new Error(`Unexpected external request: ${url}`);
  }));
}

const call = (path, init = {}, overrides = {}) => worker.fetch(
  new Request(`https://api.test${path}`, init), testEnv(overrides), {},
);

describe('Auth0 login and API protection', () => {
  it('requires login for every protected write even if a legacy API key is supplied', async () => {
    for (const path of ['/api/ingest', '/api/events/earthquake', '/api/ask']) {
      const res = await call(path, { method: 'POST', headers: { authorization: 'Bearer old-key' } }, { INGEST_API_KEY: 'old-key' });
      expect(res.status).toBe(401);
    }
  });

  it('returns only user profile fields from a real encrypted session', async () => {
    const res = await call('/api/auth/me', { headers: { cookie: await sessionCookie() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { sub: 'auth0|test-user', name: 'Test User', email: 'test@example.com' } });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects missing, tampered and expired session cookies', async () => {
    for (const cookie of ['', 'earthReplaySession.0=forged', await sessionCookie({ expired: true })]) {
      expect((await call('/api/auth/me', { headers: { cookie } })).status).toBe(401);
    }
  });

  it('allows a logged-in request to reach payload validation', async () => {
    const cookie = await sessionCookie();
    for (const path of ['/api/ingest', '/api/events/earthquake', '/api/ask']) {
      const res = await call(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(400);
    }
  });

  it('blocks cross-site requests and simple form submissions with session cookies', async () => {
    const cookie = await sessionCookie();
    const post = (headers) => call('/api/ask', { method: 'POST', headers: { cookie, ...headers }, body: '{}' });
    expect((await post({ origin: 'https://evil.test', 'content-type': 'application/json' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ origin: 'https://api.test', 'content-type': 'application/json' })).status).toBe(400);
  });

  it('supports credentialed CORS only for explicitly configured frontend origins', async () => {
    const res = await call('/api/auth/me', { headers: { origin: 'https://frontend.test' } }, { CORS_ORIGIN: 'https://frontend.test' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://frontend.test');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await call('/api/auth/me', { headers: { origin: 'https://evil.test' } }, { CORS_ORIGIN: 'https://frontend.test' });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await call('/api/ask', { method: 'OPTIONS', headers: { origin: 'https://frontend.test', 'access-control-request-method': 'POST' } }, { CORS_ORIGIN: 'https://frontend.test' });
    expect(preflight.status).toBe(204);
  });

  it('starts authorization-code login with PKCE and a secure HttpOnly transaction cookie', async () => {
    mockDiscovery();
    const res = await call('/auth/login?return_to=https://evil.test');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location'));
    expect(location.origin).toBe('https://tenant.auth0.test');
    expect(location.searchParams.get('redirect_uri')).toBe('https://api.test/auth/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('exchanges a callback code, verifies the signed ID token and creates a usable session', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const encode = (value) => b64(new TextEncoder().encode(JSON.stringify(value)));
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ iss: 'https://tenant.auth0.test/', aud: 'test-client', sub: 'auth0|callback-user', name: 'Callback User', iat: now, exp: now + 3600 })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
    mockDiscovery({ jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }, tokenResponse: { token_type: 'Bearer', access_token: 'test-access-token', expires_in: 3600, id_token: `${unsigned}.${b64(new Uint8Array(signature))}` } });
    const started = await call('/auth/login');
    const transaction = started.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const completed = await call('/auth/callback?code=test-code', { headers: { cookie: transaction } });
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe('https://api.test/api/auth/me');
    const cookie = completed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(completed.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    const profile = await call('/api/auth/me', { headers: { cookie } });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toEqual({ user: { sub: 'auth0|callback-user', name: 'Callback User' } });
    expect((await call('/api/ask', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
  });

  it('rejects a callback without a matching login transaction', async () => {
    mockDiscovery();
    const res = await call('/auth/callback?code=forged&state=wrong');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'authentication_failed' });
  });

  it('logs out locally and redirects to Auth0 logout', async () => {
    mockDiscovery();
    const res = await call('/auth/logout', { headers: { cookie: await sessionCookie() } });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')).hostname).toBe('tenant.auth0.test');
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('allows logout when already logged out', async () => {
    const res = await call('/auth/logout');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://api.test');
  });
  it('fails closed when authentication is not configured', async () => {
    for (const path of ['/api/ingest', '/api/events/earthquake', '/api/ask']) {
      const res = await call(path, { method: 'POST' }, { AUTH0_DOMAIN: '' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'auth_not_configured' });
    }
  });

  it('returns a configuration error for login before credentials are supplied', async () => {
    const res = await call('/auth/login', {}, { AUTH0_DOMAIN: '' });
    expect(res.status).toBe(503);
  });

  it('does not cache current-user responses', async () => {
    const res = await call('/api/auth/me', {}, { AUTH0_DOMAIN: '' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
