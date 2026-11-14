import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { decodeJwtPayload, earthdataHeaders, isTokenExpired, processorHeaders, requireIngestKey, safeEqual } from '../oAuth.js';

const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

describe('Earthdata token helpers', () => {
  it('decodes JWT payloads and rejects malformed tokens', () => {
    expect(decodeJwtPayload(jwt({ exp: 5, uid: 'u' }))).toEqual({ exp: 5, uid: 'u' });
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.!!!.c')).toBeNull();
  });

  it('detects expiry', () => {
    expect(isTokenExpired(jwt({ exp: 100 }), 200_000)).toBe(true);
    expect(isTokenExpired(jwt({ exp: 1000 }), 200_000)).toBe(false);
    expect(isTokenExpired('opaque-token')).toBe(false);
  });

  it('omits the Authorization header when the token is missing or expired', () => {
    expect(earthdataHeaders({})).toEqual({});
    expect(earthdataHeaders({ EARTHDATA_TOKEN: jwt({ exp: 1 }) })).toEqual({});
    const valid = jwt({ exp: 4102444800 });
    expect(earthdataHeaders({ EARTHDATA_TOKEN: valid })).toEqual({ authorization: `Bearer ${valid}` });
  });

  it('builds processor headers only when a token is set', () => {
    expect(processorHeaders({})).toEqual({});
    expect(processorHeaders({ PROCESSOR_TOKEN: 'p' })).toEqual({ authorization: 'Bearer p' });
  });

  it('compares strings safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('requireIngestKey middleware', () => {
  const app = new Hono().post('/x', requireIngestKey(), (c) => c.text('ok'));
  const call = (env, auth) => app.request('/x', { method: 'POST', headers: auth ? { authorization: auth } : {} }, env);

  it('passes through when no key is configured', async () => {
    expect((await call({})).status).toBe(200);
  });
  it('rejects missing or wrong keys and accepts the right one', async () => {
    expect((await call({ INGEST_API_KEY: 'k' })).status).toBe(401);
    expect((await call({ INGEST_API_KEY: 'k' }, 'Bearer nope')).status).toBe(401);
    expect((await call({ INGEST_API_KEY: 'k' }, 'Bearer k')).status).toBe(200);
  });
});
