// ASF DAAC search client for NISAR granules (metadata only — no HDF5 is downloaded or parsed here).
// Field names validated against live ASF search responses on 2026-11-14:
//   - `polarization` is null for NISAR; polarizations live in mainBandPolarization / sideBandPolarization.
//   - `geometry.coordinates` can be null.
//   - `productionConfiguration` is "UR" (urgent response) or "PR" (standard production).

import { earthdataHeaders } from './oAuth.js';

export const NISAR_PRODUCTS = Object.freeze(['GCOV', 'GUNW', 'GOFF', 'SME2']);
export const DEFAULT_ASF_SEARCH_URL = 'https://api.daac.asf.alaska.edu/services/search/param';

export class AsfError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.name = 'AsfError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function buildSearchUrl({ baseUrl = DEFAULT_ASF_SEARCH_URL, wkt, start, end, products, maxResults = 25 }) {
  const url = new URL(baseUrl);
  url.searchParams.set('dataset', 'NISAR');
  url.searchParams.set('processingLevel', products.join(','));
  url.searchParams.set('intersectsWith', wkt);
  url.searchParams.set('start', toIsoStart(start));
  url.searchParams.set('end', toIsoEnd(end));
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('output', 'geojson');
  return url.toString();
}

const toIsoStart = (d) => (d.length === 10 ? `${d}T00:00:00Z` : d);
const toIsoEnd = (d) => (d.length === 10 ? `${d}T23:59:59Z` : d);

/** Bounding box [west, south, east, north] of a scene's footprint polygon, or null if unusable. */
export function footprintBounds(geometry) {
  const ring = geometry?.type === 'Polygon' ? geometry.coordinates?.[0] : null;
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const point of ring) {
    const [x, y] = Array.isArray(point) ? point : [];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) return null;
    [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
  }
  // A footprint crossing the antimeridian would produce a bbox spanning the globe.
  return e - w > 180 ? null : [w, s, e, n];
}

/** Normalize one ASF GeoJSON feature into the scene shape stored in D1. Returns null if unusable. */
export function normalizeFeature(feature) {
  const p = feature?.properties;
  if (!p?.sceneName || !p.startTime || !p.url) return null;
  if (!NISAR_PRODUCTS.includes(p.processingLevel)) return null;
  const pols = [...(p.mainBandPolarization ?? []), ...(p.sideBandPolarization ?? []), ...(p.polarization ? [p.polarization] : [])];
  const browse = Array.isArray(p.browse) ? p.browse : [];
  return {
    id: p.sceneName,
    product: p.processingLevel,
    acquiredAt: p.startTime,
    acquiredEnd: p.stopTime ?? null,
    polarizations: [...new Set(pols)],
    flightDirection: p.flightDirection ?? null,
    pathNumber: p.pathNumber ?? null,
    frameNumber: p.frameNumber ?? null,
    productionConfig: p.productionConfiguration ?? null,
    url: p.url,
    browseUrl: browse.find((b) => b.endsWith('_LATLON.png')) ?? browse[0] ?? null,
    bounds: footprintBounds(feature.geometry),
  };
}

export function parseSearchResponse(body) {
  if (!body || !Array.isArray(body.features)) throw new AsfError('ASF response missing features array', { retryable: false });
  const seen = new Set();
  const scenes = [];
  for (const f of body.features) {
    const s = normalizeFeature(f);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      scenes.push(s);
    }
  }
  return scenes.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
}


export async function searchNisar(env, params, fetchImpl = fetch) {
  const url = buildSearchUrl({ baseUrl: env.ASF_SEARCH_URL || DEFAULT_ASF_SEARCH_URL, ...params });
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/geo+json, application/json', ...earthdataHeaders(env) } });
  } catch (err) {
    throw new AsfError(`ASF search network error: ${err.message}`);
  }
  if (!res.ok) {
    // 4xx (except 429) means our query is wrong; retrying will not help.
    const retryable = res.status >= 500 || res.status === 429;
    throw new AsfError(`ASF search failed with HTTP ${res.status}`, { status: res.status, retryable });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new AsfError('ASF search returned invalid JSON');
  }
  return parseSearchResponse(body);
}
