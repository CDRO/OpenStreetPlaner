import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsmRoadCache, OsmTransitCache, roadKindFromHighway, cellsFor, routeBounds, CELL_DEG, MAX_CELLS } from '../js/osm.js';

test('roadKindFromHighway ordnet gängige Tags zu', () => {
  assert.equal(roadKindFromHighway('primary'), 'main');
  assert.equal(roadKindFromHighway('tertiary'), 'secondary');
  assert.equal(roadKindFromHighway('residential'), 'residential');
  assert.equal(roadKindFromHighway('footway'), 'path');
  assert.equal(roadKindFromHighway('raceway'), 'other');
});

test('cellsFor deckt den Bereich mit festen Zellen ab', () => {
  const one = cellsFor({ south: 47.001, west: 8.001, north: 47.002, east: 8.002 });
  assert.equal(one.length, 1);
  assert.ok(one[0].bounds.south <= 47.001 && one[0].bounds.north >= 47.002);
  assert.ok(Math.abs(one[0].bounds.north - one[0].bounds.south - CELL_DEG) < 1e-12);
  const four = cellsFor({ south: 47.024, west: 8.024, north: 47.026, east: 8.026 });
  assert.equal(four.length, 4, 'Bereich über einer Zellgrenze in beide Richtungen');
  const r = routeBounds([47, 8], [47.3, 8.4]);
  assert.ok(r.cells > 100 && r.tooLarge, `zu grosse Route erkannt (${r.cells} Zellen)`);
  const small = routeBounds([47, 8], [47.01, 8.01]);
  assert.ok(!small.tooLarge && small.cells <= 4);
  assert.ok(MAX_CELLS >= 50);
});

test('OsmRoadCache lädt jede Zelle einmal, meldet Fortschritt und dedupliziert Ways', async () => {
  const calls = [];
  const cache = new OsmRoadCache(async (b) => {
    calls.push(b);
    return [{ id: 1, tags: { highway: 'primary' }, geometry: [[47, 8], [47, 8.001]] }, { id: 2, geometry: [[1, 1]] }];
  }, { delayMs: 0 });
  const states = [];
  cache.subscribe((s) => states.push(s.status));
  const bounds = { south: 47.001, west: 8.001, north: 47.002, east: 8.002 };
  assert.equal(cache.ensure(bounds, 15), false, 'unter Mindestzoom kein Laden');
  assert.equal(cache.ensure(bounds, 17), true);
  await cache.pending;
  assert.equal(calls.length, 1);
  assert.equal(cache.list().length, 1);
  assert.equal(cache.get(1).tags.highway, 'primary');
  cache.ensureArea({ south: 47.0015, west: 8.0015, north: 47.0018, east: 8.0018 });
  assert.equal(cache.pending, null, 'enthaltene Zelle wird nicht neu geladen');
  cache.ensureArea({ south: 47.024, west: 8.024, north: 47.026, east: 8.026 });
  await cache.pending;
  assert.equal(calls.length, 4, 'drei neue Zellen, die erste war schon geladen');
  assert.equal(cache.list().length, 1, 'gleiche Way-IDs werden nicht dupliziert');
  assert.equal(states[0], 'loading');
  assert.equal(states[states.length - 1], 'ready');
});

test('OsmRoadCache meldet Fehler und zu grosse Bereiche', async () => {
  const cache = new OsmRoadCache(async () => { throw new Error('kaputt'); }, { delayMs: 0 });
  const states = [];
  cache.subscribe((s) => states.push(s.status));
  cache.ensureArea({ south: 47.001, west: 8.001, north: 47.002, east: 8.002 });
  await cache.pending;
  assert.deepEqual(states, ['loading', 'error']);
  assert.equal(cache.lastError.message, 'kaputt');
  assert.equal(cache.ensureArea({ south: 40, west: 0, north: 50, east: 10 }), false);
  assert.ok(cache.lastError.message.includes('zu gross'));
});

test('OsmTransitCache sammelt Haltestellen und Linien je Zelle, sortiert Linien natürlich', async () => {
  let n = 0;
  const cache = new OsmTransitCache(async () => {
    n++;
    return {
      stops: [{ id: 1, name: 'Dorf', at: [47, 8], lines: ['12'] }, { id: 2, name: 'Post', at: [47, 8.01] }, { id: 'x', at: [1, 1] }],
      routes: [{ id: 100 + n, ref: n === 1 ? '12' : '7', name: 'Bus', stops: [{ id: 1, at: [47, 8] }, { id: 2, at: [47, 8.01] }] }, { id: 300, ref: 'A', stops: [] }, { id: 400, ref: 'A', stops: [{ id: 1, at: [47, 8] }, { id: 2, at: [47, 8.01] }] }],
    };
  }, { delayMs: 0 });
  cache.ensureArea({ south: 47.001, west: 8.001, north: 47.002, east: 8.002 });
  await cache.pending;
  assert.equal(cache.stopList().length, 2, 'ungültige Haltestelle verworfen');
  assert.equal(cache.ways.size, 2, 'Zähler zeigt Haltestellen');
  assert.deepEqual(cache.routeList().map((r) => r.ref), ['12', 'A']);
  cache.ensureArea({ south: 47.026, west: 8.026, north: 47.027, east: 8.027 });
  await cache.pending;
  assert.equal(n, 2);
  assert.deepEqual(cache.routeList().map((r) => r.ref), ['7', '12', 'A'], '7 vor 12, Buchstaben zuletzt');
  assert.equal(cache.stopList().length, 2, 'gleiche Knoten nicht doppelt');
});
