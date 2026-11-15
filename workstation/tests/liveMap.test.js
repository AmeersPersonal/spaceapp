import assert from 'node:assert/strict';
import test from 'node:test';
import { addLiveLayers, applyLiveMap } from '../js/liveMap.js';

function fakeMap() {
  const sources = new Map();
  const layers = new Map([['labels', { id: 'labels', type: 'symbol' }]]);
  const images = new Map();
  return {
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    getStyle: () => ({ layers: [...layers.values()] }),
    hasImage: (id) => images.has(id),
    addImage: (id, data) => images.set(id, data),
    addSource(id, data) {
      assert.equal(sources.has(id), false, `duplicate source ${id}`);
      sources.set(id, { ...data, setData(next) { this.data = next; } });
    },
    addLayer(layer, before) {
      assert.equal(layers.has(layer.id), false, `duplicate layer ${layer.id}`);
      if (before) assert.ok(layers.has(before), `missing insertion layer ${before}`);
      layers.set(layer.id, structuredClone(layer));
    },
    removeLayer: (id) => layers.delete(id),
    removeSource(id) {
      assert.equal([...layers.values()].some((layer) => layer.source === id), false, `source ${id} still in use`);
      sources.delete(id);
    },
    getLayoutProperty: (id, property) => layers.get(id)?.layout?.[property],
    setLayoutProperty(id, property, value) {
      const layer = layers.get(id);
      layer.layout ??= {};
      layer.layout[property] = value;
    },
    setPaintProperty: (id, property, value) => { layers.get(id).paint[property] = value; },
  };
}

function withOrigin(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { location: { origin: 'https://workstation.example.test' } };
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
}

test('processed tile templates retain XYZ placeholders and normal URL escaping', (t) => {
  withOrigin(t);
  const cases = [
    {
      url: '/tiles/event name/{z}/{x}/{y}/{metadata}.png?scene=a b&encoded=%2F',
      expected: 'https://workstation.example.test/tiles/event%20name/{z}/{x}/{y}/%7Bmetadata%7D.png?scene=a%20b&encoded=%2F',
    },
    {
      url: 'https://tiles.example.test/maps/é/{z}/{x}/{y}.png?scene=a b',
      expected: 'https://tiles.example.test/maps/%C3%A9/{z}/{x}/{y}.png?scene=a%20b',
    },
    {
      url: 'tiles/event/%7bz%7d/%7bx%7d/%7by%7d.png',
      expected: 'https://workstation.example.test/tiles/event/{z}/{x}/{y}.png',
    },
  ];
  for (const { url, expected } of cases) {
    const map = fakeMap();
    addLiveLayers(map);
    applyLiveMap(map, { active: true, tiles: { url, minZoom: 2, maxZoom: 10, bounds: [130, 32, 132, 34] } });
    const tiles = map.getSource('live-tiles');
    assert.deepEqual(tiles.tiles, [expected]);
    assert.equal(tiles.minzoom, 2);
    assert.equal(tiles.maxzoom, 10);
    assert.deepEqual(tiles.bounds, [130, 32, 132, 34]);
  }
});

test('live imagery keeps opacity and modelled styling through tile, preview and demo transitions', (t) => {
  withOrigin(t);
  const map = fakeMap();
  addLiveLayers(map);
  addLiveLayers(map);
  const view = {
    active: true,
    opacity: 0.6,
    aoi: [130, 32, 132, 34],
    outlookOn: true,
    cells: [{ id: 'cell', bbox: [130, 32, 131, 33], probability: 0.3 }],
    selectedCell: 'cell',
    tiles: { url: '/tiles/first/{z}/{x}/{y}.png' },
    images: [{ key: 'scene', url: 'blob:preview', coordinates: [[130, 34], [132, 34], [132, 32], [130, 32]], visible: true }],
  };
  applyLiveMap(map, view);
  const tiles = map.getSource('live-tiles');
  const preview = map.getSource('live-scene-1');
  applyLiveMap(map, view);
  assert.equal(map.getSource('live-tiles'), tiles);
  assert.equal(map.getSource('live-scene-1'), preview);
  assert.equal(map.getLayer('live-scene-2'), undefined);

  applyLiveMap(map, { ...view, opacity: 0.25 });
  assert.equal(map.getLayer('live-tiles').paint['raster-opacity'], 0.25);
  assert.equal(map.getLayer('live-scene-1').paint['raster-opacity'], 0.25);
  assert.equal(map.getLayer('live-outlook-fill').paint['fill-pattern'], 'live-hatch');
  assert.deepEqual(map.getLayer('live-outlook-line').paint['line-dasharray'], [2, 2]);
  assert.equal(map.getSource('live-outlook').data.features[0].properties.selected, true);

  applyLiveMap(map, { ...view, tiles: { url: '/tiles/second/{z}/{x}/{y}.png' } });
  assert.notEqual(map.getSource('live-tiles'), tiles);
  assert.equal(map.getSource('live-scene-1'), preview);
  applyLiveMap(map, { ...view, tiles: null });
  assert.equal(map.getLayer('live-tiles'), undefined);
  assert.equal(map.getSource('live-tiles'), undefined);
  assert.equal(map.getLayoutProperty('live-scene-1', 'visibility'), 'visible');

  applyLiveMap(map, { active: false });
  for (const id of ['live-scene-1', 'live-outlook-fill', 'live-outlook-line', 'live-aoi-line', 'live-probe-line']) {
    assert.equal(map.getLayoutProperty(id, 'visibility'), 'none');
  }
  applyLiveMap(map, { ...view, opacity: 0.4 });
  assert.equal(map.getSource('live-scene-1'), preview);
  assert.equal(map.getLayer('live-tiles').paint['raster-opacity'], 0.4);
  assert.equal(map.getLayer('live-scene-1').paint['raster-opacity'], 0.4);
  assert.equal(map.getLayoutProperty('live-outlook-fill', 'visibility'), 'visible');
});

test('changing the event releases its old preview sources', (t) => {
  withOrigin(t);
  const map = fakeMap();
  addLiveLayers(map);
  const coordinates = [[130, 34], [132, 34], [132, 32], [130, 32]];
  applyLiveMap(map, { active: true, images: [{ key: 'old', url: 'blob:old', coordinates, visible: true }] });
  applyLiveMap(map, { active: true, images: [{ key: 'new', url: 'blob:new', coordinates, visible: true }] });
  assert.equal(map.getLayer('live-scene-1'), undefined);
  assert.equal(map.getSource('live-scene-1'), undefined);
  assert.ok(map.getSource('live-scene-2'));
});

test('outlook horizon changes update probabilities even when the cell IDs stay the same', (t) => {
  withOrigin(t);
  const map = fakeMap();
  addLiveLayers(map);
  const view = { active: true, outlookOn: true, cells: [{ id: 'cell', bbox: [130, 32, 131, 33], probability: 0.1 }] };
  applyLiveMap(map, view);
  applyLiveMap(map, { ...view, cells: [{ ...view.cells[0], probability: 0.6 }] });
  assert.equal(map.getSource('live-outlook').data.features[0].properties.probability, 0.6);
});

test('refreshed tile bounds and zooms apply even with the same template URL', (t) => {
  withOrigin(t);
  const map = fakeMap();
  addLiveLayers(map);
  const tiles = { url: '/tiles/event/{z}/{x}/{y}.png', bounds: [130, 32, 131, 33], minZoom: 3, maxZoom: 8 };
  applyLiveMap(map, { active: true, tiles });
  applyLiveMap(map, { active: true, tiles: { ...tiles, bounds: [130, 32, 132, 34], maxZoom: 10 } });
  assert.deepEqual(map.getSource('live-tiles').bounds, [130, 32, 132, 34]);
  assert.equal(map.getSource('live-tiles').maxzoom, 10);
});
