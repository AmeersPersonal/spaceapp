// live.js — renders the LIVE channel's evidence blocks from plain data.
// Every function takes a container and the slice of state it shows, and
// rebuilds that container only when the data changed (a signature check), so
// focus and typing elsewhere in the dock are never disturbed.
//
// Text is set with textContent only. Interactive elements built here carry
// data-action / data-id / data-cell attributes; main.js handles them by event
// delegation. Imports explore.js only.
//
// Honesty rules applied here:
//  - Projection and outlook text always carries the MODELLED label and the
//    backend's own disclaimer; probabilities are never shown as 0% or 100%.
//  - AI text is labelled AI-generated with the backend disclaimer.
//  - Catalog records are labelled as records, not measurements.

import { formatDay, plural, percent, statusLabel, contains, layerLabel } from './explore.js';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                          */
/* ------------------------------------------------------------------ */

/** h('p', { class: 'meta' }, 'text', child, ...) — attributes are set as attributes. */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const signatures = new WeakMap();

/** Rebuild `node` with build() only when `sig` differs from last time. */
function fill(node, sig, build) {
  if (!node) return;
  const key = typeof sig === 'string' ? sig : JSON.stringify(sig);
  if (signatures.get(node) === key) return;
  signatures.set(node, key);
  const out = build();
  node.replaceChildren(...(Array.isArray(out) ? out : [out]).filter(Boolean));
}

/** Cheap signature of a load-status object (main.js stamps each new one). */
const sig = (x) => (x ? `${x.status}|${x.stamp === undefined ? '' : x.stamp}|${x.message || ''}` : '-');

const muted = (text) => h('p', { class: 'live-muted' }, text);
const error = (text) => h('p', { class: 'live-error', role: 'alert' }, text);
const fine = (text) => (text ? h('p', { class: 'live-fine' }, text) : null);

/* ------------------------------------------------------------------ */
/* Event head                                                           */
/* ------------------------------------------------------------------ */

export function renderEventHead(node, { detail, replay, step, stepCount, mode, layer, imageErrors }) {
  fill(node, { d: sig(detail), r: replay && replay.id, s: step && step.date, n: stepCount, mode, layer, imageErrors }, () => {
    if (replay) {
      return [
        h('p', { class: 'meta live-eyebrow' }, 'REPLAY · NOT TRACKED'),
        h('h2', null, replay.name),
        h('p', { class: 'live-text' }, `${plural(replay.scenes.length, 'scene')} found by your search, played from the first pass. Nothing is tracked or saved.`),
        stepLine(step, stepCount, mode, layer, imageErrors),
      ];
    }
    if (!detail || detail.status === 'idle') return muted('Pick an event, or click the map to explore an area.');
    if (detail.status === 'loading') return muted('Loading the event…');
    if (detail.status === 'error') return error(detail.message);
    const { event, scenes, dates, polarizations, layers } = detail.data;
    const layerNames = [...new Set((layers || []).map((l) => layerLabel(l.layer)))];
    const fact = (k, v) => [h('dt', null, k), h('dd', null, v)];
    return [
      h('p', { class: 'meta live-eyebrow' }, String(event.type || 'event').toUpperCase()),
      h('h2', null, event.name),
      event.description ? h('p', { class: 'live-text' }, event.description) : null,
      stepLine(step, stepCount, mode, layer, imageErrors),
      h(
        'dl',
        { class: 'live-facts' },
        fact('Area', Array.isArray(event.bbox) ? event.bbox.map((n) => Number(n).toFixed(2)).join(', ') : '—'),
        fact('Products', (event.products || []).join(', ') || '—'),
        fact('Scenes', String(scenes.length)),
        fact('Passes', dates.length ? `${formatDay(dates[0])} – ${formatDay(dates[dates.length - 1])}` : '—'),
        fact('Polarizations', (polarizations || []).join(', ') || '—'),
        fact('Map layers', layerNames.join(', ') || 'Not processed yet'),
      ),
    ];
  });
}

function stepLine(step, count, mode, layer, imageErrors) {
  if (mode === 'area') {
    return h('p', { class: 'live-note' }, 'No preview images or processed tiles yet, so only the area outline is drawn. The dashed box is the tracked area. A newly tracked area fills in as the ingest finds its scenes.');
  }
  if (!step) return null;
  const what = mode === 'tiles' ? `${layerLabel(layer)} tiles` : `${plural(step.scenes.length, 'ASF preview')}`;
  return h(
    'p',
    { class: 'live-note' },
    `Pass ${step.index + 1} of ${count}, ${formatDay(step.date)}: ${what} on the map.`,
    imageErrors ? ` ${plural(imageErrors, 'preview')} could not load and ${imageErrors === 1 ? 'is' : 'are'} not drawn.` : '',
  );
}

/* ------------------------------------------------------------------ */
/* Modelled projection                                                  */
/* ------------------------------------------------------------------ */

export function renderProjection(node, predict) {
  fill(node, sig(predict), () => {
    if (!predict || predict.status === 'idle') return muted('A trend fitted to this event\'s own NISAR statistics. Written on request.');
    if (predict.status === 'loading') return muted('Projecting…');
    if (predict.status === 'error') return error(predict.message);
    const d = predict.data;
    const obs = d.observations || {};
    const metrics = Array.isArray(d.metrics) ? d.metrics : [];
    return [
      obs.nextExpectedAcquisition
        ? h('p', { class: 'live-text' }, `Next NISAR pass expected around ${formatDay(obs.nextExpectedAcquisition)} (about every ${obs.cadenceDays} days so far). This is a schedule estimate, not a pass that has happened.`)
        : null,
      d.narrative ? h('p', { class: 'live-answer' }, d.narrative) : muted(d.reason || 'There is not enough processed data to project yet.'),
      metrics.length
        ? h(
            'ul',
            { class: 'live-list' },
            metrics.map((m) =>
              h(
                'li',
                null,
                h('span', { class: 'live-list-name' }, `${m.product} ${m.metric}: ${m.direction}`),
                h(
                  'span',
                  { class: 'meta' },
                  `${m.latest.value} on ${formatDay(m.latest.date)} → about ${m.projected.value} (${m.projected.low} to ${m.projected.high}) by ${formatDay(m.projected.date)} · ${m.confidence} confidence`,
                ),
              ),
            ),
          )
        : null,
      h('p', { class: 'meta' }, d.aiGenerated ? 'MODELLED · WORDED BY AI' : 'MODELLED'),
      fine(d.disclaimer),
    ];
  });
}

/* ------------------------------------------------------------------ */
/* AI briefing and questions                                            */
/* ------------------------------------------------------------------ */

export function renderBriefing(node, brief) {
  fill(node, sig(brief), () => {
    if (!brief || brief.status === 'idle') return muted('An AI-written summary of what the catalog holds for this event.');
    if (brief.status === 'loading') return muted('Writing…');
    if (brief.status === 'error') return error(brief.message);
    return [h('p', { class: 'live-answer' }, brief.data.summary), h('p', { class: 'meta' }, 'AI-GENERATED'), fine(brief.data.disclaimer)];
  });
}

export function renderAskLog(node, ask) {
  fill(node, { t: ask.turns, e: ask.error, h: ask.history }, () => {
    const out = [];
    if (ask.history === 'loading') out.push(muted('Loading your saved conversation…'));
    ask.turns.forEach((turn, i) => {
      out.push(
        h(
          'div',
          { class: 'live-turn' },
          h('p', { class: 'live-question' }, turn.question),
          turn.answer ? h('p', { class: 'live-answer' }, turn.answer) : null,
          turn.answer ? h('p', { class: 'meta' }, 'AI-GENERATED') : null,
          i === ask.turns.length - 1 ? fine(turn.disclaimer) : null,
        ),
      );
    });
    if (ask.error) out.push(error(ask.error));
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Supplementary NASA data, media and scenes                            */
/* ------------------------------------------------------------------ */

export function renderContext(node, context) {
  fill(node, sig(context), () => {
    if (!context || context.status === 'idle' || context.status === 'loading') return muted('Looking up datasets…');
    if (context.status === 'error') return error(context.message);
    const sources = context.data.sources || [];
    if (!sources.length) return muted('No supplementary datasets are stored for this event yet.');
    return [
      h(
        'ul',
        { class: 'live-list' },
        sources.map((s) =>
          h(
            'li',
            null,
            h('span', { class: 'live-list-name' }, s.name),
            h(
              'span',
              { class: 'meta' },
              s.ok
                ? `${s.total} ${s.measurementsRetrieved ? 'detections' : 'records'} · ${s.windowStart === s.windowEnd ? formatDay(s.windowStart) : `${formatDay(s.windowStart)} – ${formatDay(s.windowEnd)}`}`
                : 'unavailable right now',
            ),
          ),
        ),
      ),
      fine(`Most entries are catalog records showing which data exists, not measurements, and none of them is NISAR data. Updated ${formatDay(context.data.fetchedAt)}.`),
    ];
  });
}

export function renderMedia(node, media) {
  fill(node, sig(media), () => {
    if (!media || media.status === 'idle' || media.status === 'loading') return muted('Looking for pictures…');
    if (media.status === 'error') return error(media.message);
    const d = media.data;
    const images = d.images || [];
    const photos = d.photos || [];
    const links = d.links || [];
    if (!images.length && !photos.length && !links.length) return muted('No pictures are linked to this event.');
    const figure = (item) =>
      h(
        'a',
        { class: 'live-figure', href: item.page || item.url, target: '_blank', rel: 'noreferrer' },
        h('img', { src: item.url, alt: item.title, loading: 'lazy', referrerpolicy: 'no-referrer' }),
        h('span', { class: 'live-figure-title' }, item.title),
        h('span', { class: 'meta' }, `${item.credit || ''}${item.date ? ` · ${formatDay(item.date)}` : ''}`),
      );
    return [
      images.length ? h('p', { class: 'meta' }, 'USGS impact maps for this earthquake') : null,
      images.length ? h('div', { class: 'live-gallery' }, images.map(figure)) : null,
      photos.length ? h('p', { class: 'meta' }, `Related NASA photos (search: “${d.photoQuery}”) — may show earlier events`) : null,
      photos.length ? h('div', { class: 'live-gallery' }, photos.map(figure)) : null,
      links.length ? h('ul', { class: 'live-links' }, links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noreferrer' }, l.label)))) : null,
      fine(`${d.note || ''} ${d.credit || ''}`.trim()),
    ];
  });
}

export function renderScenes(node, detail, replay) {
  const scenes = replay ? replay.scenes : detail && detail.status === 'done' ? detail.data.scenes : [];
  fill(node, scenes.map((s) => `${s.id}:${s.status}`), () => {
    if (!scenes.length) return muted(detail && detail.status === 'loading' ? 'Loading…' : 'No scenes catalogued.');
    return [
      h(
        'table',
        { class: 'live-table' },
        h('thead', null, h('tr', null, h('th', null, 'Acquired'), h('th', null, 'Product'), h('th', null, 'Status'))),
        h(
          'tbody',
          null,
          scenes.map((s) => h('tr', null, h('td', null, formatDay(s.acquiredAt)), h('td', null, s.product || '—'), h('td', null, statusLabel(replay ? 'preview' : s.status)))),
        ),
      ),
      fine('NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC.'),
    ];
  });
}

/* ------------------------------------------------------------------ */
/* Area explorer                                                        */
/* ------------------------------------------------------------------ */

const DATASET_NAMES = {
  gpm: 'Rainfall (GPM IMERG)',
  smap: 'Soil moisture (SMAP)',
  hls: 'Optical imagery (Landsat/Sentinel-2)',
  terrain: 'Terrain (NASADEM)',
  grace: 'Water storage (GRACE)',
};

export function renderArea(node, { area, results, events, busy, notice, actionError, signedIn }) {
  const r = results || {};
  fill(node, { area: area && area.id, r: [sig(r.nisar), sig(r.quakes), sig(r.context)], n: (events || []).map((e) => e.id).join(','), busy, notice, actionError, signedIn }, () => {
    if (!area) return muted('Click anywhere on the map to explore that area.');
    const { nisar, quakes, context } = results;
    const out = [];

    out.push(h('h4', null, 'NISAR coverage in this period'));
    if (nisar.status === 'loading') out.push(muted('Searching ASF…'));
    if (nisar.status === 'error') out.push(error(nisar.message));
    if (nisar.status === 'done') {
      const d = nisar.data;
      const previewable = (d.scenes || []).filter((s) => s.browseUrl && s.bounds).length;
      out.push(
        h(
          'p',
          { class: 'live-text' },
          d.count === 0
            ? 'No NISAR scene covers this spot in that period.'
            : `${plural(d.count, 'scene')}${d.truncated ? ' (first results)' : ''} on ${plural(d.dates.length, 'date')}, latest ${formatDay(d.dates[d.dates.length - 1])}.`,
        ),
      );
      if (d.count > 0) {
        out.push(h('p', { class: 'meta' }, `${Object.entries(d.byProduct || {}).map(([p, n]) => `${p} ${n}`).join(' · ')}${d.polarizations && d.polarizations.length ? ` · ${d.polarizations.join('/')}` : ''}`));
      }
      out.push(
        h(
          'div',
          { class: 'live-row' },
          h('button', { type: 'button', 'data-action': 'track-area', disabled: d.count === 0 || busy !== '' || !signedIn }, busy === 'area' ? 'Starting…' : 'Track this area'),
          h('button', { type: 'button', 'data-action': 'replay-area', disabled: previewable === 0 || busy !== '' }, '▶ Replay these scenes'),
        ),
      );
      if (!signedIn && d.count > 0) out.push(h('p', { class: 'meta' }, 'Sign in to track this area.'));
    }

    const here = (events || []).filter((e) => contains(e.bbox, area.lng, area.lat));
    if (here.length) {
      out.push(h('h4', null, 'Tracked events here'));
      out.push(
        h(
          'ul',
          { class: 'live-list' },
          here.map((e) =>
            h('li', null, h('button', { type: 'button', class: 'live-item', 'data-action': 'open-event', 'data-id': e.id }, h('span', { class: 'live-list-name' }, e.name), h('span', { class: 'meta' }, `${e.type} · ${plural(e.sceneCount || 0, 'scene')}`))),
          ),
        ),
      );
    }

    out.push(h('h4', null, 'Earthquakes nearby (M4.5+) in this period'));
    if (quakes.status === 'loading') out.push(muted('Searching USGS…'));
    if (quakes.status === 'error') out.push(error(quakes.message));
    if (quakes.status === 'done') {
      const list = [...quakes.data.earthquakes].sort((a, b) => b.magnitude - a.magnitude).slice(0, 3);
      if (!list.length) out.push(muted('None found.'));
      else {
        out.push(
          h(
            'ul',
            { class: 'live-list' },
            list.map((q) =>
              h(
                'li',
                null,
                h('span', { class: 'live-list-name' }, `M ${q.magnitude.toFixed(1)} · ${q.place || q.title}`),
                h('span', { class: 'meta' }, `${formatDay(q.time)} · ${q.registered ? 'tracked' : 'not tracked'}`),
                h(
                  'div',
                  { class: 'live-row' },
                  q.registered
                    ? h('button', { type: 'button', 'data-action': 'open-event', 'data-id': q.suggested && q.suggested.eventId }, 'Open event')
                    : h('button', { type: 'button', 'data-action': 'track-quake', 'data-id': q.sourceId, disabled: busy !== '' || !signedIn }, busy === q.sourceId ? 'Starting…' : 'Track quake'),
                  h('button', { type: 'button', 'data-action': 'replay-quake', 'data-id': q.sourceId, disabled: busy !== '' }, busy === `replay-${q.sourceId}` ? 'Finding scenes…' : '▶ Replay'),
                ),
              ),
            ),
          ),
        );
      }
    }

    out.push(h('h4', null, 'Other NASA data'));
    if (context.status === 'loading') out.push(muted('Searching…'));
    if (context.status === 'error') out.push(error(context.message));
    if (context.status === 'done') {
      out.push(
        h(
          'ul',
          { class: 'live-list' },
          Object.entries(context.data.results || {}).map(([source, r]) =>
            h('li', null, h('span', { class: 'live-list-name' }, DATASET_NAMES[source] || source), h('span', { class: 'meta' }, r.ok ? `${r.result.total ?? r.result.count} records` : 'unavailable')),
          ),
        ),
      );
      out.push(fine('Most of these are catalog records showing what data exists, not measurements.'));
    }

    if (notice) out.push(h('p', { class: 'live-note' }, notice));
    if (actionError) out.push(error(actionError));
    out.push(fine('NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC. Earthquakes: USGS.'));
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Earthquake outlook (modelled)                                        */
/* ------------------------------------------------------------------ */

const shortDay = (iso) => formatDay(iso);

export function renderOutlook(node, outlook, selectedCell) {
  fill(node, { o: sig(outlook), c: selectedCell }, () => {
    if (!outlook || outlook.status === 'idle' || outlook.status === 'loading') return muted('Working out the outlook…');
    if (outlook.status === 'error') return error(outlook.message);
    const d = outlook.data;
    const min = d.basis.minMagnitude;
    const selected = d.cells.find((c) => c.id === selectedCell) || null;
    const out = [
      h('p', { class: 'meta' }, `WINDOW ${shortDay(d.window.start)} – ${shortDay(d.window.end)}`),
      h('p', { class: 'live-text' }, `Each hatched square is the modelled chance of at least one M${min}+ earthquake there in the next ${d.horizonDays} days, from ${d.basis.count} earthquakes in the past ${d.basis.lookbackDays} days.`),
    ];
    if (!d.cells.length) out.push(muted(`No M${min}+ earthquakes were recorded here in the past year, so there is nothing to project.`));
    if (selected) {
      out.push(
        h(
          'div',
          { class: 'live-callout' },
          h('strong', null, selected.label),
          h('span', null, `${percent(selected.probability)} modelled chance of M${min}+ · ${percent(selected.probabilityM6)} for M6+`),
          h('span', { class: 'meta' }, `${selected.count} in the past year, largest M${Number(selected.maxMagnitude).toFixed(1)}${selected.latest ? `; latest M${Number(selected.latest.magnitude).toFixed(1)} on ${shortDay(selected.latest.time)}` : ''}`),
        ),
      );
    }
    if (d.scenarios && d.scenarios.length) {
      out.push(h('h4', null, 'Possible future events (scenarios)'));
      out.push(
        h(
          'ul',
          { class: 'live-list' },
          d.scenarios.map((s) =>
            h(
              'li',
              null,
              h(
                'button',
                { type: 'button', class: 'live-item', 'data-cell': s.cellId, 'aria-pressed': s.cellId === selectedCell ? 'true' : 'false' },
                h('span', { class: 'level', 'data-level': s.likelihood === 'elevated' ? 'high' : s.likelihood === 'moderate' ? 'medium' : 'low' }, `${s.likelihood} · ${percent(s.probability)}`),
                h('span', { class: 'live-list-name' }, s.title),
                h('span', { class: 'live-text' }, s.summary),
                h('span', { class: 'meta' }, `${s.aiGenerated ? 'AI-worded scenario' : 'Computed summary'} · ${s.basis}`),
              ),
            ),
          ),
        ),
      );
    }
    if (d.cells.length) {
      out.push(h('h4', null, 'Most active cells'));
      out.push(
        h(
          'ul',
          { class: 'live-list' },
          d.cells.slice(0, 8).map((c) =>
            h('li', null, h('button', { type: 'button', class: 'live-item live-item-row', 'data-cell': c.id, 'aria-pressed': c.id === selectedCell ? 'true' : 'false' }, h('span', null, c.label), h('strong', null, percent(c.probability)))),
          ),
        ),
      );
    }
    out.push(fine(d.disclaimer));
    out.push(fine(`Method: ${d.method} Earthquake catalog: USGS.`));
    return out;
  });
}
