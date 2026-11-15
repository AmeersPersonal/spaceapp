// Storage layer: D1 catalog queries, R2 tile/manifest access and KV caching.
// All functions take the Worker `env` (or a single binding) so they are easy to test.

export const DATA_CREDIT = Object.freeze({
  data: 'NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by the Alaska Satellite Facility (ASF DAAC).',
  links: ['https://nisar.jpl.nasa.gov', 'https://asf.alaska.edu'],
});

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const now = () => new Date().toISOString();

// ---------- events ----------

function eventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    aoiWkt: row.aoi_wkt,
    bbox: parse(row.bbox, null),
    products: parse(row.products, []),
    startDate: row.start_date,
    endDate: row.end_date,
    watch: row.watch === 1,
    lastPolledAt: row.last_polled_at,
    createdAt: row.created_at,
    ...(row.scene_count !== undefined ? { sceneCount: row.scene_count } : {}),
  };
}

export async function listEvents(db) {
  const { results } = await db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM scenes s WHERE s.event_id = e.id) AS scene_count
       FROM events e ORDER BY e.created_at DESC`,
    )
    .all();
  return results.map(eventFromRow);
}

export async function getEvent(db, id) {
  return eventFromRow(await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first());
}

export async function insertEvent(db, event) {
  await db
    .prepare(
      `INSERT INTO events (id, name, type, description, aoi_wkt, bbox, products, start_date, end_date, watch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      event.name,
      event.type ?? 'other',
      event.description ?? null,
      event.aoiWkt,
      json(event.bbox),
      json(event.products ?? []),
      event.startDate ?? null,
      event.endDate ?? null,
      event.watch ? 1 : 0,
    )
    .run();
  return getEvent(db, event.id);
}

/** Widen an event's date range to include [start, end]. */
export async function extendEventDates(db, id, start, end) {
  await db
    .prepare(
      `UPDATE events SET
         start_date = CASE WHEN start_date IS NULL OR ?2 < start_date THEN ?2 ELSE start_date END,
         end_date   = CASE WHEN end_date   IS NULL OR ?3 > end_date   THEN ?3 ELSE end_date   END
       WHERE id = ?1`,
    )
    .bind(id, start, end)
    .run();
}

export async function listWatchedEvents(db) {
  const { results } = await db.prepare('SELECT * FROM events WHERE watch = 1').all();
  return results.map(eventFromRow);
}

export async function markEventPolled(db, id, at = now()) {
  await db.prepare('UPDATE events SET last_polled_at = ? WHERE id = ?').bind(at, id).run();
}

// ---------- scenes ----------

function sceneFromRow(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    product: row.product,
    acquiredAt: row.acquired_at,
    acquiredEnd: row.acquired_end,
    polarizations: parse(row.polarizations, []),
    flightDirection: row.flight_direction,
    pathNumber: row.path_number,
    frameNumber: row.frame_number,
    productionConfig: row.production_config,
    url: row.url,
    browseUrl: row.browse_url,
    bounds: parse(row.bounds, null),
    status: row.status,
    error: row.error,
    ingestId: row.ingest_id,
    source: row.source,
  };
}

/** Insert scenes; existing scenes keep their processing status but are re-linked to the ingest. */
export async function upsertScenes(db, eventId, ingestId, scenes) {
  if (!scenes.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO scenes (id, event_id, product, acquired_at, acquired_end, polarizations, flight_direction,
                         path_number, frame_number, production_config, url, browse_url, bounds, ingest_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ingest_id = excluded.ingest_id, url = excluded.url,
       browse_url = excluded.browse_url, bounds = COALESCE(excluded.bounds, scenes.bounds), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  await db.batch(
    scenes.map((s) =>
      stmt.bind(
        s.id,
        eventId,
        s.product,
        s.acquiredAt,
        s.acquiredEnd ?? null,
        json(s.polarizations ?? []),
        s.flightDirection ?? null,
        s.pathNumber ?? null,
        s.frameNumber ?? null,
        s.productionConfig ?? null,
        s.url,
        s.browseUrl ?? null,
        s.bounds ? json(s.bounds) : null,
        ingestId,
      ),
    ),
  );
  return scenes.length;
}

export async function getScene(db, id) {
  const row = await db.prepare('SELECT * FROM scenes WHERE id = ?').bind(id).first();
  return row ? sceneFromRow(row) : null;
}

export async function listScenesForEvent(db, eventId) {
  const { results } = await db
    .prepare('SELECT * FROM scenes WHERE event_id = ? ORDER BY acquired_at')
    .bind(eventId)
    .all();
  return results.map(sceneFromRow);
}

export async function listScenesForIngest(db, ingestId) {
  const { results } = await db
    .prepare('SELECT * FROM scenes WHERE ingest_id = ? ORDER BY acquired_at')
    .bind(ingestId)
    .all();
  return results.map(sceneFromRow);
}

export async function setSceneStatus(db, id, status, error = null) {
  await db
    .prepare(
      `UPDATE scenes SET status = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .bind(status, error, id)
    .run();
}

// ---------- layers ----------

export async function upsertLayers(db, eventId, sceneId, layers) {
  if (!layers.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO layers (event_id, layer, date, scene_id, min_zoom, max_zoom, bounds, units)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, layer, date) DO UPDATE SET scene_id = excluded.scene_id,
       min_zoom = excluded.min_zoom, max_zoom = excluded.max_zoom, bounds = excluded.bounds, units = excluded.units`,
  );
  await db.batch(
    layers.map((l) =>
      stmt.bind(eventId, l.layer, l.date, sceneId, l.minZoom ?? 0, l.maxZoom ?? 12, json(l.bounds ?? null), l.units ?? null),
    ),
  );
  return layers.length;
}

export async function listLayersForEvent(db, eventId) {
  const { results } = await db
    .prepare('SELECT * FROM layers WHERE event_id = ? ORDER BY layer, date')
    .bind(eventId)
    .all();
  return results.map((r) => ({
    layer: r.layer,
    date: r.date,
    sceneId: r.scene_id,
    minZoom: r.min_zoom,
    maxZoom: r.max_zoom,
    bounds: parse(r.bounds, null),
    units: r.units,
    tiles: `/tiles/${encodeURIComponent(eventId)}/${encodeURIComponent(r.layer)}/${r.date}/{z}/{x}/{y}.png`,
  }));
}

// ---------- ingests ----------

export async function createIngest(db, { id, eventId, start, end, trigger = 'api' }) {
  await db
    .prepare('INSERT INTO ingests (id, event_id, date_start, date_end, trigger) VALUES (?, ?, ?, ?, ?)')
    .bind(id, eventId, start, end, trigger)
    .run();
}

export async function updateIngest(db, id, { status, sceneCount, error }) {
  await db
    .prepare(
      `UPDATE ingests SET status = COALESCE(?, status), scene_count = COALESCE(?, scene_count),
         error = COALESCE(?, error), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .bind(status ?? null, sceneCount ?? null, error ?? null, id)
    .run();
}

export async function getIngest(db, id) {
  const row = await db.prepare('SELECT * FROM ingests WHERE id = ?').bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    dateRange: { start: row.date_start, end: row.date_end },
    trigger: row.trigger,
    status: row.status,
    sceneCount: row.scene_count,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- captions ----------

/** Delete a scene's captions (used when the scene is processed again). Returns the removed ids. */
export async function deleteCaptionsForScene(db, sceneId) {
  const { results } = await db.prepare('SELECT id FROM captions WHERE scene_id = ?').bind(sceneId).all();
  if (results.length) await db.prepare('DELETE FROM captions WHERE scene_id = ?').bind(sceneId).run();
  return results.map((r) => r.id);
}


export async function insertCaption(db, caption) {
  await db
    .prepare('INSERT INTO captions (id, event_id, scene_id, text, model) VALUES (?, ?, ?, ?, ?)')
    .bind(caption.id, caption.eventId, caption.sceneId ?? null, caption.text, caption.model)
    .run();
}

export async function getCaptionsByIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM captions WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  return results.map(captionFromRow);
}

export async function listCaptionsForEvent(db, eventId, limit = 20) {
  const { results } = await db
    .prepare('SELECT * FROM captions WHERE event_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(eventId, limit)
    .all();
  return results.map(captionFromRow);
}

function captionFromRow(r) {
  return { id: r.id, eventId: r.event_id, sceneId: r.scene_id, text: r.text, model: r.model, createdAt: r.created_at, aiGenerated: true };
}

// ---------- scene stats (for predictive analysis) ----------

/** Store the processor's manifest.stats on a scene. Non-object stats are ignored. */
export async function setSceneStats(db, sceneId, stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return false;
  await db.prepare('UPDATE scenes SET stats = ? WHERE id = ?').bind(json(stats), sceneId).run();
  return true;
}

/** Ready scenes that have stats, oldest first: [{sceneId, product, acquiredAt, stats}]. */
export async function listSceneStats(db, eventId) {
  const { results } = await db
    .prepare(`SELECT id, product, acquired_at, stats FROM scenes WHERE event_id = ? AND status = 'ready' AND stats IS NOT NULL ORDER BY acquired_at`)
    .bind(eventId)
    .all();
  return results.map((r) => ({ sceneId: r.id, product: r.product, acquiredAt: r.acquired_at, stats: parse(r.stats, {}) }));
}

// ---------- conversations ----------

export async function createConversation(db, { id, eventId }) {
  await db.prepare('INSERT INTO conversations (id, event_id) VALUES (?, ?)').bind(id, eventId).run();
  return { id, eventId };
}

export async function getConversation(db, id) {
  const row = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first();
  return row ? { id: row.id, eventId: row.event_id, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

/** Append messages [{role, agent?, model?, content}] in order and bump the conversation. */
export async function addMessages(db, conversationId, messages) {
  if (!messages.length) return;
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, agent, model, content) VALUES (?, ?, ?, ?, ?)');
  const touch = db.prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
  await db.batch([
    ...messages.map((m) => insert.bind(conversationId, m.role, m.agent ?? null, m.model ?? null, m.content)),
    touch.bind(conversationId),
  ]);
}

/** The latest `limit` messages of a conversation, oldest first. */
export async function listMessages(db, conversationId, limit = 100) {
  const { results } = await db
    .prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
    .bind(conversationId, limit)
    .all();
  return results.map((r) => ({ id: r.id, role: r.role, agent: r.agent, model: r.model, content: r.content, createdAt: r.created_at }));
}

// ---------- R2 ----------

export const tileKey = (eventId, layer, date, z, x, y) => `tiles/${eventId}/${layer}/${date}/${z}/${x}/${y}.png`;
export const manifestKey = (eventId, sceneId) => `manifests/${eventId}/${sceneId}.json`;

/** Parse `manifests/{eventId}/{sceneId}.json` back into its parts, or null. */
export function parseManifestKey(key) {
  const m = /^manifests\/([^/]+)\/([^/]+)\.json$/.exec(key ?? '');
  return m ? { eventId: m[1], sceneId: m[2] } : null;
}

export async function readManifest(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.json();
}

// ---------- KV cache ----------

export const cacheKeys = {
  eventList: () => 'events:list',
  event: (id) => `events:${id}`,
  answer: (eventId, hash) => `ask:${eventId}:${hash}`,
};

export async function cached(kv, key, ttlSeconds, produce) {
  const hit = await kv.get(key, 'json');
  if (hit !== null) return hit;
  const value = await produce();
  if (value !== null && value !== undefined) {
    await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  }
  return value;
}

export async function invalidateEvent(kv, eventId) {
  await Promise.all([kv.delete(cacheKeys.eventList()), kv.delete(cacheKeys.event(eventId))]);
}
