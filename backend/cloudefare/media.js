// Pictures for an event: USGS impact maps of the earthquake itself, related photographs from the
// NASA Image and Video Library, and links to other photo collections. Nothing is stored; the
// images stay on USGS and NASA servers and each one keeps its credit and source page.

import { USGS_QUERY_URL, fetchJson } from './events.js';

export const NASA_IMAGES_URL = 'https://images-api.nasa.gov/search';
export const MAX_PHOTOS = 6;
const USGS_EVENT_PAGE = 'https://earthquake.usgs.gov/earthquakes/eventpage/';

// Search word per event type (workFlowManger.js EVENT_TYPES); 'other' has none.
const TYPE_WORDS = { earthquake: 'earthquake', flood: 'flood', wetland: 'wetland flooding', forest: 'deforestation', crop: 'crop drought', glacier: 'glacier', soil_moisture: 'drought' };

/** The USGS id behind an event registered from an earthquake ("usgs-us7000tx16" -> "us7000tx16"), else null. */
export const usgsIdOf = (event) => (event?.type === 'earthquake' && /^usgs-[a-z0-9]+$/.test(event.id) ? event.id.slice(5) : null);

/** Impact maps that USGS publishes for an earthquake, picked out of its detail record. */
export function quakeImages(feature) {
  const products = feature?.properties?.products ?? {};
  const page = feature?.properties?.url ?? null;
  const pick = (product, match, title) => {
    const contents = products[product]?.[0]?.contents ?? {};
    const key = Object.keys(contents).find(match);
    const url = key ? contents[key]?.url : null;
    return typeof url === 'string' && url.startsWith('https://') ? [{ kind: 'map', title, url, page, credit: 'USGS' }] : [];
  };
  return [
    ...pick('shakemap', (k) => k === 'download/intensity.jpg', 'ShakeMap: how strongly the ground shook'),
    ...pick('losspager', (k) => k === 'exposure.png', 'PAGER: people exposed to each shaking level'),
    ...pick('dyfi', (k) => k.endsWith('_ciim.jpg'), 'Did You Feel It? Intensity reported by residents'),
    ...pick('ground-failure', (k) => k === 'jessee_2018.png', 'Estimated landslide hazard'),
    ...pick('ground-failure', (k) => k === 'zhu_2017_general.png', 'Estimated liquefaction hazard'),
  ];
}

/** What to search photo libraries for, or null when the event has no place name to go on. */
export function photoQuery(event) {
  const word = TYPE_WORDS[event?.type];
  if (!word || typeof event.name !== 'string') return null;
  // "M 6.4 - 30 km WSW of Lata, Solomon Islands" -> "Solomon Islands": the widest place name finds the most.
  const place = event.type === 'earthquake' ? event.name.replace(/^.*?\bof\s+/i, '').split(',').pop().trim() : event.name.trim();
  return place ? `${place} ${word}` : null;
}

export function parseNasaSearch(body, limit = MAX_PHOTOS) {
  const items = body?.collection?.items;
  if (!Array.isArray(items)) return [];
  const photos = [];
  for (const item of items) {
    const data = item?.data?.[0];
    const url = item?.links?.find((l) => l?.render === 'image' || /\.(jpe?g|png)$/i.test(l?.href ?? ''))?.href;
    if (!data?.nasa_id || !data.title || typeof url !== 'string' || !url.startsWith('https://')) continue;
    photos.push({
      kind: 'photo',
      title: String(data.title).slice(0, 160),
      url,
      page: `https://images.nasa.gov/details/${encodeURIComponent(data.nasa_id)}`,
      date: typeof data.date_created === 'string' ? data.date_created.slice(0, 10) : null,
      credit: data.center ? `NASA/${data.center}` : 'NASA',
    });
    if (photos.length >= limit) break;
  }
  return photos;
}

export function mediaLinks(event, query) {
  const usgsId = usgsIdOf(event);
  const q = query ? encodeURIComponent(query) : null;
  return [
    ...(usgsId ? [{ label: 'USGS event page (maps, impact, reports)', url: `${USGS_EVENT_PAGE}${usgsId}` }] : []),
    ...(q
      ? [
          { label: 'Photos on Wikimedia Commons', url: `https://commons.wikimedia.org/w/index.php?search=${q}&title=Special:MediaSearch&type=image` },
          { label: 'NASA Earth Observatory', url: `https://earthobservatory.nasa.gov/search?q=${q}` },
          { label: 'NASA Image and Video Library', url: `https://images.nasa.gov/search?q=${q}&media=image` },
        ]
      : []),
  ];
}

/** Everything for one event. Each source fails on its own: a missing one just leaves its list empty. */
export async function eventMedia(event, deps = {}) {
  const usgsId = usgsIdOf(event);
  const query = photoQuery(event);
  const [usgs, nasa] = await Promise.allSettled([
    usgsId ? fetchJson(`${USGS_QUERY_URL}?format=geojson&eventid=${usgsId}`, { fetchImpl: deps.fetch, label: 'USGS' }) : null,
    query ? fetchJson(`${NASA_IMAGES_URL}?q=${encodeURIComponent(query)}&media_type=image&page_size=${MAX_PHOTOS * 2}`, { fetchImpl: deps.fetch, label: 'NASA images' }) : null,
  ]);
  const feature = usgs.status === 'fulfilled' ? usgs.value : null;
  return {
    eventId: event.id,
    images: quakeImages(feature?.type === 'FeatureCollection' ? feature.features?.[0] : feature),
    photos: nasa.status === 'fulfilled' ? parseNasaSearch(nasa.value) : [],
    photoQuery: query,
    links: mediaLinks(event, query),
    note: 'Maps are USGS products for this earthquake. Photos are a NASA library search for the place and hazard, so they can show earlier disasters there rather than this event.',
    credit: 'Impact maps: U.S. Geological Survey. Photos: NASA Image and Video Library.',
  };
}
